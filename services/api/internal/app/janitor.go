package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const janitorBatch = 500

// Each task deletes one batch; it repeats until a batch comes back short, so every
// transaction stays small. Spend rows outlive the 30-day plan window by five days.
var janitorTasks = []struct{ name, sql string }{
	{"sessions", `DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<now() LIMIT 500)`},
	{"auth_nonces", `DELETE FROM auth_nonces WHERE hash IN (SELECT hash FROM auth_nonces WHERE expires_at<now() LIMIT 500)`},
	{"password_resets", `DELETE FROM password_resets WHERE user_id IN (SELECT user_id FROM password_resets WHERE expires_at<now() LIMIT 500)`},
	{"email_codes", `DELETE FROM email_codes WHERE (user_id,purpose) IN (SELECT user_id,purpose FROM email_codes WHERE expires_at<now() LIMIT 500)`},
	{"export_tokens", `DELETE FROM export_tokens WHERE token_hash IN (SELECT token_hash FROM export_tokens WHERE expires_at<now() LIMIT 500)`},
	// Jobs behind a conversation's media stay: dropping one would make the studio queue it again.
	{"ai_jobs", `DELETE FROM ai_jobs WHERE id IN (SELECT j.id FROM ai_jobs j WHERE j.status IN ('completed','failed') AND j.created_at<now()-interval '35 days'
 AND NOT EXISTS(SELECT 1 FROM voice_assets v WHERE v.job_id=j.id) LIMIT 500)`},
	{"narration_usage", `DELETE FROM narration_usage WHERE id IN (SELECT id FROM narration_usage WHERE created_at<now()-interval '35 days' LIMIT 500)`},
	{"ai_usage", `DELETE FROM ai_usage WHERE id IN (SELECT id FROM ai_usage WHERE created_at<now()-interval '35 days' LIMIT 500)`},
	// Cooking sessions that didn't become verified cooks count for nothing once their day is over,
	// except toward recipes' insights (cook_insights.go): those with step events stay for the
	// insights window, since where cooks stop is part of what a recipe shows its author.
	{"cook_sessions", `DELETE FROM cook_sessions WHERE id IN (SELECT id FROM cook_sessions WHERE NOT verified AND started_at<now()-interval '2 days'
 AND (events=0 OR started_at<now()-interval '180 days') LIMIT 500)`},
	// Step events of verified cooks outlive the window too; the cooks themselves stay.
	{"cook_step_events", `DELETE FROM cook_step_events WHERE (session_id,seq) IN (SELECT session_id,seq FROM cook_step_events WHERE created_at<now()-interval '180 days' LIMIT 500)`},
	// What cooks asked is kept 90 days; questions it was grouped into go once nobody asked them in
	// that time, unless their author answered them.
	{"cook_questions", `DELETE FROM cook_questions WHERE id IN (SELECT id FROM cook_questions WHERE created_at<now()-interval '90 days' LIMIT 500)`},
	{"recipe_step_questions", `DELETE FROM recipe_step_questions WHERE id IN (SELECT q.id FROM recipe_step_questions q WHERE q.answered_by='ai' AND q.updated_at<now()-interval '90 days'
 AND NOT EXISTS(SELECT 1 FROM cook_questions c WHERE c.cluster_id=q.id) LIMIT 500)`},
	// Suggestions their recipe's author never answered show as notes after 30 days (recipe_fixes.go),
	// and those declined or withdrawn go after a year.
	{"recipe_suggestions_stale", `UPDATE recipe_suggestions SET status='stale' WHERE id IN (SELECT id FROM recipe_suggestions WHERE status='open' AND created_at<now()-interval '30 days' LIMIT 500)`},
	{"recipe_suggestions", `DELETE FROM recipe_suggestions WHERE id IN (SELECT id FROM recipe_suggestions WHERE status IN ('declined','withdrawn') AND decided_at<now()-interval '1 year' LIMIT 500)`},
	// A pass a day: a year of them is plenty to look back on.
	{"cook_insight_runs", `DELETE FROM cook_insight_runs WHERE day IN (SELECT day FROM cook_insight_runs WHERE day<now()-interval '1 year' LIMIT 500)`},
	// Deleting a session cascades to its events and actions, the conversation the member still
	// sees, so only sessions that left neither go.
	{"voice_sessions", `DELETE FROM voice_sessions WHERE id IN (SELECT s.id FROM voice_sessions s WHERE s.finalized AND s.status NOT IN ('connecting','active') AND s.created_at<now()-interval '35 days'
 AND NOT EXISTS(SELECT 1 FROM voice_events e WHERE e.session_id=s.id) AND NOT EXISTS(SELECT 1 FROM voice_actions x WHERE x.session_id=s.id) LIMIT 500)`},
	// A trigger queues each stored recording for removal from the private bucket.
	{"recipe_narrations", `DELETE FROM recipe_narrations WHERE cache_key IN (SELECT cache_key FROM recipe_narrations WHERE last_used_at<now()-interval '60 days' LIMIT 500)`},
	// Translations nobody read for 90 days (translations.go); the next reader has one made again.
	{"recipe_translations", `DELETE FROM recipe_translations WHERE (recipe_id,language) IN (SELECT recipe_id,language FROM recipe_translations WHERE last_used_at<now()-interval '90 days' LIMIT 500)`},
	// Product analytics are kept 90 days (events.go).
	{"events", `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at<now()-interval '90 days' LIMIT 500)`},
	// Push messages carry names and review text: a week, for support. Sent outbox rows keep no
	// text, only what happened, past the one-a-day and one-an-hour limits on review and comment
	// notices; deleting one deletes its messages.
	{"push_messages", `DELETE FROM push_messages WHERE id IN (SELECT id FROM push_messages WHERE created_at<now()-interval '7 days' LIMIT 500)`},
	{"notification_outbox", `DELETE FROM notification_outbox WHERE id IN (SELECT id FROM notification_outbox WHERE created_at<now()-interval '7 days' LIMIT 500)`},
	{"household_invites", `DELETE FROM household_invites WHERE code_hash IN (SELECT code_hash FROM household_invites WHERE expires_at<now() LIMIT 500)`},
	// The leaving trigger keeps households whole; these repair one that two members left at the
	// same moment, so neither saw the other go.
	{"households", `DELETE FROM households WHERE id IN (SELECT h.id FROM households h WHERE NOT EXISTS (SELECT 1 FROM household_members m WHERE m.household_id=h.id) LIMIT 500)`},
	{"household_owners", `UPDATE household_members SET role='owner' WHERE user_id IN (SELECT DISTINCT ON (m.household_id) m.user_id FROM household_members m
 WHERE NOT EXISTS (SELECT 1 FROM household_members o WHERE o.household_id=m.household_id AND o.role='owner') ORDER BY m.household_id,m.joined_at,m.user_id LIMIT 500)`},
}

// RunJanitor purges what nobody can see any more: soon after start, since a container may
// sleep before an hour passes, then hourly.
func RunJanitor(ctx context.Context, db *pgxpool.Pool) {
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if _, e := runJanitor(ctx, db); e != nil && ctx.Err() == nil {
				slog.Error("janitor", "error", e)
			}
			timer.Reset(time.Hour)
		}
	}
}

// runJanitor does one pass and reports what it deleted, or nil when another replica holds the
// lock. The session lock lives on one pooled connection, released when the pass ends.
func runJanitor(ctx context.Context, db *pgxpool.Pool) (map[string]int64, error) {
	conn, e := db.Acquire(ctx)
	if e != nil {
		return nil, e
	}
	defer conn.Release()
	var locked bool
	if e = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(7182305)`).Scan(&locked); e != nil || !locked {
		return nil, e
	}
	defer func() {
		if _, e := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(7182305)`); e != nil {
			conn.Conn().Close(context.Background())
		}
	}()
	counts := map[string]int64{}
	logged := []any{}
	for _, task := range janitorTasks {
		for {
			tag, e := conn.Exec(ctx, task.sql)
			if e != nil {
				return counts, fmt.Errorf("%s: %w", task.name, e)
			}
			counts[task.name] += tag.RowsAffected()
			if tag.RowsAffected() < janitorBatch {
				break
			}
		}
		if counts[task.name] > 0 {
			logged = append(logged, task.name, counts[task.name])
		}
	}
	// Files in storage go last, after the purges above queued theirs (media_cleanup.go).
	deleted, e := cleanMedia(ctx, conn, NewMediaStore())
	counts["media"] = deleted
	if deleted > 0 {
		logged = append(logged, "media", deleted)
	}
	if e != nil {
		return counts, fmt.Errorf("media: %w", e)
	}
	if len(logged) > 0 {
		slog.Info("janitor purged", logged...)
	}
	return counts, nil
}

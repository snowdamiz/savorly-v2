package app

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// The weekly cook-along (docs/CREATOR-FUND.md): one recipe a week, Monday to Sunday in UTC, so
// many members cook the same thing in the same week. Home shows it (GET /feed), a push
// notification announces it once, and founding creators take turns in the slot. Admins schedule
// or change weeks in the console (admin_cook_along.go); a week nobody scheduled goes to the next
// founding creator in the rotation when it starts.

// currentWeekSQL is the Monday this UTC week started on.
const currentWeekSQL = `date_trunc('week',now() AT TIME ZONE 'UTC')::date`

// cookAlongCountsSQL are, for cook-along k, its recipe's verified cooks in its week and how many
// members started cooking it then, by the week's UTC days.
const cookAlongCountsSQL = `'cooks',(SELECT count(*) FROM cook_sessions s WHERE s.recipe_id=k.recipe_id AND s.verified
   AND s.finished_at>=k.week::timestamp AT TIME ZONE 'UTC' AND s.finished_at<(k.week+7)::timestamp AT TIME ZONE 'UTC'),
 'started',(SELECT count(DISTINCT s.user_id) FROM cook_sessions s WHERE s.recipe_id=k.recipe_id
   AND s.started_at>=k.week::timestamp AT TIME ZONE 'UTC' AND s.started_at<(k.week+7)::timestamp AT TIME ZONE 'UTC')`

// cookAlongJSON is this week's cook-along as Home shows it: the recipe while it's public and its
// author in good standing, with this week's counts; null otherwise. GET /feed carries it, so the
// card arrives with the rest of Home and never moves it after it's drawn.
const cookAlongJSON = `(SELECT jsonb_build_object('week',k.week,'recipe',` + recipeJSON + `,` + cookAlongCountsSQL + `)
 FROM cook_alongs k JOIN recipes r ON r.id=k.recipe_id AND r.published JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL
 WHERE k.week=` + currentWeekSQL + `)`

// cookAlongWeek is the Monday (UTC) of t's week.
func cookAlongWeek(t time.Time) time.Time {
	t = t.UTC()
	day := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	return day.AddDate(0, 0, -((int(day.Weekday()) + 6) % 7))
}

// rotationFrom and rotationWhere read the founding creators in good standing (alias u), each with
// their latest week (f.last); rotationOrder is the order their turns come in: never featured
// first, then featured longest ago (a week scheduled ahead counts as theirs already), then by when
// they were marked.
const (
	rotationFrom  = ` FROM users u CROSS JOIN LATERAL (SELECT max(week) AS last FROM cook_alongs WHERE creator_id=u.id) f`
	rotationWhere = ` WHERE u.founding_creator_at IS NOT NULL AND u.suspended_at IS NULL`
	rotationOrder = `f.last NULLS FIRST,u.founding_creator_at,u.id`
)

// turnRecipesSQL are founding creator u's public recipes in the order the rotation offers them
// (turnOrder): the most saved that hasn't been a cook-along yet, then the rest by saves, so a
// creator's turns spread over their recipes. featured is a recipe's latest week as the cook-along.
const (
	turnRecipesSQL = `SELECT * FROM (SELECT r.id,r.title,r.image,r.created_at,(SELECT count(*) FROM saves WHERE recipe_id=r.id) AS saves,
 (SELECT max(week) FROM cook_alongs WHERE recipe_id=r.id) AS featured FROM recipes r WHERE r.author_id=u.id AND r.published) t
 ORDER BY ` + turnOrder
	turnOrder = `featured IS NOT NULL,saves DESC,created_at DESC,id`
)

// fillCookAlongSQL gives this week to the rotation when it has no public recipe: nobody scheduled
// it, or what was scheduled has since been deleted, unpublished or its author suspended. It takes
// the first founding creator with a public recipe, and that recipe. A week an admin scheduled
// with a public recipe is never touched, and a second replica finds the week filled.
const fillCookAlongSQL = `WITH pick AS (SELECT x.id,u.id AS creator` + rotationFrom + `
 CROSS JOIN LATERAL (` + turnRecipesSQL + ` LIMIT 1) x` + rotationWhere + ` ORDER BY ` + rotationOrder + ` LIMIT 1)
INSERT INTO cook_alongs(week,recipe_id,creator_id,automatic) SELECT ` + currentWeekSQL + `,id,creator,true FROM pick
ON CONFLICT (week) DO UPDATE SET recipe_id=excluded.recipe_id,creator_id=excluded.creator_id,scheduled_by=NULL,automatic=true,updated_at=now()
 WHERE NOT EXISTS(SELECT 1 FROM recipes r JOIN users a ON a.id=r.author_id AND a.suspended_at IS NULL WHERE r.id=cook_alongs.recipe_id AND r.published)`

// cookAlongHour is the UTC hour of the week's Monday from which its cook-along is announced, as
// for the pantry: mid-morning in the Americas, afternoon in Europe, evening in Asia.
var cookAlongHour = 12

// cookAlongPass fills this week from the rotation if it needs it (fillCookAlongSQL), then
// announces the week's cook-along once: from cookAlongHour on its Monday, or as soon as one is
// scheduled later in the week. Claiming the week in notification_runs is what makes it once,
// across replicas and however often the week's recipe changes. Nothing is claimed while the week
// has no public recipe. It reports whether it queued the notice.
func (n *notifier) cookAlongPass(ctx context.Context) (bool, error) {
	if _, e := n.db.Exec(ctx, fillCookAlongSQL); e != nil {
		return false, e
	}
	tx, e := n.db.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(ctx)
	var week time.Time
	var recipe, author string
	e = tx.QueryRow(ctx, `SELECT k.week,k.recipe_id,r.author_id FROM cook_alongs k JOIN recipes r ON r.id=k.recipe_id AND r.published
 JOIN users u ON u.id=r.author_id AND u.suspended_at IS NULL
 WHERE k.week=`+currentWeekSQL+` AND now()>=(k.week::timestamp AT TIME ZONE 'UTC')+make_interval(hours=>$1)`, cookAlongHour).Scan(&week, &recipe, &author)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	claimed, e := tx.Exec(ctx, `INSERT INTO notification_runs(name,ran_on) VALUES('cookalong',$1)
 ON CONFLICT (name) DO UPDATE SET ran_on=excluded.ran_on WHERE notification_runs.ran_on<excluded.ran_on`, week)
	if e != nil || claimed.RowsAffected() == 0 {
		return false, e
	}
	// The author is the actor, so they aren't told about their own recipe.
	if _, e = tx.Exec(ctx, `INSERT INTO notification_outbox(kind,actor_id,recipe_id,ref_id) VALUES('cookalong',$1,$2,$3)`, author, recipe, week.Format(time.DateOnly)); e != nil {
		return false, e
	}
	return true, tx.Commit(ctx)
}

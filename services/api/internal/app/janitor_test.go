package app

import (
	"context"
	"slices"
	"testing"
)

func TestJanitorPurgesOnlyWhatNobodySees(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "reset")
	testUser(t, db, "resetting")
	publishRecipe(t, db, "cook", "soup", nil)
	_, err := db.Exec(ctx, `
 INSERT INTO sessions(token_hash,user_id,expires_at) SELECT 'expired-'||n,'cook',now()-interval '1 minute' FROM generate_series(1,1203) n;
 INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('live','cook',now()+interval '1 day');
 INSERT INTO auth_nonces(hash,expires_at) VALUES('old-nonce',now()-interval '1 minute'),('new-nonce',now()+interval '5 minutes');
 INSERT INTO password_resets(user_id,code_hash,expires_at) VALUES('reset','x',now()-interval '1 minute'),('resetting','y',now()+interval '10 minutes');
 INSERT INTO ai_jobs(id,user_id,kind,prompt,status,request_key,created_at) VALUES
  ('old-done','cook','recipe','p','completed','k1',now()-interval '40 days'),
  ('old-failed','cook','image','p','failed','k2',now()-interval '40 days'),
  ('old-running','cook','video','p','processing','k3',now()-interval '40 days'),
  ('recent-done','cook','recipe','p','completed','k4',now()-interval '20 days'),
  ('old-media','cook','image','p','completed','k5',now()-interval '40 days');
 INSERT INTO narration_usage(cache_key,user_id,estimated_cost,created_at) VALUES('a','cook',0.01,now()-interval '40 days'),('b','cook',0.01,now()-interval '20 days');
 INSERT INTO voice_projects(id,user_id) VALUES('project','cook');
 INSERT INTO voice_assets(project_id,revision,kind,job_id) VALUES('project',0,'image','old-media');
 INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,finalized,created_at,expires_at) VALUES
  ('silent','project','cook','closed',60,true,now()-interval '40 days',now()),
  ('talked','project','cook','closed',60,true,now()-interval '40 days',now()),
  ('acted','project','cook','closed',60,true,now()-interval '40 days',now()),
  ('unsettled','project','cook','interrupted',60,false,now()-interval '40 days',now()),
  ('recent','project','cook','closed',60,true,now()-interval '20 days',now());
 INSERT INTO voice_events(project_id,session_id,event_id,role,content) VALUES('project','talked','e1','user','Make me soup');
 INSERT INTO voice_actions(id,project_id,session_id,delegation_id) VALUES('action','project','acted','d1');
 INSERT INTO recipe_narrations(cache_key,recipe_id,object_key,size,last_used_at) VALUES('stale-object','soup','narration/stale.mp3',10,now()-interval '70 days');
 INSERT INTO recipe_narrations(cache_key,recipe_id,audio,last_used_at) VALUES('stale-bytes','soup','\x01',now()-interval '70 days'),('played','soup','\x01',now()-interval '50 days')`)
	if err != nil {
		t.Fatal(err)
	}
	ids := func(query string) []string {
		t.Helper()
		var out []string
		if err := db.QueryRow(ctx, `SELECT COALESCE(array_agg(x ORDER BY x),'{}') FROM (`+query+`) q(x)`).Scan(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	// Another replica holds the lock: this one skips the pass.
	held, err := db.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = held.Exec(ctx, `SELECT pg_advisory_lock(7182305)`); err != nil {
		t.Fatal(err)
	}
	if counts, err := runJanitor(ctx, db); err != nil || counts != nil {
		t.Fatalf("ran beside another replica: %v %v", counts, err)
	}
	if _, err = held.Exec(ctx, `SELECT pg_advisory_unlock(7182305)`); err != nil {
		t.Fatal(err)
	}
	held.Release()
	counts, err := runJanitor(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int64{"sessions": 1203, "auth_nonces": 1, "password_resets": 1, "ai_jobs": 2, "narration_usage": 1, "voice_sessions": 1, "recipe_narrations": 2}
	for task, n := range want {
		if counts[task] != n {
			t.Errorf("%s: purged %d, want %d", task, counts[task], n)
		}
	}
	for query, want := range map[string][]string{
		`SELECT token_hash FROM sessions`:         {"live"},
		`SELECT hash FROM auth_nonces`:            {"new-nonce"},
		`SELECT user_id FROM password_resets`:     {"resetting"},
		`SELECT id FROM ai_jobs`:                  {"old-media", "old-running", "recent-done"},
		`SELECT cache_key FROM narration_usage`:   {"b"},
		`SELECT id FROM voice_sessions`:           {"acted", "recent", "talked", "unsettled"},
		`SELECT cache_key FROM recipe_narrations`: {"played"},
		`SELECT object_key FROM source_deletions`: {"narration/stale.mp3"},
		`SELECT content FROM voice_events`:        {"Make me soup"},
		`SELECT job_id FROM voice_assets`:         {"old-media"},
	} {
		if got := ids(query); !slices.Equal(got, want) {
			t.Errorf("%s: %v, want %v", query, got, want)
		}
	}
	if counts, err := runJanitor(ctx, db); err != nil || counts["sessions"] != 0 {
		t.Fatalf("second pass: %v %v", counts, err)
	}
}

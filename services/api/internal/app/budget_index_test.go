package app

import (
	"context"
	"testing"
)

func TestBudgetSumsUseCreatedAtIndexes(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	// Ninety days of spend from a few hundred members, so a day is about one percent of it.
	_, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle) SELECT 'u'||n,'u'||n||'@example.test','!','Cook','u'||n FROM generate_series(1,300) n;
 INSERT INTO ai_jobs(id,user_id,kind,prompt,status,request_key,estimated_cost,created_at)
  SELECT 'j'||n,'u'||(n%300+1),'recipe','p','completed','k'||n,0.01,now()-(n%90)*interval '1 day'-(n%24)*interval '1 hour' FROM generate_series(1,30000) n;
 INSERT INTO narration_usage(cache_key,user_id,estimated_cost,created_at)
  SELECT 'c'||n,'u'||(n%300+1),0.001,now()-(n%90)*interval '1 day' FROM generate_series(1,20000) n;
 INSERT INTO voice_projects(id,user_id) SELECT 'p'||n,'u'||n FROM generate_series(1,300) n;
 INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,finalized,seconds,created_at,expires_at)
  SELECT 's'||n,'p'||(n%300+1),'u'||(n%300+1),'closed',60,true,30,now()-(n%90)*interval '1 day',now() FROM generate_series(1,20000) n;
 INSERT INTO voice_actions(id,project_id,session_id,delegation_id,status,created_at)
  SELECT 'a'||n,'p'||(n%300+1),'s'||n,'d','completed',now()-(n%90)*interval '1 day' FROM generate_series(1,20000) n;
 ANALYZE users; ANALYZE ai_jobs; ANALYZE narration_usage; ANALYZE voice_projects; ANALYZE voice_sessions; ANALYZE voice_actions;`)
	if err != nil {
		t.Fatal(err)
	}
	found, plan := planIndexes(t, db, budgetSumsSQL, []string{"u7"})
	for _, index := range []string{"ai_jobs_created", "voice_actions_created", "narration_usage_created", "voice_sessions_created", "ai_jobs_user_created", "narration_usage_user_created", "voice_sessions_user_created"} {
		if !found[index] {
			t.Errorf("budget sums don't use %s", index)
		}
	}
	t.Logf("budget sums:\n%s", plan)
	var mine, free, total float64
	if err := db.QueryRow(ctx, budgetSumsSQL, []string{"u7"}).Scan(&mine, &free, &total); err != nil || mine <= 0 || total <= 0 || free != total {
		t.Fatalf("sums %v %v %v: %v", mine, free, total, err)
	}
}

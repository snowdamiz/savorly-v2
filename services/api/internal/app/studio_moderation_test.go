package app

import (
	"context"
	"strings"
	"testing"
)

// A recipe an admin took down stays private when its author asks the sous-chef to publish it,
// and the sous-chef hears why instead of the turn failing.
func TestStudioPublishRespectsModerationHold(t *testing.T) {
	a, p := studioFixture(t)
	ctx := context.Background()
	state, _ := a.studioState(ctx, p, 0)
	r := exampleVoiceRecipe()
	if _, e := a.applyDraftAction(ctx, state, "build", &r, false); e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	if _, e := a.DB.Exec(ctx, `UPDATE recipes SET unpublished_by_admin_at=now(),unpublished_by='admin@example.test' WHERE id=$1`, state.RecipeID); e != nil {
		t.Fatal(e)
	}
	// The read-back, then a fresh yes from the user in the conversation's text session.
	if _, e := a.DB.Exec(ctx, `INSERT INTO voice_sessions(id,project_id,user_id,status,reserved_seconds,seconds,finalized,expires_at) SELECT $1,id,user_id,'closed',0,0,true,now() FROM voice_projects WHERE id=$2 ON CONFLICT DO NOTHING`, "chat_"+p, p); e != nil {
		t.Fatal(e)
	}
	if _, e := a.applyDraftAction(ctx, state, "publish", nil, false); e != nil {
		t.Fatal(e)
	}
	asked(t, a, p, "Here's the draft. Shall I publish this version?")
	if _, e := a.DB.Exec(ctx, `INSERT INTO voice_events(project_id,session_id,event_id,role,content) VALUES($1,$2,'confirmation','user','Yes, publish it.')`, p, "chat_"+p); e != nil {
		t.Fatal(e)
	}
	state, _ = a.studioState(ctx, p, 0)
	reply, e := a.applyDraftAction(ctx, state, "publish", nil, false)
	if e != nil {
		t.Fatalf("a held publish failed the turn: %v", e)
	}
	if !strings.Contains(reply, "can't be published") {
		t.Fatalf("the sous-chef wasn't told about the hold: %q", reply)
	}
	state, _ = a.studioState(ctx, p, 0)
	if state.Recipe.Published || state.Status == "published" {
		t.Fatal("a held recipe was published through the sous-chef")
	}
}

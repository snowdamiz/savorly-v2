package app

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// Comments follow reviews' rank rule: an appointed admin can't remove what an owner or another
// admin wrote, but can remove their own; owners remove anything. Every removal is audited.
func TestAdminCommentDeletionFollowsTheRankRule(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	ctx := context.Background()
	f := adminApp(db, true)
	ownerID, owner := signedIn(t, db, "owner@example.test", true)
	adminID, admin := signedIn(t, db, "admin@example.test", false)
	peerID, _ := signedIn(t, db, "peer@example.test", false)
	cookID, cook := signedIn(t, db, "cook@example.test", false)
	makeAdmins(t, db, adminID, peerID)
	recipe := testRecipe(t, db, cookID, "Soup to talk about", true)
	comment := func(by, parent string) string {
		t.Helper()
		id := uuid.NewString()
		var reply any
		if parent != "" {
			reply = parent
		}
		if _, e := db.Exec(ctx, `INSERT INTO comments(id,recipe_id,user_id,parent_id,body) VALUES($1,$2,$3,$4,'A comment worth a look')`, id, recipe, by, reply); e != nil {
			t.Fatal(e)
		}
		return id
	}
	path := func(id string) string { return "/v1/admin/comments/" + id }
	members, owners, peers, admins := comment(cookID, ""), comment(ownerID, ""), comment(peerID, ""), comment(adminID, "")
	reply := comment(peerID, members)

	expect(t, f, 403, "DELETE", path(members), cook, nil)
	expect(t, f, 403, "DELETE", path(owners), admin, nil)
	expect(t, f, 403, "DELETE", path(peers), admin, nil)
	expect(t, f, 204, "DELETE", path(members), admin, nil)
	if n := count(t, db, `SELECT count(*) FROM comments WHERE id=ANY($1)`, []string{members, reply}); n != 0 {
		t.Fatalf("%d of the comment and its reply remain", n)
	}
	detail := auditDetail(t, db, "comment.delete", members)
	if detail["body"] != "A comment worth a look" || detail["recipeId"] != recipe || detail["replies"] != float64(1) {
		t.Fatalf("audit detail: %v", detail)
	}
	var summary string
	if e := db.QueryRow(ctx, `SELECT summary FROM admin_actions WHERE target_type='comment' AND target_id=$1`, members).Scan(&summary); e != nil || !strings.Contains(summary, "cook@example.test") || !strings.Contains(summary, "Soup to talk about") {
		t.Fatalf("audit summary: %q %v", summary, e)
	}
	expect(t, f, 204, "DELETE", path(admins), admin, nil)
	expect(t, f, 204, "DELETE", path(owners), owner, nil)
	expect(t, f, 204, "DELETE", path(peers), owner, nil)
	expect(t, f, 404, "DELETE", path(members), owner, nil)
	if got := auditActions(t, db); got != "comment.delete,comment.delete,comment.delete,comment.delete" {
		t.Fatalf("audit: %s", got)
	}
}

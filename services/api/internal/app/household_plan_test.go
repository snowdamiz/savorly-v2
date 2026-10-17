package app

import (
	"context"
	"slices"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func TestAPlanCoversTheHousehold(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	t.Setenv("PAID_PLANS", "true")
	for _, u := range []string{"ana", "ben", "cleo", "dan"} {
		namedUser(t, db, u, string(u[0]-32)+u[1:])
	}
	paid := func(id, plan string) {
		t.Helper()
		if _, e := db.Exec(ctx, `UPDATE users SET plan=$2,plan_status='active',plan_interval='monthly' WHERE id=$1`, id, plan); e != nil {
			t.Fatal(e)
		}
	}
	f := recipesApp(db, false)
	ana, ben, cleo := bearerFor(t, db, "ana"), bearerFor(t, db, "ben"), bearerFor(t, db, "cleo")
	pool := func(id string) planPool {
		t.Helper()
		p, e := poolOf(ctx, db, id)
		if e != nil {
			t.Fatal(e)
		}
		slices.Sort(p.Members)
		return p
	}
	paid("ana", "plus")
	// Alone, each is on their own plan.
	if p := pool("ben"); p.Plan.ID != "free" || !slices.Equal(p.Members, []string{"ben"}) {
		t.Fatalf("Ben alone: %+v", p)
	}
	// Ben joins Ana's household and is on her Plus, sharing its allowances.
	mustCall(t, f, 201, "POST", "/v1/household", ana, fiber.Map{"name": "Home"})
	mustCall(t, f, 200, "POST", "/v1/household/join", ben, fiber.Map{"code": inviteCode(t, f, ana)})
	if p := pool("ben"); p.Plan.ID != "plus" || p.SharedBy != "ana" || !slices.Equal(p.Members, []string{"ana", "ben"}) {
		t.Fatalf("Ben in Ana's household: %+v", p)
	}
	if p := pool("ana"); p.Plan.ID != "plus" || p.SharedBy != "" || !slices.Equal(p.Members, []string{"ana", "ben"}) {
		t.Fatalf("Ana shares: %+v", p)
	}
	if plan := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/me", ben, nil))["plan"]; plan != "plus" {
		t.Fatalf("Ben's profile plan %v", plan)
	}
	// What one uses counts for both: Ben's photos come out of the same six.
	if _, e := db.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,status,request_key,estimated_cost) SELECT 'j'||n,CASE WHEN n<=3 THEN 'ana' ELSE 'ben' END,'image','p','completed','k'||n,0.05 FROM generate_series(1,6) n`); e != nil {
		t.Fatal(e)
	}
	if e := allowance(ctx, db, "ben", "image"); e == nil {
		t.Fatal("Ben made a seventh photo on a shared Plus")
	}
	billing := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/billing", ben, nil))
	if billing["plan"] != "plus" || billing["sharedBy"].(map[string]any)["name"] != "Ana" || billing["usage"].(map[string]any)["images"] != float64(6) {
		t.Fatalf("Ben's billing %v", billing)
	}
	if mine := jsonObject(t, mustCall(t, f, 200, "GET", "/v1/billing", ana, nil)); mine["sharedWith"] != float64(1) || mine["sharedBy"] != nil {
		t.Fatalf("Ana's billing %v", mine)
	}
	// The best plan in the household covers it; a member with a lesser plan keeps their own.
	mustCall(t, f, 200, "POST", "/v1/household/join", cleo, fiber.Map{"code": inviteCode(t, f, ana)})
	paid("cleo", "pro")
	if p := pool("ben"); p.Plan.ID != "pro" || p.SharedBy != "cleo" || !slices.Equal(p.Members, []string{"ben", "cleo"}) {
		t.Fatalf("Ben under Cleo's Pro: %+v", p)
	}
	if p := pool("ana"); p.Plan.ID != "plus" || !slices.Equal(p.Members, []string{"ana"}) {
		t.Fatalf("Ana keeps her Plus: %+v", p)
	}
	// Leaving takes the member off it.
	mustCall(t, f, 204, "DELETE", "/v1/household/members/ben", ben, nil)
	if p := pool("ben"); p.Plan.ID != "free" || p.SharedBy != "" {
		t.Fatalf("Ben after leaving: %+v", p)
	}
	// A suspended member's plan covers nobody.
	mustCall(t, f, 200, "POST", "/v1/household/join", ben, fiber.Map{"code": inviteCode(t, f, ana)})
	suspend(t, db, "cleo", true)
	if p := pool("ben"); p.Plan.ID != "plus" || p.SharedBy != "ana" {
		t.Fatalf("Ben while Cleo is suspended: %+v", p)
	}
}

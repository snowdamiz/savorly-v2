package app

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestFundFlagsFindMembersWhoCookOnlyOneCreator(t *testing.T) {
	rows := []fundCook{
		{member: "ring1", creator: "x", cooks: 4, net: 859},
		{member: "ring2", creator: "x", cooks: 5, net: 859},
		{member: "ring3", creator: "x", cooks: 4, net: 1749},
		{member: "fan", creator: "x", cooks: 3, net: 859},     // too few to mean anything
		{member: "free", creator: "x", cooks: 9, net: 0},      // sends nothing
		{member: "varied", creator: "x", cooks: 4, net: 1749}, // two creators
		{member: "varied", creator: "y", cooks: 1, net: 1749},
		{member: "loyal", creator: "y", cooks: 4, net: 859},
		{member: "big", creator: "y", cooks: 2, net: 1749},
	}
	shares, _, _, _ := splitFund(rows, 2000)
	members, creators := fundFlags(rows, shares, 2000)
	got := []string{}
	for _, m := range members {
		got = append(got, fmt.Sprintf("%s>%s:%d/%d", m.member, m.creator, m.cooks, m.cents))
	}
	if want := "[ring3>x:4/349 ring2>x:5/171 loyal>y:4/171 ring1>x:4/171]"; fmt.Sprint(got) != want {
		t.Fatalf("members %v, want %s", got, want)
	}
	// x gets most of its money from flagged members; y doesn't.
	if len(creators) != 1 || creators[0].creator != "x" || creators[0].flagged != 691 || creators[0].members != 3 || creators[0].cents != shares["x"].cents {
		t.Fatalf("creators %+v", creators)
	}
}

func TestFirstPayoutWaitsSixtyDays(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	stripe := newFakeConnect(t)
	f := adminApp(db, false)
	ctx := context.Background()
	_, owner := signedIn(t, db, "owner@example.test", true)
	newID, newcomer := signedIn(t, db, "new@example.test", true)
	testUser(t, db, "old")
	august, september := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	// September closed ten days ago. It's the newcomer's first month; the other creator was first
	// paid for August, long ago.
	if _, e := db.Exec(ctx, `INSERT INTO creator_fund_months(month,share_bp,computed_at) VALUES($1,2000,now()-interval '10 days')`, september); e != nil {
		t.Fatal(e)
	}
	earning(t, db, "old", august, 1500)
	earning(t, db, "old", september, 1500)
	earning(t, db, newID, september, 2500)
	payoutAccount(t, db, stripe, "old", "acct_old")
	payoutAccount(t, db, stripe, newID, "acct_new")
	if paid, e := runPayouts(ctx, db); e != nil || paid != 1 || stripe.count("POST /transfers") != 1 {
		t.Fatalf("first run: %d paid, %v", paid, e)
	}
	waiting := func(when string) {
		t.Helper()
		var due time.Time
		if e := db.QueryRow(ctx, `SELECT computed_at+interval '60 days' FROM creator_fund_months WHERE month=$1`, september).Scan(&due); e != nil {
			t.Fatal(e)
		}
		for _, x := range []struct{ path, tok string }{{"/v1/me/earnings", newcomer}, {"/v1/admin/users/" + newID + "/earnings", owner}} {
			at, _ := expect(t, f, 200, "GET", x.path, x.tok, nil)["firstPayoutAt"].(string)
			parsed, _ := time.Parse(time.RFC3339Nano, at)
			if when == "waiting" && !parsed.Equal(due) || when == "due" && at != "" {
				t.Errorf("%s %s: firstPayoutAt %q, due %v", when, x.path, at, due)
			}
		}
	}
	waiting("waiting")
	if fund := expect(t, f, 200, "GET", "/v1/admin/fund", owner, nil); fund["firstPayoutsWaiting"] != 1.0 {
		t.Fatalf("fund: %v", fund["firstPayoutsWaiting"])
	}
	// Sixty days after the month closed, the first payout goes, and later ones don't wait.
	if _, e := db.Exec(ctx, `UPDATE creator_fund_months SET computed_at=now()-interval '61 days' WHERE month=$1`, september); e != nil {
		t.Fatal(e)
	}
	waiting("due")
	if paid, e := runPayouts(ctx, db); e != nil || paid != 1 {
		t.Fatalf("after sixty days: %d paid, %v", paid, e)
	}
	if n := count(t, db, `SELECT count(*) FROM creator_earnings WHERE status='paid'`); n != 3 {
		t.Fatalf("%d earnings paid", n)
	}
}

func TestFundWeeklyReportAddsUpToItsMonths(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	for _, id := range []string{"x", "y", "a", "b", "c", "r"} {
		testUser(t, db, id)
	}
	x, x2, x3, x4, y := testRecipe(t, db, "x", "X", true), testRecipe(t, db, "x", "X2", true), testRecipe(t, db, "x", "X3", true), testRecipe(t, db, "x", "X4", true), testRecipe(t, db, "y", "Y", true)
	day := func(month time.Month, d int) time.Time { return time.Date(2026, month, d, 15, 0, 0, 0, time.UTC) }
	midnight := func(month time.Month, d int) time.Time { return time.Date(2026, month, d, 0, 0, 0, 0, time.UTC) }
	verifiedCook(t, db, "a", x, day(8, 20), 859)
	verifiedCook(t, db, "a", y, day(9, 2), 859)
	verifiedCook(t, db, "a", x, day(10, 6), 859)
	verifiedCook(t, db, "b", x, day(8, 31), 1749)
	verifiedCook(t, db, "b", x, day(9, 1), 1749)
	verifiedCook(t, db, "b", x, day(9, 8), 1749)
	verifiedCook(t, db, "c", x, day(9, 9), 0)
	for _, r := range []string{x, x2, x3, x4} {
		verifiedCook(t, db, "r", r, day(9, 15), 859)
	}
	current := cookAlongWeek(day(10, 7))
	weeks, e := fundWeekReport(ctx, db, current, 2000)
	if e != nil {
		t.Fatal(e)
	}
	got := []string{}
	september := 0
	for _, w := range weeks {
		top := []string{}
		for _, c := range w.top {
			top = append(top, fmt.Sprintf("%s:%d", c.creator, c.cooks))
		}
		got = append(got, fmt.Sprintf("%s %d cooks, %d paying, %d¢, top %v, %d flagged", w.start.Format("01-02"), w.cooks, w.paying, w.pool, top, len(w.members)))
		if w.start.Month() == 9 || w.start.Equal(midnight(8, 31)) {
			september += w.pool
		}
	}
	want := []string{
		"10-05 1 cooks, 1 paying, 171¢, top [x:1], 0 flagged",
		"09-28 0 cooks, 0 paying, 0¢, top [], 0 flagged",
		"09-21 0 cooks, 0 paying, 0¢, top [], 0 flagged",
		"09-14 4 cooks, 1 paying, 171¢, top [x:4], 1 flagged",
		"09-07 2 cooks, 1 paying, 0¢, top [x:1], 0 flagged",
		// B's August share and September's from A and B: a week across two months adds both.
		"08-31 3 cooks, 2 paying, 869¢, top [x:2 y:1], 0 flagged",
		"08-24 0 cooks, 0 paying, 0¢, top [], 0 flagged",
		"08-17 1 cooks, 1 paying, 171¢, top [x:1], 0 flagged",
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("weeks:\n%v\nwant\n%v", got, want)
	}
	// The weeks add up to what September closes with (its share of the week of August 31 is
	// 349 + 171).
	rows, e := fundCooks(ctx, db, midnight(9, 1), midnight(10, 1), "")
	if e != nil {
		t.Fatal(e)
	}
	if _, pool, _, _ := splitFund(rows, 2000); pool != 691 || september-349 != pool {
		t.Fatalf("September's pool %d, weeks %d", pool, september)
	}
	if len(weeks[3].creators) != 1 || weeks[3].creators[0].creator != "x" {
		t.Fatalf("flagged creators: %+v", weeks[3].creators)
	}
}

func TestAdminFundShowsPaidCooksAndTheWeeklyReport(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	newFakeConnect(t)
	f := adminApp(db, false)
	_, owner := signedIn(t, db, "owner@example.test", true)
	_, member := signedIn(t, db, "member@example.test", true)
	for _, id := range []string{"x", "ring"} {
		namedUser(t, db, id, "Cook "+id)
	}
	at := time.Now().Add(-time.Minute)
	for _, title := range []string{"A", "B", "C", "D"} {
		verifiedCook(t, db, "ring", testRecipe(t, db, "x", title, true), at, 859)
	}
	expect(t, f, 403, "GET", "/v1/admin/fund/weeks", member, nil)
	var fund struct {
		Flags struct {
			Threshold int
			Members   []struct {
				ID, Name     string
				Cooks, Cents int
				Creator      struct{ ID, Name string }
			}
			Creators []struct {
				ID                          string
				EstimateCents, FlaggedCents int
				Members                     int
			}
		}
	}
	if status, b := send(t, f, "GET", "/v1/admin/fund", owner, nil); status != 200 || json.Unmarshal(b, &fund) != nil {
		t.Fatalf("fund: %d %s", status, b)
	}
	flags := fund.Flags
	if flags.Threshold != paidCooksThreshold || len(flags.Members) != 1 || flags.Members[0].ID != "ring" || flags.Members[0].Name != "Cook ring" || flags.Members[0].Cooks != 4 ||
		flags.Members[0].Cents != 171 || flags.Members[0].Creator.ID != "x" || len(flags.Creators) != 1 || flags.Creators[0].FlaggedCents != 171 || flags.Creators[0].EstimateCents != 171 {
		t.Fatalf("flags: %+v", flags)
	}
	var report struct {
		Weeks []struct {
			Week                  string
			Current               bool
			Cooks, FlaggedMembers int
			PoolCents             int
			Top, FlaggedCreators  []struct{ ID, Name string }
		}
		Threshold    int
		SharePercent float64
	}
	if status, b := send(t, f, "GET", "/v1/admin/fund/weeks", owner, nil); status != 200 || json.Unmarshal(b, &report) != nil {
		t.Fatalf("weeks: %d %s", status, b)
	}
	w := report.Weeks
	if len(w) != fundWeeks || !w[0].Current || w[0].Week != cookAlongWeek(at).Format(time.DateOnly) || w[0].Cooks != 4 || w[0].FlaggedMembers != 1 ||
		len(w[0].Top) != 1 || w[0].Top[0].Name != "Cook x" || len(w[0].FlaggedCreators) != 1 || report.SharePercent != 20 {
		t.Fatalf("report: %+v", report)
	}
	if w[0].PoolCents != 171 {
		t.Fatalf("this week's pool %d", w[0].PoolCents)
	}
}

func TestTappedThroughCooksLookMechanical(t *testing.T) {
	ev := func(kind string, at int64) insightEvent { return insightEvent{kind: kind, at: at} }
	visits := visitsOf([]insightEvent{ev("enter", 0), ev("timer_start", 1000), ev("enter", 4000), ev("enter", 8000), ev("leave", 12500)})
	if !reflect.DeepEqual(visits, []int64{4000, 4000, 4500}) {
		t.Fatalf("visits %v", visits)
	}
	for _, c := range []struct {
		s    tappedSession
		want bool
	}{
		{tappedSession{seconds: 185, minimumSec: 180, visits: []int64{60_000, 62_000, 63_000}}, true},     // even steps, the minimum
		{tappedSession{seconds: 185, minimumSec: 180, visits: []int64{20_000, 60_000, 100_000}}, false},   // steps of their own lengths
		{tappedSession{seconds: 900, minimumSec: 180, visits: []int64{300_000, 300_000, 300_000}}, false}, // well past the minimum
		{tappedSession{seconds: 185, minimumSec: 180, visits: []int64{90_000, 95_000}}, false},            // too few steps to tell
	} {
		if got := c.s.mechanical(); got != c.want {
			t.Errorf("%+v: %v", c.s, got)
		}
	}
}

func TestTappedThroughMembersAreFlagged(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	authorID, _ := signedIn(t, db, "author@example.test", true)
	botID, _ := signedIn(t, db, "bot@example.test", true)
	cookID, _ := signedIn(t, db, "cook@example.test", true)
	// A 20-minute recipe: its minimum is 6 minutes.
	recipe := insightRecipe(t, db, authorID)
	cook := func(member string, steps ...int64) {
		t.Helper()
		id := uuid.NewString()
		var total int64
		for _, s := range steps {
			total += s
		}
		if _, e := db.Exec(ctx, `INSERT INTO cook_sessions(id,user_id,recipe_id,steps,step_reached,started_at,finished_at,verified,verified_day,events)
 VALUES($1,$2,$3,3,3,now()-make_interval(secs=>$4::float8/1000),now(),true,current_date-(SELECT count(*)::int FROM cook_sessions WHERE user_id=$2),$5)`, id, member, recipe, total, len(steps)+1); e != nil {
			t.Fatal(e)
		}
		at := int64(1_700_000_000_000)
		for i, s := range steps {
			if _, e := db.Exec(ctx, `INSERT INTO cook_step_events(session_id,seq,kind,step,step_key,at_ms) VALUES($1,$2,'enter',$3,'aaaaaaaaaaaaaaaa',$4)`, id, i, i+1, at); e != nil {
				t.Fatal(e)
			}
			at += s
		}
		if _, e := db.Exec(ctx, `INSERT INTO cook_step_events(session_id,seq,kind,step,step_key,at_ms) VALUES($1,$2,'leave',3,'aaaaaaaaaaaaaaaa',$3)`, id, len(steps), at); e != nil {
			t.Fatal(e)
		}
	}
	// Two cooks at the minimum, two minutes a step: flagged. A real cook's steps differ.
	cook(botID, 120_000, 121_000, 122_000)
	cook(botID, 120_000, 120_000, 121_000)
	cook(cookID, 60_000, 250_000, 60_000)
	cook(cookID, 70_000, 240_000, 65_000)
	from := monthStart(time.Now())
	got, e := tappedMembers(ctx, db, from, from.AddDate(0, 1, 0))
	if e != nil || len(got) != 1 || got[0].member != botID || got[0].cooks != 2 {
		t.Fatalf("flagged %+v %v", got, e)
	}
}

package app

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestFundShareIsCappedAndPlansStayCashPositive(t *testing.T) {
	for value, want := range map[string]int{"": 2000, "0.1": 1000, "0.2": 2000, "0.5": 2000, "-1": 0, "nope": 2000} {
		t.Setenv("CREATOR_FUND_SHARE", value)
		if got := fundShareBP(); got != want {
			t.Errorf("CREATOR_FUND_SHARE=%q: %d basis points, want %d", value, got, want)
		}
	}
	// A member who uses every allowance, the fund's largest share and the free members' share
	// together never take more than the plan nets.
	for _, p := range plans[1:] {
		for _, interval := range []string{"monthly", "yearly"} {
			if net := p.netMonthly(interval); p.SpendCap+net*(maxFundShare+freeShare) > net {
				t.Errorf("%s %s: AI $%.2f, the fund and free use take more than its $%.2f net", p.ID, interval, p.SpendCap, net)
			}
		}
	}
}

func TestPlanNetCents(t *testing.T) {
	for _, c := range []struct {
		plan, status, interval string
		want                   int
	}{
		{"plus", "active", "monthly", 859}, // $9.99 less 11% and $0.30
		{"plus", "active", "yearly", 591},  // ($79.99 less fees) / 12
		{"pro", "active", "monthly", 1749},
		{"pro", "active", "yearly", 1184},
		{"pro", "active", "", 0}, // complimentary
		{"plus", "trialing", "monthly", 0},
		{"plus", "past_due", "monthly", 0},
		{"plus", "canceled", "monthly", 0},
		{"free", "active", "monthly", 0},
	} {
		if got := planNetCents(c.plan, c.status, c.interval); got != c.want {
			t.Errorf("%+v: %d", c, got)
		}
	}
}

func TestSplitFundAllocatesEveryCentDeterministically(t *testing.T) {
	// 171 cents (20% of Plus monthly) over two cooks of a and one of b; 236 (Pro yearly) half and half.
	shares, pool, members, cooks := splitFund([]fundCook{
		{"m1", "a", 2, 859}, {"m1", "b", 1, 859}, {"m2", "a", 1, 1184}, {"m2", "c", 1, 1184}, {"m3", "a", 5, 0},
	}, 2000)
	if pool != 407 || members != 2 || cooks != 5 {
		t.Fatalf("pool %d, members %d, cooks %d", pool, members, cooks)
	}
	for creator, want := range map[string]fundShare{"a": {114 + 118, 3}, "b": {57, 1}, "c": {118, 1}} {
		if got := shares[creator]; got == nil || *got != want {
			t.Errorf("%s: %+v, want %+v", creator, got, want)
		}
	}
	// 100 cents three ways: the spare cent goes to the lowest id among equal remainders.
	shares, pool, _, _ = splitFund([]fundCook{{"m", "z", 1, 500}, {"m", "y", 1, 500}, {"m", "x", 1, 500}}, 2000)
	if pool != 100 || shares["x"].cents != 34 || shares["y"].cents != 33 || shares["z"].cents != 33 {
		t.Fatalf("100 three ways: %d %+v %+v %+v", pool, shares["x"], shares["y"], shares["z"])
	}
	// A cent too few to reach everyone leaves the rest out rather than inventing money.
	shares, pool, _, _ = splitFund([]fundCook{{"m", "a", 1, 10}, {"m", "b", 1, 10}, {"m", "c", 1, 10}}, 1000)
	if pool != 1 || len(shares) != 1 || shares["a"].cents != 1 {
		t.Fatalf("one cent: %d %v", pool, shares)
	}
	// Random months: the creators' cents always add up to the pool, the pool to each member's
	// share, and the order rows arrive in changes nothing.
	r := rand.New(rand.NewPCG(1, 2))
	for range 200 {
		var rows []fundCook
		want := 0
		for m := range 1 + r.IntN(30) {
			net := []int{0, 591, 859, 1184, 1749}[r.IntN(5)]
			want += net * 2000 / 10000
			for c := range 1 + r.IntN(6) {
				rows = append(rows, fundCook{fmt.Sprint("m", m), fmt.Sprint("c", (m+c)%9), 1 + r.IntN(4), net})
			}
		}
		shares, pool, _, _ := splitFund(rows, 2000)
		sum := 0
		for _, s := range shares {
			sum += s.cents
		}
		r.Shuffle(len(rows), func(i, j int) { rows[i], rows[j] = rows[j], rows[i] })
		again, _, _, _ := splitFund(rows, 2000)
		if sum != pool || pool != want {
			t.Fatalf("creators %d, pool %d, members' shares %d", sum, pool, want)
		}
		for c, s := range shares {
			if *again[c] != *s {
				t.Fatalf("%s got %+v, then %+v in another order", c, s, again[c])
			}
		}
	}
}

// verifiedCook adds a verified cook finished at the given time, as cook_sessions.go records one.
func verifiedCook(t *testing.T, db *pgxpool.Pool, member, recipe string, at time.Time, net int) {
	t.Helper()
	_, e := db.Exec(context.Background(), `INSERT INTO cook_sessions(id,user_id,recipe_id,steps,step_reached,started_at,finished_at,verified,verified_day,net_cents)
 VALUES($1,$2,$3,1,1,$4::timestamptz-interval '30 minutes',$4,true,($4::timestamptz AT TIME ZONE 'UTC')::date,$5)`, uuid.NewString(), member, recipe, at, net)
	if e != nil {
		t.Fatal(e)
	}
}

func TestClosingAMonthSplitsItOnce(t *testing.T) {
	t.Setenv("CREATOR_FUND_SHARE", "")
	db := isolatedDB(t)
	ctx := context.Background()
	for _, id := range []string{"a", "b", "c", "m1", "m2", "m3"} {
		testUser(t, db, id)
	}
	ra, rb, rc, own := testRecipe(t, db, "a", "A", true), testRecipe(t, db, "b", "B", true), testRecipe(t, db, "c", "C", true), testRecipe(t, db, "m1", "Mine", true)
	september := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	at := september.Add(36 * time.Hour)
	verifiedCook(t, db, "m1", ra, at, 859)
	verifiedCook(t, db, "m1", ra, at.Add(24*time.Hour), 859)
	verifiedCook(t, db, "m1", rb, at, 859)
	verifiedCook(t, db, "m1", own, at, 859) // never pays the member's own kitchen
	verifiedCook(t, db, "m2", rc, at, 1184)
	verifiedCook(t, db, "m2", ra, september.AddDate(0, 1, 0).Add(-time.Second), 1184) // the month's last second
	verifiedCook(t, db, "m3", ra, at, 0)                                              // complimentary: no money
	verifiedCook(t, db, "m2", rb, september.AddDate(0, 1, 0), 1184)                   // October

	// Two replicas at once: one closes the month.
	var wg sync.WaitGroup
	closed := make(chan bool, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, e := closeFundMonth(ctx, db, september)
			if e != nil {
				t.Error(e)
			}
			closed <- ok
		}()
	}
	wg.Wait()
	close(closed)
	n := 0
	for ok := range closed {
		if ok {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("closed %d times", n)
	}
	if ok, e := closeFundMonth(ctx, db, september); ok || e != nil {
		t.Fatalf("closed again: %v %v", ok, e)
	}
	var pool, members, cooks, creators, earned int
	if e := db.QueryRow(ctx, `SELECT pool_cents,members,cooks,creators,(SELECT sum(amount_cents) FROM creator_earnings WHERE month=$1) FROM creator_fund_months WHERE month=$1`, september).
		Scan(&pool, &members, &cooks, &creators, &earned); e != nil {
		t.Fatal(e)
	}
	if pool != 171+236 || members != 2 || cooks != 5 || creators != 3 || earned != pool {
		t.Fatalf("pool %d, members %d, cooks %d, creators %d, earned %d", pool, members, cooks, creators, earned)
	}
	got := map[string]string{}
	rows, e := db.Query(ctx, `SELECT creator_id,amount_cents,cooks,status FROM creator_earnings WHERE month=$1`, september)
	if e != nil {
		t.Fatal(e)
	}
	for rows.Next() {
		var creator, status string
		var amount, n int
		if e := rows.Scan(&creator, &amount, &n, &status); e != nil {
			t.Fatal(e)
		}
		got[creator] = fmt.Sprintf("%d/%d/%s", amount, n, status)
	}
	if want := map[string]string{"a": "232/3/pending", "b": "57/1/pending", "c": "118/1/pending"}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("earnings %v, want %v", got, want)
	}
	// The job closes the month before the current one.
	t.Setenv("STRIPE_SECRET_KEY", "")
	if e := runCreatorFund(ctx, db, time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)); e != nil {
		t.Fatal(e)
	}
	var october int
	if e := db.QueryRow(ctx, `SELECT pool_cents FROM creator_fund_months WHERE month='2026-10-01'`).Scan(&october); e != nil || october != 236 {
		t.Fatalf("October: %d %v", october, e)
	}
}

// fakeConnect is Stripe's Connect API as the fund uses it: accounts, onboarding and dashboard
// links, transfers (made once per idempotency key, listed by transfer group) and failures.
type fakeConnect struct {
	sync.Mutex
	requests  []string
	forms     map[string]url.Values
	accounts  map[string]map[string]any
	transfers []map[string]string // id, destination, amount, group, key
	refuse    map[string]bool     // destinations whose transfers Stripe declines
	lose      map[string]bool     // destinations whose answer gets lost after the transfer is made
	created   int
}

func newFakeConnect(t *testing.T) *fakeConnect {
	f := &fakeConnect{forms: map[string]url.Values{}, accounts: map[string]map[string]any{}, refuse: map[string]bool{}, lose: map[string]bool{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.Lock()
		defer f.Unlock()
		_ = r.ParseForm()
		f.requests = append(f.requests, r.Method+" "+r.URL.Path)
		f.forms[r.Method+" "+r.URL.Path] = r.PostForm
		if r.Header.Get("Authorization") != "Bearer sk_test" {
			w.WriteHeader(401)
			return
		}
		reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		switch {
		case r.Method == "POST" && r.URL.Path == "/accounts":
			f.created++
			id := fmt.Sprint("acct_", f.created)
			f.accounts[id] = map[string]any{"id": id, "payouts_enabled": false, "details_submitted": false, "capabilities": map[string]any{"transfers": "inactive"}}
			reply(f.accounts[id])
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/accounts/"):
			reply(f.accounts[strings.TrimPrefix(r.URL.Path, "/accounts/")])
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/login_links"):
			reply(map[string]string{"url": "https://connect.stripe.test/express"})
		case r.Method == "POST" && r.URL.Path == "/account_links":
			reply(map[string]string{"url": "https://connect.stripe.test/onboarding"})
		case r.Method == "POST" && r.URL.Path == "/transfers":
			key, to := r.Header.Get("Idempotency-Key"), r.PostForm.Get("destination")
			if f.refuse[to] {
				w.WriteHeader(400)
				return
			}
			var made map[string]string
			for _, x := range f.transfers {
				if x["key"] == key {
					made = x
				}
			}
			if made == nil {
				made = map[string]string{"id": fmt.Sprint("tr_", len(f.transfers)+1), "destination": to, "amount": r.PostForm.Get("amount"), "group": r.PostForm.Get("transfer_group"), "key": key}
				f.transfers = append(f.transfers, made)
			}
			if f.lose[to] {
				w.WriteHeader(500)
				return
			}
			reply(map[string]string{"id": made["id"]})
		case r.Method == "GET" && r.URL.Path == "/transfers":
			found := []map[string]string{}
			for _, x := range f.transfers {
				if x["group"] == r.URL.Query().Get("transfer_group") {
					found = append(found, map[string]string{"id": x["id"]})
				}
			}
			reply(map[string]any{"data": found})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	old := stripeBase
	stripeBase = server.URL
	t.Cleanup(func() { stripeBase = old })
	t.Setenv("CREATOR_FUND", "true")
	t.Setenv("CREATOR_FUND_SHARE", "")
	t.Setenv("PAID_PLANS", "true")
	t.Setenv("STRIPE_SECRET_KEY", "sk_test")
	t.Setenv("STRIPE_WEBHOOK_SECRET", "whsec")
	t.Setenv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect")
	t.Setenv("APP_URL", "")
	return f
}

func (f *fakeConnect) enable(account string) {
	f.Lock()
	defer f.Unlock()
	f.accounts[account]["payouts_enabled"] = true
	f.accounts[account]["details_submitted"] = true
	f.accounts[account]["capabilities"] = map[string]any{"transfers": "active"}
}

func (f *fakeConnect) count(request string) int {
	f.Lock()
	defer f.Unlock()
	n := 0
	for _, r := range f.requests {
		if r == request {
			n++
		}
	}
	return n
}

// earning records a closed month's earnings for a creator.
func earning(t *testing.T, db *pgxpool.Pool, creator string, month time.Time, cents int) {
	t.Helper()
	ctx := context.Background()
	if _, e := db.Exec(ctx, `INSERT INTO creator_fund_months(month,share_bp) VALUES($1,2000) ON CONFLICT DO NOTHING`, month); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `INSERT INTO creator_earnings(creator_id,month,amount_cents,cooks) VALUES($1,$2,$3,1)`, creator, month, cents); e != nil {
		t.Fatal(e)
	}
}

// payoutAccount gives a creator a Connect account Stripe can pay.
func payoutAccount(t *testing.T, db *pgxpool.Pool, f *fakeConnect, creator, account string) {
	t.Helper()
	f.Lock()
	f.accounts[account] = map[string]any{"id": account}
	f.Unlock()
	f.enable(account)
	if _, e := db.Exec(context.Background(), `INSERT INTO creator_accounts(user_id,stripe_account_id,country,payouts_enabled,details_submitted) VALUES($1,$2,'US',true,true)`, creator, account); e != nil {
		t.Fatal(e)
	}
}

func TestEarningsOnboardingAndConnectWebhook(t *testing.T) {
	db := isolatedDB(t)
	stripe := newFakeConnect(t)
	f := adminApp(db, false)
	ctx := context.Background()
	creatorID, creator := signedIn(t, db, "creator@example.test", true)
	memberID, member := signedIn(t, db, "member@example.test", true)
	if _, e := db.Exec(ctx, `UPDATE users SET plan='plus',plan_status='active',plan_interval='monthly' WHERE id=$1`, memberID); e != nil {
		t.Fatal(e)
	}
	recipe := cookRecipe(t, db, creatorID, 30, 1)
	if c := expect(t, f, 200, "GET", "/v1/capabilities", "", nil); c["creatorFund"] != true {
		t.Fatalf("capabilities: %v", c)
	}

	// A paying member's verified cook shows in the creator's estimate at once.
	out := expect(t, f, 201, "POST", "/v1/recipes/"+recipe+"/cook-sessions", member, nil)
	session, _ := out["id"].(string)
	startedAgo(t, db, session, 15)
	expect(t, f, 200, "PATCH", "/v1/cook-sessions/"+session, member, map[string]any{"step": 1, "finished": true})
	mine := expect(t, f, 200, "GET", "/v1/me/earnings", creator, nil)
	if mine["cooks"] != 1.0 || mine["estimateCents"] != 171.0 || mine["sharePercent"] != 20.0 || mine["minimumCents"] != 1000.0 || mine["balanceCents"] != 0.0 {
		t.Fatalf("earnings: %v", mine)
	}
	if p, _ := mine["payouts"].(map[string]any); p["connected"] != false || p["enabled"] != false {
		t.Fatalf("payouts before onboarding: %v", p)
	}

	// Onboarding: only for creators, in a country Stripe pays out to, and one account each.
	expect(t, f, 403, "POST", "/v1/me/payouts/onboarding", member, map[string]any{"country": "US"})
	expect(t, f, 400, "POST", "/v1/me/payouts/onboarding", creator, map[string]any{})
	if got := expect(t, f, 422, "POST", "/v1/me/payouts/onboarding", creator, map[string]any{"country": "KP"}); got["error"] != "Stripe can't send payouts to your country yet, so payouts aren't available there." {
		t.Fatalf("unsupported country: %v", got)
	}
	link := expect(t, f, 200, "POST", "/v1/me/payouts/onboarding", creator, map[string]any{"country": "fr"})
	if link["kind"] != "onboarding" || link["url"] != "https://connect.stripe.test/onboarding" {
		t.Fatalf("onboarding: %v", link)
	}
	form := stripe.forms["POST /accounts"]
	if form.Get("type") != "express" || form.Get("country") != "FR" || form.Get("tos_acceptance[service_agreement]") != "recipient" || form.Get("capabilities[transfers][requested]") != "true" {
		t.Fatalf("account request: %v", form)
	}
	if back := stripe.forms["POST /account_links"].Get("return_url"); back != "http://localhost:8081/?page=profile&payouts=done" {
		t.Fatalf("return url %q", back)
	}
	expect(t, f, 200, "POST", "/v1/me/payouts/onboarding", creator, map[string]any{"country": "DE"})
	if n := stripe.count("POST /accounts"); n != 1 {
		t.Fatalf("%d accounts created", n)
	}

	// account.updated, signed with the Connect secret, records that payouts are on.
	stripe.enable("acct_1")
	event := []byte(`{"id":"evt_1","type":"account.updated","account":"acct_1","data":{"object":{"id":"acct_1"}}}`)
	webhook := func(body []byte, signature string) int {
		req := httptest.NewRequest("POST", "/v1/payouts/webhook", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Stripe-Signature", signature)
		res, e := f.Test(req)
		if e != nil {
			t.Fatal(e)
		}
		return res.StatusCode
	}
	if got := webhook(event, signStripe(event, "whsec", time.Now())); got != 400 {
		t.Fatalf("billing secret on the Connect webhook: %d", got)
	}
	if got := webhook(event, signStripe(event, "whsec_connect", time.Now())); got != 200 {
		t.Fatalf("Connect webhook: %d", got)
	}
	mine = expect(t, f, 200, "GET", "/v1/me/earnings", creator, nil)
	if p, _ := mine["payouts"].(map[string]any); p["connected"] != true || p["enabled"] != true || p["country"] != "FR" {
		t.Fatalf("payouts after onboarding: %v", p)
	}
	// Once onboarding is done, the same button opens the Express dashboard.
	if link := expect(t, f, 200, "POST", "/v1/me/payouts/onboarding", creator, nil); link["kind"] != "dashboard" {
		t.Fatalf("after onboarding: %v", link)
	}
	// Events about accounts this server doesn't know are acknowledged and ignored.
	other := []byte(`{"id":"evt_2","type":"account.updated","data":{"object":{"id":"acct_unknown"}}}`)
	if got := webhook(other, signStripe(other, "whsec_connect", time.Now())); got != 200 || stripe.count("GET /accounts/acct_unknown") != 0 {
		t.Fatalf("unknown account: %d", got)
	}

	// Without the fund, its routes are closed.
	t.Setenv("CREATOR_FUND", "")
	expect(t, f, 404, "GET", "/v1/me/earnings", creator, nil)
	expect(t, f, 503, "POST", "/v1/me/payouts/onboarding", creator, nil)
	if got := webhook(event, signStripe(event, "whsec_connect", time.Now())); got != 404 {
		t.Fatalf("Connect webhook with the fund off: %d", got)
	}
}

func TestPayoutsAreIdempotentAndKeepFailuresUnpaid(t *testing.T) {
	db := isolatedDB(t)
	stripe := newFakeConnect(t)
	ctx := context.Background()
	for _, id := range []string{"small", "ready", "refused", "lost", "held", "stuck", "gone"} {
		testUser(t, db, id)
	}
	august, september := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	for creator, cents := range map[string]int{"small": 999, "ready": 600, "refused": 2000, "lost": 1500, "held": 5000} {
		payoutAccount(t, db, stripe, creator, "acct_"+creator)
		earning(t, db, creator, september, cents)
	}
	earning(t, db, "ready", august, 500)
	stripe.refuse["acct_refused"] = true
	stripe.lose["acct_lost"] = true
	if _, e := db.Exec(ctx, `UPDATE creator_accounts SET held_at=now(),held_reason='Checking for fraud' WHERE user_id='held'`); e != nil {
		t.Fatal(e)
	}
	status := func(creator string) string {
		t.Helper()
		var s string
		if e := db.QueryRow(ctx, `SELECT string_agg(e.status||':'||COALESCE(p.status,'-'),',' ORDER BY e.month) FROM creator_earnings e LEFT JOIN creator_payouts p ON p.id=e.payout_id WHERE e.creator_id=$1`, creator).Scan(&s); e != nil {
			t.Fatal(e)
		}
		return s
	}
	check := func(want map[string]string) {
		t.Helper()
		for creator, w := range want {
			if got := status(creator); got != w {
				t.Errorf("%s: %s, want %s", creator, got, w)
			}
		}
	}
	// ready is paid both months in one transfer; small is under $10 and held waits. Stripe didn't
	// confirm refused's or lost's transfer, so they stay on their way, not sent again.
	if paid, e := runPayouts(ctx, db); e != nil || paid != 1 {
		t.Fatalf("first run: %d paid, %v", paid, e)
	}
	check(map[string]string{"small": "pending:-", "ready": "paid:paid,paid:paid", "refused": "pending:sending", "lost": "pending:sending", "held": "pending:-"})
	if paid, e := runPayouts(ctx, db); e != nil || paid != 0 || stripe.count("POST /transfers") != 3 {
		t.Fatalf("a run within ten minutes: %d paid, %v, %d transfer requests", paid, e, stripe.count("POST /transfers"))
	}
	// Ten minutes on, Stripe is asked: lost's transfer was made after all, refused's never was.
	if _, e := db.Exec(ctx, `UPDATE creator_payouts SET updated_at=now()-interval '11 minutes' WHERE status='sending'`); e != nil {
		t.Fatal(e)
	}
	if paid, e := runPayouts(ctx, db); e != nil || paid != 1 {
		t.Fatalf("resolving run: %d paid, %v", paid, e)
	}
	check(map[string]string{"refused": "pending:-", "lost": "paid:paid"})
	transfers := func() string {
		stripe.Lock()
		defer stripe.Unlock()
		out := []string{}
		for _, x := range stripe.transfers {
			out = append(out, x["destination"]+"="+x["amount"])
		}
		return strings.Join(out, ",")
	}
	if got := transfers(); got != "acct_lost=1500,acct_ready=1100" || stripe.count("POST /transfers") != 3 {
		t.Fatalf("transfers %s", got)
	}
	var key, group, payout string
	if e := db.QueryRow(ctx, `SELECT id FROM creator_payouts WHERE creator_id='ready'`).Scan(&payout); e != nil {
		t.Fatal(e)
	}
	stripe.Lock()
	for _, x := range stripe.transfers {
		if x["destination"] == "acct_ready" {
			key, group = x["key"], x["group"]
		}
	}
	stripe.Unlock()
	if key != "creator-payout-"+payout || group != payout {
		t.Fatalf("transfer key %q and group %q for payout %s", key, group, payout)
	}
	var failed string
	if e := db.QueryRow(ctx, `SELECT status||': '||error FROM creator_payouts WHERE creator_id='refused'`).Scan(&failed); e != nil || failed != "failed: Stripe didn't make the transfer." {
		t.Fatalf("refused payout: %q %v", failed, e)
	}

	// Running again sends nothing new: what's paid is paid, and a failed creator waits a day.
	before := stripe.count("POST /transfers")
	if paid, e := runPayouts(ctx, db); e != nil || paid != 0 || stripe.count("POST /transfers") != before {
		t.Fatalf("second run: %d paid, %v, %d transfer requests after %d", paid, e, stripe.count("POST /transfers"), before)
	}
	// A day later the declined creator is tried again, and paid once Stripe accepts.
	stripe.refuse["acct_refused"] = false
	if _, e := db.Exec(ctx, `UPDATE creator_payouts SET created_at=now()-interval '25 hours' WHERE creator_id='refused'`); e != nil {
		t.Fatal(e)
	}
	if paid, e := runPayouts(ctx, db); e != nil || paid != 1 || status("refused") != "paid:paid" {
		t.Fatalf("retry: %d paid, %v, %s", paid, e, status("refused"))
	}

	// A run that stopped between asking Stripe and recording its answer: the next run asks Stripe
	// by transfer group, recording a transfer that was made and releasing one that wasn't.
	for creator, made := range map[string]bool{"stuck": true, "gone": false} {
		payoutAccount(t, db, stripe, creator, "acct_"+creator)
		earning(t, db, creator, september, 3000)
		id := uuid.NewString()
		if _, e := db.Exec(ctx, `INSERT INTO creator_payouts(id,creator_id,stripe_account_id,amount_cents,updated_at) VALUES($1,$2,$3,3000,now()-interval '1 hour')`, id, creator, "acct_"+creator); e != nil {
			t.Fatal(e)
		}
		if _, e := db.Exec(ctx, `UPDATE creator_earnings SET payout_id=$1 WHERE creator_id=$2`, id, creator); e != nil {
			t.Fatal(e)
		}
		if made {
			stripe.Lock()
			stripe.transfers = append(stripe.transfers, map[string]string{"id": "tr_stuck", "destination": "acct_stuck", "amount": "3000", "group": id, "key": "creator-payout-" + id})
			stripe.Unlock()
		}
	}
	if paid, e := runPayouts(ctx, db); e != nil || paid != 1 {
		t.Fatalf("stuck payouts: %d %v", paid, e)
	}
	if got := status("stuck"); got != "paid:paid" {
		t.Errorf("stuck: %s", got)
	}
	// The released one waits its day like any failure, then goes out as a new payout.
	if got := status("gone"); got != "pending:-" {
		t.Errorf("gone: %s", got)
	}
	var sum, transferred int
	if e := db.QueryRow(ctx, `SELECT (SELECT sum(amount_cents) FROM creator_earnings WHERE status='paid'),(SELECT sum(amount_cents) FROM creator_payouts WHERE status='paid')`).Scan(&sum, &transferred); e != nil || sum != transferred {
		t.Fatalf("paid earnings %d, paid payouts %d, %v", sum, transferred, e)
	}
}

func TestAdminFundViewsAndPayoutHolds(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "owner@example.test")
	db := isolatedDB(t)
	newFakeConnect(t)
	f := adminApp(db, false)
	_, owner := signedIn(t, db, "owner@example.test", true)
	creatorID, creator := signedIn(t, db, "creator@example.test", true)
	earning(t, db, creatorID, time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), 1234)

	expect(t, f, 403, "GET", "/v1/admin/fund", creator, nil)
	expect(t, f, 403, "PUT", "/v1/admin/users/"+creatorID+"/payouts-hold", creator, map[string]any{"held": true, "reason": "Self"})
	fund := expect(t, f, 200, "GET", "/v1/admin/fund", owner, nil)
	if months, _ := fund["months"].([]any); len(months) != 1 || fund["unpaidCents"] != 1234.0 || fund["enabled"] != true {
		t.Fatalf("fund: %v", fund)
	}
	expect(t, f, 400, "PUT", "/v1/admin/users/"+creatorID+"/payouts-hold", owner, map[string]any{"held": true})
	record := expect(t, f, 200, "PUT", "/v1/admin/users/"+creatorID+"/payouts-hold", owner, map[string]any{"held": true, "reason": "Looks like a cooking ring"})
	if account, _ := record["account"].(map[string]any); account["heldReason"] != "Looks like a cooking ring" || account["heldBy"] != "owner@example.test" || record["balanceCents"] != 1234.0 {
		t.Fatalf("held record: %v", record)
	}
	expect(t, f, 409, "PUT", "/v1/admin/users/"+creatorID+"/payouts-hold", owner, map[string]any{"held": true, "reason": "Again"})
	if p, _ := expect(t, f, 200, "GET", "/v1/me/earnings", creator, nil)["payouts"].(map[string]any); p["held"] != true {
		t.Fatalf("the creator doesn't see the hold: %v", p)
	}
	expect(t, f, 200, "PUT", "/v1/admin/users/"+creatorID+"/payouts-hold", owner, map[string]any{"held": false})
	expect(t, f, 409, "PUT", "/v1/admin/users/"+creatorID+"/payouts-hold", owner, map[string]any{"held": false})
	if got := auditActions(t, db); got != "member.payouts_hold,member.payouts_release" {
		t.Fatalf("audit: %s", got)
	}
}

func TestCookSessionsAndEarningsAreExportedAndDeleted(t *testing.T) {
	db := isolatedDB(t)
	f := adminApp(db, false)
	ctx := context.Background()
	authorID, _ := signedIn(t, db, "author@example.test", true)
	cookID, cook := signedIn(t, db, "cook@example.test", true)
	recipe := cookRecipe(t, db, authorID, 10, 1)
	mine := cookRecipe(t, db, cookID, 10, 1)
	out := expect(t, f, 201, "POST", "/v1/recipes/"+recipe+"/cook-sessions", cook, nil)
	id, _ := out["id"].(string)
	startedAgo(t, db, id, 5)
	expect(t, f, 200, "PATCH", "/v1/cook-sessions/"+id, cook, map[string]any{"step": 1, "finished": true})
	verifiedCook(t, db, authorID, mine, time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC), 859)
	earning(t, db, cookID, time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), 171)

	_, b := send(t, f, "GET", "/v1/me/export", cook, nil)
	var export struct {
		CookSessions    []map[string]any
		CreatorEarnings []map[string]any
	}
	if e := json.Unmarshal(b, &export); e != nil || len(export.CookSessions) != 1 || export.CookSessions[0]["verifiedCook"] != true || len(export.CreatorEarnings) != 1 || export.CreatorEarnings[0]["amountCents"] != 171.0 {
		t.Fatalf("export: %s", b)
	}
	expect(t, f, 204, "DELETE", "/v1/me", cook, map[string]any{"password": testPassword})
	var left int
	if e := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM cook_sessions WHERE user_id=$1 OR recipe_id=$2)+(SELECT count(*) FROM creator_earnings WHERE creator_id=$1)`, cookID, mine).Scan(&left); e != nil || left != 0 {
		t.Fatalf("%d rows left after deleting the account: %v", left, e)
	}
}

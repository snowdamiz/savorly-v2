package app

import (
	"context"
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type groceryJSON struct {
	ID, Name, Quantity string
	Checked            bool
	AddedBy            *struct{ ID, Name string }
}

type householdReply struct {
	ID, Name, Role string
	Members        []struct{ ID, Name, Handle, Avatar, Role string }
}

// namedUser adds a member with a display name.
func namedUser(t *testing.T, db *pgxpool.Pool, id, name string) {
	t.Helper()
	testUser(t, db, id)
	if _, e := db.Exec(context.Background(), `UPDATE users SET name=$2 WHERE id=$1`, id, name); e != nil {
		t.Fatal(e)
	}
}

// groceriesOf is the grocery list /kitchen shows the member, as "name: quantity" lines in order.
func groceriesOf(t *testing.T, f *fiber.App, tok string) []groceryJSON {
	t.Helper()
	status, b := callAPI(t, f, "GET", "/v1/kitchen", tok, nil)
	var k struct{ Groceries []groceryJSON }
	if status != 200 || json.Unmarshal(b, &k) != nil {
		t.Fatalf("kitchen: %d %s", status, b)
	}
	return k.Groceries
}

func lines(list []groceryJSON) []string {
	out := []string{}
	for _, g := range list {
		line := g.Name
		if g.Quantity != "" {
			line += ": " + g.Quantity
		}
		if g.AddedBy != nil {
			line += " (" + g.AddedBy.Name + ")"
		}
		if g.Checked {
			line += " ✓"
		}
		out = append(out, line)
	}
	slices.Sort(out)
	return out
}

func findGrocery(t *testing.T, list []groceryJSON, name string) groceryJSON {
	t.Helper()
	for _, g := range list {
		if g.Name == name {
			return g
		}
	}
	t.Fatalf("no %q in %v", name, lines(list))
	return groceryJSON{}
}

func householdOfReply(t *testing.T, status int, b []byte) householdReply {
	t.Helper()
	var h householdReply
	if json.Unmarshal(b, &h) != nil || h.ID == "" {
		t.Fatalf("not a household (%d): %s", status, b)
	}
	return h
}

func inviteCode(t *testing.T, f *fiber.App, tok string) string {
	t.Helper()
	status, b := callAPI(t, f, "POST", "/v1/household/invite", tok, nil)
	var out struct {
		Code      string
		ExpiresAt time.Time
	}
	if status != 200 || json.Unmarshal(b, &out) != nil {
		t.Fatalf("invite: %d %s", status, b)
	}
	if !regexp.MustCompile(`^[A-Z2-9]{8}$`).MatchString(out.Code) {
		t.Fatalf("invite code %q", out.Code)
	}
	if d := time.Until(out.ExpiresAt); d < 7*24*time.Hour-time.Minute || d > 7*24*time.Hour+time.Minute {
		t.Fatalf("invite expires in %v", d)
	}
	return out.Code
}

func TestHouseholdsShareOneGroceryList(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	namedUser(t, db, "ana", "Ana")
	namedUser(t, db, "ben", "Ben")
	namedUser(t, db, "cleo", "Cleo")
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	ana, ben, cleo := bearerFor(t, db, "ana"), bearerFor(t, db, "ben"), bearerFor(t, db, "cleo")
	add := func(tok, name, quantity string) {
		t.Helper()
		if status, b := callAPI(t, f, "POST", "/v1/groceries", tok, map[string]string{"name": name, "quantity": quantity}); status != 201 {
			t.Fatalf("add %s: %d %s", name, status, b)
		}
	}
	add(ana, "Milk", "1 l")
	add(ben, "Bread", "")
	add(cleo, "Tea", "")
	if status, b := callAPI(t, f, "GET", "/v1/household", ana, nil); status != 200 || string(b) != "null" {
		t.Fatalf("no household yet: %d %s", status, b)
	}
	// A personal list has no addedBy.
	if got := lines(groceriesOf(t, f, ana)); !slices.Equal(got, []string{"Milk: 1 l"}) {
		t.Fatalf("personal list: %v", got)
	}

	// Starting a household moves Ana's list into it.
	status, b := callAPI(t, f, "POST", "/v1/household", ana, map[string]string{"name": "  Home  "})
	if status != 201 {
		t.Fatalf("create: %d %s", status, b)
	}
	home := householdOfReply(t, status, b)
	if home.Name != "Home" || home.Role != "owner" || len(home.Members) != 1 || home.Members[0].ID != "ana" || home.Members[0].Role != "owner" {
		t.Fatalf("new household: %s", b)
	}
	if got := lines(groceriesOf(t, f, ana)); !slices.Equal(got, []string{"Milk: 1 l (Ana)"}) {
		t.Fatalf("household list after create: %v", got)
	}

	// Ben joins with the code as people type it, and his list moves in too.
	code := inviteCode(t, f, ana)
	status, b = callAPI(t, f, "POST", "/v1/household/join", ben, map[string]string{"code": " " + strings.ToLower(code[:4]) + "-" + code[4:]})
	if status != 200 {
		t.Fatalf("join: %d %s", status, b)
	}
	joined := householdOfReply(t, status, b)
	if joined.ID != home.ID || joined.Role != "member" || len(joined.Members) != 2 || joined.Members[0].ID != "ana" || joined.Members[1].ID != "ben" || joined.Members[1].Role != "member" {
		t.Fatalf("joined household: %s", b)
	}
	want := []string{"Bread (Ben)", "Milk: 1 l (Ana)"}
	for _, tok := range []string{ana, ben} {
		if got := lines(groceriesOf(t, f, tok)); !slices.Equal(got, want) {
			t.Fatalf("shared list: %v, want %v", got, want)
		}
	}
	// Ben adds a line, Ana ticks it off, and both see the same list.
	add(ben, "Eggs", "6")
	eggs := findGrocery(t, groceriesOf(t, f, ana), "Eggs")
	if eggs.AddedBy == nil || eggs.AddedBy.ID != "ben" || eggs.AddedBy.Name != "Ben" {
		t.Fatalf("eggs added by: %+v", eggs.AddedBy)
	}
	if status, b := callAPI(t, f, "PATCH", "/v1/groceries/"+eggs.ID, ana, map[string]bool{"checked": true}); status != 204 {
		t.Fatalf("check: %d %s", status, b)
	}
	if !findGrocery(t, groceriesOf(t, f, ben), "Eggs").Checked {
		t.Fatal("Ben doesn't see Ana's tick")
	}

	// Someone outside the household sees only their own list and can't touch the shared one.
	if got := lines(groceriesOf(t, f, cleo)); !slices.Equal(got, []string{"Tea"}) {
		t.Fatalf("outsider's list: %v", got)
	}
	if status, b := callAPI(t, f, "GET", "/v1/household", cleo, nil); status != 200 || string(b) != "null" {
		t.Fatalf("outsider's household: %d %s", status, b)
	}
	milk := findGrocery(t, groceriesOf(t, f, ben), "Milk")
	for _, c := range []struct {
		method string
		body   any
	}{{"PATCH", map[string]bool{"checked": true}}, {"DELETE", nil}} {
		if status, _ := callAPI(t, f, c.method, "/v1/groceries/"+milk.ID, cleo, c.body); status != 404 {
			t.Fatalf("outsider %s: %d", c.method, status)
		}
	}
	if findGrocery(t, groceriesOf(t, f, ana), "Milk").Checked {
		t.Fatal("an outsider checked the household's milk")
	}
	// Any member can remove any line.
	if status, _ := callAPI(t, f, "DELETE", "/v1/groceries/"+milk.ID, ben, nil); status != 204 {
		t.Fatalf("member delete: %d", status)
	}

	// Recipes and the planner merge into the household's list, whoever adds them.
	publishRecipe(t, db, "cook", "soup", func(r *RecipeInput) {
		r.Servings = 2
		r.Ingredients = []Ingredient{{Name: "Onion", Amount: 1}, {Name: "Stock", Amount: 0.5, Unit: "l"}}
	})
	for _, c := range []struct {
		tok           string
		added, merged int
	}{{ana, 2, 0}, {ben, 0, 2}} {
		status, b := callAPI(t, f, "POST", "/v1/recipes/soup/groceries", c.tok, map[string]int{"servings": 2})
		var out map[string]int
		if status != 200 || json.Unmarshal(b, &out) != nil || out["added"] != c.added || out["merged"] != c.merged {
			t.Fatalf("recipe groceries: %d %s", status, b)
		}
	}
	if status, b := callAPI(t, f, "POST", "/v1/planner", ben, map[string]any{"recipeId": "soup", "day": "2026-10-19", "meal": "Dinner", "servings": 4}); status != 200 {
		t.Fatalf("plan: %d %s", status, b)
	}
	if status, b := callAPI(t, f, "POST", "/v1/planner/groceries", ben, map[string]string{"from": "2026-10-19", "to": "2026-10-25"}); status != 200 || !strings.Contains(string(b), `"merged":2`) {
		t.Fatalf("planner groceries: %d %s", status, b)
	}
	want = []string{"Bread (Ben)", "Eggs: 6 (Ben) ✓", "Onion: 4 (Ana)", "Stock: 2 l (Ana)"}
	for _, tok := range []string{ana, ben} {
		if got := lines(groceriesOf(t, f, tok)); !slices.Equal(got, want) {
			t.Fatalf("merged household list: %v, want %v", got, want)
		}
	}
	if n := count(t, db, `SELECT count(*) FROM groceries WHERE household_id IS NULL AND user_id IN ('ana','ben')`); n != 0 {
		t.Fatalf("%d lines missed the household list", n)
	}
	var household string
	if e := db.QueryRow(ctx, `SELECT id FROM households`).Scan(&household); e != nil || household != home.ID {
		t.Fatalf("household %s: %v", household, e)
	}
}

func TestHouseholdMembershipRules(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	for _, u := range []string{"ana", "ben", "cleo", "dan"} {
		namedUser(t, db, u, strings.ToUpper(u[:1])+u[1:])
	}
	f := recipesApp(db, false)
	tok := map[string]string{}
	for _, u := range []string{"ana", "ben", "cleo", "dan"} {
		tok[u] = bearerFor(t, db, u)
	}
	expectStatus := func(want int, method, path, user string, body any) []byte {
		t.Helper()
		status, b := callAPI(t, f, method, path, tok[user], body)
		if status != want {
			t.Fatalf("%s %s as %s: want %d, got %d: %s", method, path, user, want, status, b)
		}
		return b
	}
	household := func(user string) householdReply {
		t.Helper()
		b := expectStatus(200, "GET", "/v1/household", user, nil)
		var h householdReply
		_ = json.Unmarshal(b, &h)
		return h
	}
	expectStatus(400, "POST", "/v1/household", "ana", map[string]string{"name": "   "})
	expectStatus(404, "POST", "/v1/household/invite", "ana", nil)
	expectStatus(404, "DELETE", "/v1/household/members/ana", "ana", nil)
	expectStatus(201, "POST", "/v1/household", "ana", map[string]string{"name": "Home"})
	expectStatus(409, "POST", "/v1/household", "ana", map[string]string{"name": "Second home"})
	code := inviteCode(t, f, tok["ana"])
	for _, bad := range []string{"", "ABC", "ABCDEFG1", "ABCDEFGHJ", code[:7] + "0"} {
		expectStatus(400, "POST", "/v1/household/join", "ben", map[string]string{"code": bad})
	}
	expectStatus(200, "POST", "/v1/household/join", "ben", map[string]string{"code": code})
	expectStatus(409, "POST", "/v1/household/join", "ben", map[string]string{"code": code})
	// Any member can invite; codes work for anyone until they expire.
	second := inviteCode(t, f, tok["ben"])
	expectStatus(200, "POST", "/v1/household/join", "cleo", map[string]string{"code": second})
	if _, e := db.Exec(ctx, `UPDATE household_invites SET expires_at=now()-interval '1 second'`); e != nil {
		t.Fatal(e)
	}
	expectStatus(400, "POST", "/v1/household/join", "dan", map[string]string{"code": code})

	// Only the owner removes others; anyone can leave.
	expectStatus(403, "DELETE", "/v1/household/members/ana", "ben", nil)
	expectStatus(404, "DELETE", "/v1/household/members/dan", "ana", nil)
	expectStatus(201, "POST", "/v1/groceries", "cleo", map[string]string{"name": "Rice"})
	expectStatus(204, "DELETE", "/v1/household/members/cleo", "ana", nil)
	if h := household("cleo"); h.ID != "" {
		t.Fatalf("removed member still in %s", h.ID)
	}
	// Cleo starts a new list of her own; what she added stays with the household.
	if got := lines(groceriesOf(t, f, tok["cleo"])); len(got) != 0 {
		t.Fatalf("removed member's list: %v", got)
	}
	if got := lines(groceriesOf(t, f, tok["ana"])); !slices.Equal(got, []string{"Rice (Cleo)"}) {
		t.Fatalf("household list after removal: %v", got)
	}

	// The owner leaves: the longest-standing member takes over.
	expectStatus(204, "DELETE", "/v1/household/members/ana", "ana", nil)
	if h := household("ben"); h.Role != "owner" || len(h.Members) != 1 || h.Members[0].ID != "ben" {
		t.Fatalf("after the owner left: %+v", h)
	}
	// The last one out dissolves the household and keeps its list.
	expectStatus(204, "DELETE", "/v1/household/members/ben", "ben", nil)
	if n := count(t, db, `SELECT count(*) FROM households`); n != 0 {
		t.Fatalf("%d households left", n)
	}
	if got := lines(groceriesOf(t, f, tok["ben"])); !slices.Equal(got, []string{"Rice"}) {
		t.Fatalf("last member's list: %v", got)
	}

	// Deleting the owner's account hands the household on too.
	expectStatus(201, "POST", "/v1/household", "dan", map[string]string{"name": "Flat"})
	expectStatus(200, "POST", "/v1/household/join", "ana", map[string]string{"code": inviteCode(t, f, tok["dan"])})
	if _, e := db.Exec(ctx, `DELETE FROM users WHERE id='dan'`); e != nil {
		t.Fatal(e)
	}
	if h := household("ana"); h.Name != "Flat" || h.Role != "owner" || len(h.Members) != 1 {
		t.Fatalf("after the owner's account went: %+v", h)
	}
	if _, e := db.Exec(ctx, `DELETE FROM users WHERE id='ana'`); e != nil {
		t.Fatal(e)
	}
	if n := count(t, db, `SELECT count(*) FROM households`); n != 0 {
		t.Fatalf("an empty household stayed: %d", n)
	}

	// A household holds twenty members.
	expectStatus(201, "POST", "/v1/household", "ben", map[string]string{"name": "Big family"})
	if _, e := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle) SELECT 'kin'||n,'kin'||n||'@example.test','!disabled','Kin','kin'||n FROM generate_series(1,19) n;
 INSERT INTO household_members(user_id,household_id) SELECT 'kin'||n,(SELECT household_id FROM household_members WHERE user_id='ben') FROM generate_series(1,19) n`); e != nil {
		t.Fatal(e)
	}
	expectStatus(409, "POST", "/v1/household/join", "cleo", map[string]string{"code": inviteCode(t, f, tok["ben"])})
}

func TestHouseholdJoinAttemptsAreLimited(t *testing.T) {
	db := isolatedDB(t)
	f := accountsApp(db, false)
	id := member(t, db, "guesser@example.test")
	session := deviceSession(t, db, id, phoneUA, time.Hour)
	ip := clientIP()
	for i := range 10 {
		if r := do(t, f, call{method: "POST", path: "/v1/household/join", bearer: session, ip: ip(), body: map[string]string{"code": "AAAAAAA" + string(inviteAlphabet[i])}}); r.status != 400 {
			t.Fatalf("guess %d: %d %s", i, r.status, r.body)
		}
	}
	if r := do(t, f, call{method: "POST", path: "/v1/household/join", bearer: session, ip: ip(), body: map[string]string{"code": "BBBBBBBB"}}); r.status != 429 {
		t.Fatalf("eleventh guess in an hour: %d %s", r.status, r.body)
	}
	// Other members have their own allowance, but an address has one too.
	ip2 := "10.200.0.1"
	for i := range 30 {
		other := deviceSession(t, db, member(t, db, uuid.NewString()+"@example.test"), phoneUA, time.Hour)
		r := do(t, f, call{method: "POST", path: "/v1/household/join", bearer: other, ip: ip2, body: map[string]string{"code": "CCCCCCCC"}})
		if r.status != 400 {
			t.Fatalf("member %d from one address: %d %s", i, r.status, r.body)
		}
	}
	other := deviceSession(t, db, member(t, db, "another@example.test"), phoneUA, time.Hour)
	if r := do(t, f, call{method: "POST", path: "/v1/household/join", bearer: other, ip: ip2, body: map[string]string{"code": "CCCCCCCC"}}); r.status != 429 {
		t.Fatalf("31st guess from one address: %d %s", r.status, r.body)
	}
}

func TestInviteCodes(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		code, e := newInviteCode()
		if e != nil {
			t.Fatal(e)
		}
		if got, ok := normalizeInviteCode(code); !ok || got != code {
			t.Fatalf("code %q reads back as %q %v", code, got, ok)
		}
		seen[code] = true
	}
	if len(seen) < 200 {
		t.Fatalf("only %d distinct codes in 200", len(seen))
	}
	for in, want := range map[string]string{"ab2c-d3ef": "AB2CD3EF", " AB2C D3EF ": "AB2CD3EF"} {
		if got, ok := normalizeInviteCode(in); !ok || got != want {
			t.Errorf("%q: %q %v", in, got, ok)
		}
	}
	for _, bad := range []string{"AB2CD3E", "AB2CD3EF9", "AB2CD3E0", "AB2CD3E1", "AB2CD3É1"} {
		if _, ok := normalizeInviteCode(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

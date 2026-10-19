package database

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedSchema opens a fresh schema with every migration applied, like the app package's isolatedDB.
func seedSchema(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("set TEST_DATABASE_URL for isolated-schema database tests")
	}
	ctx := context.Background()
	admin, e := pgxpool.New(ctx, raw)
	if e != nil {
		t.Fatal(e)
	}
	schema := "test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, e = admin.Exec(ctx, "CREATE SCHEMA "+schema); e != nil {
		admin.Close()
		t.Fatal(e)
	}
	parsed, e := url.Parse(raw)
	if e != nil {
		t.Fatal(e)
	}
	q := parsed.Query()
	// Extensions live in public, where migrations expect them.
	q.Set("search_path", schema+",public")
	parsed.RawQuery = q.Encode()
	db, e := Open(ctx, parsed.String())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		db.Close()
		if _, e := admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); e != nil {
			t.Error(e)
		}
		admin.Close()
	})
	return db
}

func TestSeedIsIdempotentAndRestoresMissingGalleriesAndEquipment(t *testing.T) {
	db := seedSchema(t)
	ctx := context.Background()
	count := func(sql string) int {
		var n int
		if e := db.QueryRow(ctx, sql).Scan(&n); e != nil {
			t.Fatal(e)
		}
		return n
	}
	if e := Seed(ctx, db); e != nil {
		t.Fatal(e)
	}
	users, recipes := count(`SELECT count(*) FROM users`), count(`SELECT count(*) FROM recipes`)
	if users == 0 || recipes == 0 {
		t.Fatalf("seed loaded %d users and %d recipes", users, recipes)
	}
	// Fixture cooks can never sign in.
	if n := count(`SELECT count(*) FROM users WHERE password_hash<>'!disabled'`); n != 0 {
		t.Fatalf("%d seeded users have a usable password", n)
	}
	// Every fixture says what it needs besides its ingredients.
	if n := count(`SELECT count(*) FROM recipes WHERE equipment='{}'`); n != 0 {
		t.Fatalf("%d seeded recipes list no equipment", n)
	}
	// A gallery or an equipment list that went missing comes back (a database seeded before the
	// fixtures had lists); one the cook changed stays theirs.
	if _, e := db.Exec(ctx, `UPDATE recipes SET photos='[]', equipment='{}' WHERE id='lemon-ricotta-pasta'`); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `UPDATE recipes SET equipment='{}' WHERE id='shakshuka'`); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `UPDATE recipes SET photos='["https://example.com/mine.jpg"]', title='My version', equipment='{"My wok"}' WHERE id='miso-salmon-bowl'`); e != nil {
		t.Fatal(e)
	}
	if e := Seed(ctx, db); e != nil {
		t.Fatal(e)
	}
	if count(`SELECT count(*) FROM users`) != users || count(`SELECT count(*) FROM recipes`) != recipes {
		t.Fatal("seeding twice duplicated rows")
	}
	if n := count(`SELECT jsonb_array_length(photos) FROM recipes WHERE id='lemon-ricotta-pasta'`); n == 0 {
		t.Fatal("an emptied gallery was not restored")
	}
	if n := count(`SELECT count(*) FROM recipes WHERE id IN ('lemon-ricotta-pasta','shakshuka') AND equipment<>'{}'`); n != 2 {
		t.Fatalf("%d of 2 emptied equipment lists were restored", n)
	}
	var photos, title, equipment string
	if e := db.QueryRow(ctx, `SELECT photos::text,title,equipment::text FROM recipes WHERE id='miso-salmon-bowl'`).Scan(&photos, &title, &equipment); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(photos, "mine.jpg") || title != "My version" || equipment != `{"My wok"}` {
		t.Fatalf("seed overwrote a cook's own changes: %s / %s / %s", photos, title, equipment)
	}
}

func TestSeedGivesEveryStepAPhotoAndAddsThemOnlyToUntouchedSteps(t *testing.T) {
	db := seedSchema(t)
	ctx := context.Background()
	count := func(sql string) int {
		var n int
		if e := db.QueryRow(ctx, sql).Scan(&n); e != nil {
			t.Fatal(e)
		}
		return n
	}
	withoutPhoto := `SELECT count(*) FROM recipes, jsonb_array_elements(steps) s WHERE coalesce(s->>'image','')=''`
	if e := Seed(ctx, db); e != nil {
		t.Fatal(e)
	}
	// Cooking mode fills the screen with each step's photo, so every fixture step has one.
	if n := count(withoutPhoto); n != 0 {
		t.Fatalf("%d seeded steps have no photo", n)
	}
	// A database seeded before the steps had photos gets them; a recipe whose steps a cook
	// changed, or gave a photo of their own, keeps its steps as they are.
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=(SELECT jsonb_agg(s-'image' ORDER BY n) FROM jsonb_array_elements(steps) WITH ORDINALITY e(s,n))`); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{0,text}','"My own way."') WHERE id='shakshuka'`); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `UPDATE recipes SET steps=jsonb_set(steps,'{1,image}','"https://example.com/mine.jpg"') WHERE id='green-pesto'`); e != nil {
		t.Fatal(e)
	}
	if e := Seed(ctx, db); e != nil {
		t.Fatal(e)
	}
	if n := count(withoutPhoto + ` AND id NOT IN ('shakshuka','green-pesto')`); n != 0 {
		t.Fatalf("%d untouched steps got no photo back", n)
	}
	if n := count(withoutPhoto + ` AND id='shakshuka'`); n != 3 {
		t.Fatalf("a recipe with changed steps got %d of 3 photos anyway", 3-n)
	}
	var mine string
	if e := db.QueryRow(ctx, `SELECT steps::text FROM recipes WHERE id='green-pesto'`).Scan(&mine); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(mine, "mine.jpg") || strings.Contains(mine, "images.unsplash.com") {
		t.Fatalf("seed replaced a cook's own step photo: %s", mine)
	}
}

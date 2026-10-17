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

func TestSeedIsIdempotentAndRestoresMissingGalleries(t *testing.T) {
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
	// A gallery that went missing comes back; one the cook changed stays theirs.
	if _, e := db.Exec(ctx, `UPDATE recipes SET photos='[]' WHERE id='lemon-ricotta-pasta'`); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Exec(ctx, `UPDATE recipes SET photos='["https://example.com/mine.jpg"]', title='My version' WHERE id='miso-salmon-bowl'`); e != nil {
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
	var photos, title string
	if e := db.QueryRow(ctx, `SELECT photos::text,title FROM recipes WHERE id='miso-salmon-bowl'`).Scan(&photos, &title); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(photos, "mine.jpg") || title != "My version" {
		t.Fatalf("seed overwrote a cook's own changes: %s / %s", photos, title)
	}
}

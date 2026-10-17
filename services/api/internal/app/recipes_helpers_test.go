package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// recipesApp is the real router, in development mode unless production is set.
func recipesApp(db *pgxpool.Pool, production bool) *fiber.App {
	return NewWithContext(context.Background(), db, Config{Production: production, Origins: []string{"http://localhost:8081"}})
}

// bearerFor signs user in and returns a bearer token for the real router.
func bearerFor(t *testing.T, db *pgxpool.Pool, user string) string {
	t.Helper()
	token := "session-" + uuid.NewString()
	if _, e := db.Exec(context.Background(), `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')`, hashToken(token), user); e != nil {
		t.Fatal(e)
	}
	return token
}

// publishRecipe saves a published recipe by owner, changed by modify.
func publishRecipe(t *testing.T, db *pgxpool.Pool, owner, id string, modify func(*RecipeInput)) {
	t.Helper()
	r := validRecipe()
	r.Published = true
	if modify != nil {
		modify(&r)
	}
	if e := r.Validate(); e != nil {
		t.Fatalf("recipe %s: %v", id, e)
	}
	if e := persistRecipe(context.Background(), db, owner, id, r, false); e != nil {
		t.Fatal(e)
	}
}

// callAPI sends one request through f as the session behind token ("" for a guest).
func callAPI(t *testing.T, f *fiber.App, method, path, token string, body any) (int, []byte) {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(jsonBytes(body))
	}
	req := httptest.NewRequest(method, path, r)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

// listedIDs reads the ids of a recipe list.
func listedIDs(t *testing.T, b []byte) []string {
	t.Helper()
	var list []struct{ ID string }
	if e := json.Unmarshal(b, &list); e != nil {
		t.Fatalf("not a recipe list: %s", b)
	}
	ids := []string{}
	for _, r := range list {
		ids = append(ids, r.ID)
	}
	return ids
}

type planQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// planIndexes explains sql with args, returning the indexes the plan uses and its text.
func planIndexes(t *testing.T, db planQuerier, sql string, args ...any) (map[string]bool, string) {
	t.Helper()
	ctx := context.Background()
	var plan []byte
	if e := db.QueryRow(ctx, "EXPLAIN (FORMAT JSON) "+sql, args...).Scan(&plan); e != nil {
		t.Fatal(e)
	}
	var nodes []struct{ Plan map[string]any }
	if e := json.Unmarshal(plan, &nodes); e != nil {
		t.Fatal(e)
	}
	found := map[string]bool{}
	var walk func(map[string]any)
	walk = func(n map[string]any) {
		if name, ok := n["Index Name"].(string); ok {
			found[name] = true
		}
		if children, ok := n["Plans"].([]any); ok {
			for _, c := range children {
				walk(c.(map[string]any))
			}
		}
	}
	walk(nodes[0].Plan)
	rows, e := db.Query(ctx, "EXPLAIN (COSTS OFF) "+sql, args...)
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	var text []string
	for rows.Next() {
		var line string
		if e = rows.Scan(&line); e != nil {
			t.Fatal(e)
		}
		text = append(text, line)
	}
	return found, strings.Join(text, "\n")
}

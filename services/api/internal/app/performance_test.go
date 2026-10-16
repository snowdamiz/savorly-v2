package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type queryCounter struct {
	mu      sync.Mutex
	queries []string
}

func (q *queryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.queries = append(q.queries, data.SQL)
	return ctx
}
func (*queryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}
func (q *queryCounter) take() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	queries := q.queries
	q.queries = nil
	return queries
}

func TestRecipeGroceriesConstantQueriesAndAtomicity(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "other")
	counter := &queryCounter{}
	config := db.Config()
	config.ConnConfig.Tracer = counter
	traced, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer traced.Close()
	a := &App{DB: traced}
	f := fiber.New()
	f.Post("/recipes/:id/groceries", func(c fiber.Ctx) error {
		c.Locals("userID", "cook")
		return a.recipeGroceries(c)
	})
	request := func(id string, servings int) (int, map[string]int) {
		t.Helper()
		req := httptest.NewRequest("POST", "/recipes/"+id+"/groceries", strings.NewReader(fmt.Sprintf(`{"servings":%d}`, servings)))
		req.Header.Set("Content-Type", "application/json")
		res, err := f.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var body map[string]int
		if res.StatusCode == 200 {
			if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
		}
		return res.StatusCode, body
	}
	for _, n := range []int{1, 20, 80} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			id := fmt.Sprintf("recipe-%d", n)
			r := validRecipe()
			r.Servings = 4
			r.Published = true
			r.Ingredients = nil
			for i := 0; i < n; i++ {
				r.Ingredients = append(r.Ingredients, Ingredient{Name: fmt.Sprintf("Ingredient %02d", i), Amount: float64(i+1) / 2, Unit: "g", Category: "Produce"})
			}
			if err := persistRecipe(ctx, db, "other", id, r, false); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(ctx, "DELETE FROM groceries"); err != nil {
				t.Fatal(err)
			}
			status, body := request(id, 6)
			queries := counter.take()
			if status != 200 || body["added"] != n {
				t.Fatalf("status=%d body=%v", status, body)
			}
			// Count real SQL calls, including BEGIN/COMMIT, rather than wall-clock timing.
			if len(queries) != 2 {
				t.Errorf("%d ingredients used %d SQL calls; want 2", n, len(queries))
			}
			t.Logf("%d ingredients: %d SQL calls", n, len(queries))
			rows, err := db.Query(ctx, `SELECT user_id,name,quantity,category,checked FROM groceries ORDER BY name`)
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			i := 0
			for rows.Next() {
				var owner, name, quantity, category string
				var checked bool
				if err := rows.Scan(&owner, &name, &quantity, &category, &checked); err != nil {
					t.Fatal(err)
				}
				if i >= n || owner != "cook" || name != r.Ingredients[i].Name || quantity != fmt.Sprintf("%g g", float64(i+1)*.75) || category != "Produce" || checked {
					t.Fatalf("incorrect grocery: %s %s %s %s %t", owner, name, quantity, category, checked)
				}
				i++
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			if i != n {
				t.Fatalf("got %d groceries, want %d", i, n)
			}
		})
	}
	// A failure halfway through must not leave a partially populated grocery list.
	r := validRecipe()
	r.Published = true
	r.Ingredients = []Ingredient{{Name: "Before"}, {Name: "Rejected"}, {Name: "After"}}
	if err := persistRecipe(ctx, db, "other", "recipe", r, false); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM groceries; ALTER TABLE groceries ADD CONSTRAINT reject_ingredient CHECK (name <> 'Rejected')`); err != nil {
		t.Fatal(err)
	}
	if status, _ := request("recipe", 6); status != 500 {
		t.Fatalf("failed insert status: %d", status)
	}
	var count int
	if err := db.QueryRow(ctx, "SELECT count(*) FROM groceries").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial groceries: %d %v", count, err)
	}
	if status, _ := request("recipe", 0); status != 400 {
		t.Fatalf("invalid servings status: %d", status)
	}
	if _, err := db.Exec(ctx, `UPDATE recipes SET published=false WHERE id='recipe'`); err != nil {
		t.Fatal(err)
	}
	if status, _ := request("recipe", 6); status != 404 {
		t.Fatalf("private recipe status: %d", status)
	}
	if status, _ := request("missing", 6); status != 404 {
		t.Fatalf("missing recipe status: %d", status)
	}
}

func TestSocialCountsUseSelectiveIndexes(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	testUser(t, db, "popular")
	for _, id := range []string{"target", "unrelated"} {
		if err := persistRecipe(ctx, db, "cook", id, validRecipe(), false); err != nil {
			t.Fatal(err)
		}
	}
	// Ten relevant rows among ten thousand unrelated ones, as on a growing site.
	_, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle)
	 SELECT 'reader-'||n,'reader-'||n||'@example.test','!disabled','Reader','reader-'||n FROM generate_series(1,10010) n;
	 INSERT INTO saves(user_id,recipe_id) SELECT id,CASE WHEN id IN (SELECT 'reader-'||n FROM generate_series(1,10) n) THEN 'target' ELSE 'unrelated' END FROM users WHERE id LIKE 'reader-%';
	 INSERT INTO follows(user_id,creator_id) SELECT user_id,CASE WHEN recipe_id='target' THEN 'cook' ELSE 'popular' END FROM saves;
	 ANALYZE saves; ANALYZE follows;`)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ table, column, id, index string }{
		{"saves", "recipe_id", "target", "saves_recipe_idx"},
		{"follows", "creator_id", "cook", "follows_creator_idx"},
	} {
		t.Run(tc.table, func(t *testing.T) {
			var count int
			query := fmt.Sprintf("SELECT count(*) FROM %s WHERE %s=$1", tc.table, tc.column)
			if err := db.QueryRow(ctx, query, tc.id).Scan(&count); err != nil || count != 10 {
				t.Fatalf("count=%d err=%v", count, err)
			}
			var plan []byte
			if err := db.QueryRow(ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+query, tc.id).Scan(&plan); err != nil {
				t.Fatal(err)
			}
			var result []struct{ Plan map[string]any }
			if err := json.Unmarshal(plan, &result); err != nil {
				t.Fatal(err)
			}
			var indexFound bool
			var scanned float64
			var inspect func(map[string]any)
			inspect = func(node map[string]any) {
				if node["Index Name"] == tc.index {
					indexFound = true
				}
				if node["Relation Name"] == tc.table {
					scanned += node["Actual Rows"].(float64)
					if removed, ok := node["Rows Removed by Filter"].(float64); ok {
						scanned += removed
					}
				}
				if children, ok := node["Plans"].([]any); ok {
					for _, child := range children {
						inspect(child.(map[string]any))
					}
				}
			}
			inspect(result[0].Plan)
			t.Logf("%s: %.0f rows visited for 10 matches", tc.table, scanned)
			if !indexFound || scanned > 10 {
				t.Fatalf("count scans unrelated rows: %s", plan)
			}
		})
	}
}

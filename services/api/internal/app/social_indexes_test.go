package app

import (
	"context"
	"testing"
)

// The social queries, and the counts every recipe carries, look up their few rows through an
// index among many unrelated ones, in the plans pgx's prepared statements use too.
func TestSocialQueriesUseIndexes(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	_, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle)
 SELECT 'u'||n,'u'||n||'@example.test','!disabled','Cook','u'||n FROM generate_series(1,2000) n;
INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps,published,derived_from,image)
 SELECT 'r'||n,'u'||(1+n%2000),'Dish '||n,'A dish for the plan test.','Italian',20,2,'Easy','[]','[]',n%10<>0,
  CASE WHEN n>2 THEN 'r'||(n/2) END,CASE WHEN n%3=0 THEN 'https://img.example/'||n||'.jpg' ELSE '' END FROM generate_series(1,20000) n;
INSERT INTO comments(id,recipe_id,user_id,body) SELECT 'c'||n,'r'||(1+n%10000),'u'||(1+n%2000),'Lovely' FROM generate_series(1,20000) n;
INSERT INTO cooks(id,user_id,recipe_id) SELECT 'k'||n,'u'||(1+n%2000),'r'||(1+n/2) FROM generate_series(0,19999) n;
INSERT INTO collections(id,user_id,name,public) SELECT 'b'||n,'u'||n,'Weeknights',n%10=0 FROM generate_series(1,2000) n;
INSERT INTO saves(user_id,recipe_id,collection_id) SELECT 'u'||(1+n%2000),'r'||(1+n),'b'||(1+n%2000) FROM generate_series(0,19999) n;
ANALYZE users; ANALYZE recipes; ANALYZE comments; ANALYZE cooks; ANALYZE collections; ANALYZE saves;`)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SET plan_cache_mode=force_generic_plan"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		sql     string
		args    []any
		indexes []string
	}{
		{"comments", commentsSQL, []any{"r5000", "", 50, 0}, []string{"comments_recipe_idx"}},
		{"cooks", cooksSQL, []any{"r5000", 30, 0}, []string{"cooks_recipe_idx"}},
		{"variations", variationsSQL, []any{"r5000"}, []string{"recipes_derived_from_idx"}},
		{"recipe counts", `SELECT ` + recipeJSON + recipeFrom + `WHERE r.id=$1`, []any{"r5000"}, []string{"recipes_derived_from_idx", "comments_recipe_idx", "cooks_recipe_idx"}},
		{"cookbook", cookbookSQL, []any{"b20", "", 60, 0}, []string{"saves_collection_idx"}},
		{"creator cookbooks", creatorCookbooksSQL, []any{"u20", 50, 0}, []string{"collections_public_idx", "saves_collection_idx"}},
		{"cooked ids", `SELECT jsonb_build_object(` + libraryIDs + `)`, []any{"u20"}, []string{"cooks_user_id_recipe_id_key"}},
	} {
		found, plan := planIndexes(t, conn, tc.sql, tc.args...)
		if _, err := conn.Exec(ctx, "PREPARE social_query AS "+tc.sql); err != nil {
			t.Fatal(err)
		}
		generic, genericPlan := planIndexes(t, conn, "EXECUTE social_query("+sqlLiterals(tc.args)+")")
		if _, err := conn.Exec(ctx, "DEALLOCATE social_query"); err != nil {
			t.Fatal(err)
		}
		for _, index := range tc.indexes {
			if !found[index] || !generic[index] {
				t.Errorf("%s doesn't use %s:\n%s\ngeneric:\n%s", tc.name, index, plan, genericPlan)
			}
		}
	}
	if _, err := conn.Exec(ctx, "RESET plan_cache_mode"); err != nil {
		t.Fatal(err)
	}
}

package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The food index (028_food_index.sql) as the database holds it: each recipe's ingredients read
// with the lexicon, each pantry item's keys, and each member's avoid list. Writes index what
// they save; indexFoods catches up with everything else.

// indexRecipeFood indexes one recipe from what is saved. A recipe changed in the meantime is
// left for the next write or pass, which reads the newer ingredients.
func indexRecipeFood(ctx context.Context, db recipeWriter, id string) error {
	var ingredients []Ingredient
	var language, source string
	e := db.QueryRow(ctx, `SELECT ingredients,language,food_source FROM recipes WHERE id=$1`, id).Scan(&ingredients, &language, &source)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	f := indexRecipe(ingredients, language)
	_, e = db.Exec(ctx, `UPDATE recipes SET ingredient_food=$2,ingredient_keys=$3,allergens=$4,food_terms=$5,food_version=$6,food_indexed=$7 WHERE id=$1 AND food_source=$7`,
		id, jsonBytes(f.Ingredients), f.Keys, f.Allergens, f.Terms, foodVersion, source)
	return e
}

// saveAvoid stores what a member avoids from their diets and allergies; nothing, no row.
func saveAvoid(ctx context.Context, db recipeWriter, user string, diets, allergies []string) error {
	v := avoidFor(diets, allergies)
	if len(v.Groups)+len(v.Terms) == 0 {
		_, e := db.Exec(ctx, `DELETE FROM food_avoid WHERE user_id=$1`, user)
		return e
	}
	_, e := db.Exec(ctx, `INSERT INTO food_avoid(user_id,avoid,groups,terms,food_version) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(user_id) DO UPDATE SET avoid=excluded.avoid,groups=excluded.groups,terms=excluded.terms,food_version=excluded.food_version`,
		user, jsonBytes(v), v.groupList(), v.termList(), foodVersion)
	return e
}

// avoidOf is what a member's kitchen avoids: theirs, and that of everyone in their household who
// shares their diets and allergies ({} for a guest or nobody). Suggestions, pantry matches and
// "fits" filters cook for the whole household.
func avoidOf(ctx context.Context, db recipeWriter, user string) (groups, terms []string, err error) {
	groups, terms = []string{}, []string{}
	if user == "" {
		return groups, terms, nil
	}
	err = db.QueryRow(ctx, `SELECT COALESCE(array_agg(DISTINCT g) FILTER (WHERE g IS NOT NULL),'{}'),COALESCE(array_agg(DISTINCT t) FILTER (WHERE t IS NOT NULL),'{}') FROM (
 SELECT unnest(f.groups) g,unnest(f.terms) t FROM food_avoid f
 WHERE f.user_id=$1 OR f.user_id IN (`+sharingHousemates+`)) x`, user).Scan(&groups, &terms)
	return groups, terms, err
}

// sharingHousemates is the ids of the other members of $1's household who share their diets and
// allergies with it.
const sharingHousemates = `SELECT o.user_id FROM household_members me JOIN household_members o ON o.household_id=me.household_id AND o.user_id<>me.user_id
 JOIN users ou ON ou.id=o.user_id AND ou.suspended_at IS NULL WHERE me.user_id=$1 AND (ou.preferences->>'shareDiet')::boolean IS TRUE`

// householdAvoidJSON is GET /me's householdAvoid: [{id, name, avoid}] for each housemate who
// shares their diets and allergies, so the app can say whose they are.
const householdAvoidJSON = `COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'avoid',f.avoid) ORDER BY x.name,x.id)
 FROM food_avoid f JOIN users x ON x.id=f.user_id WHERE f.user_id IN (` + sharingHousemates + `)),'[]')`

// memberLanguage is the language a member writes in, which reads German compounds; "" when
// they chose none.
func memberLanguage(ctx context.Context, db recipeWriter, user string) string {
	var language string
	_ = db.QueryRow(ctx, `SELECT COALESCE(preferences->>'language','') FROM users WHERE id=$1`, user).Scan(&language)
	return language
}

// indexBatch is how many rows one pass of indexFoods reads at a time.
const indexBatch = 200

// indexFoods brings recipes, pantry items and avoid lists up to the lexicon: those indexed
// under another foodVersion, never indexed, or (recipes) changed by a write that didn't index.
// Each row's work is its own statement, so a pass never holds a long transaction.
func indexFoods(ctx context.Context, db *pgxpool.Pool) (indexed int, err error) {
	for _, query := range []string{
		`SELECT id FROM recipes WHERE food_indexed<>food_source ORDER BY id LIMIT $1`,
		`SELECT id FROM recipes WHERE food_version<>` + strconv.Itoa(foodVersion) + ` ORDER BY id LIMIT $1`,
	} {
		// A row that can't be brought up to date (it changes under every pass) stops after a
		// few rounds rather than looping; the next pass takes it.
		for round := 0; round < 1000; round++ {
			ids, e := collectIDs(ctx, db, query, indexBatch)
			if e != nil {
				return indexed, e
			}
			for _, id := range ids {
				if e = indexRecipeFood(ctx, db, id); e != nil {
					return indexed, e
				}
			}
			indexed += len(ids)
			if len(ids) < indexBatch {
				break
			}
		}
	}
	for round := 0; round < 1000; round++ {
		rows, e := db.Query(ctx, `SELECT p.id,p.name,COALESCE(u.preferences->>'language','') FROM pantry p JOIN users u ON u.id=p.user_id WHERE p.food_version<>$2 ORDER BY p.id LIMIT $1`, indexBatch, foodVersion)
		if e != nil {
			return indexed, e
		}
		type item struct{ id, name, language string }
		var items []item
		for rows.Next() {
			var x item
			if e = rows.Scan(&x.id, &x.name, &x.language); e != nil {
				rows.Close()
				return indexed, e
			}
			items = append(items, x)
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			return indexed, e
		}
		for _, x := range items {
			if _, e = db.Exec(ctx, `UPDATE pantry SET food_keys=$2,food_version=$3 WHERE id=$1 AND name=$4`, x.id, pantryCovers(x.name, x.language), foodVersion, x.name); e != nil {
				return indexed, e
			}
		}
		indexed += len(items)
		if len(items) < indexBatch {
			break
		}
	}
	for round := 0; round < 1000; round++ {
		rows, e := db.Query(ctx, `SELECT u.id,u.preferences FROM users u LEFT JOIN food_avoid f ON f.user_id=u.id
 WHERE (f.user_id IS NOT NULL AND f.food_version<>$2) OR (f.user_id IS NULL AND (
  (jsonb_typeof(u.preferences->'diets')='array' AND jsonb_array_length(u.preferences->'diets')>0) OR
  (jsonb_typeof(u.preferences->'allergies')='array' AND jsonb_array_length(u.preferences->'allergies')>0)))
 ORDER BY u.id LIMIT $1`, indexBatch, foodVersion)
		if e != nil {
			return indexed, e
		}
		type member struct {
			id    string
			prefs []byte
		}
		var members []member
		for rows.Next() {
			var m member
			if e = rows.Scan(&m.id, &m.prefs); e != nil {
				rows.Close()
				return indexed, e
			}
			members = append(members, m)
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			return indexed, e
		}
		for _, m := range members {
			var p struct{ Diets, Allergies []string }
			_ = json.Unmarshal(m.prefs, &p)
			v := avoidFor(p.Diets, p.Allergies)
			// A member who avoids nothing keeps an up-to-date empty row, so the pass doesn't
			// pick them again; saveAvoid drops it when they next save their profile.
			if _, e = db.Exec(ctx, `INSERT INTO food_avoid(user_id,avoid,groups,terms,food_version) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(user_id) DO UPDATE SET avoid=excluded.avoid,groups=excluded.groups,terms=excluded.terms,food_version=excluded.food_version`,
				m.id, jsonBytes(v), v.groupList(), v.termList(), foodVersion); e != nil {
				return indexed, e
			}
		}
		indexed += len(members)
		if len(members) < indexBatch {
			break
		}
	}
	return indexed, nil
}

// RunFoodIndex indexes what needs it at start-up (after migrations and the seed), then every
// ten minutes, for any write that didn't index. Replicas may overlap; indexing is idempotent.
func RunFoodIndex(ctx context.Context, db *pgxpool.Pool) {
	for {
		if n, e := indexFoods(ctx, db); e != nil && ctx.Err() == nil {
			slog.Error("food index", "error", e)
		} else if n > 0 {
			slog.Info("food index", "indexed", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Minute):
		}
	}
}

// viewer is the member a public route is answering: the agent's owner, or the session's.
func (a *App) viewer(c fiber.Ctx) (string, error) {
	if id := userID(c); id != "" {
		return id, nil
	}
	return a.sessionUser(c)
}

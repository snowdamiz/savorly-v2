package app

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// recipeQuery is GET /recipes. Search matches each word as a prefix of a word in the title,
// cuisine and tags, ingredient names or description (weighted in that order), as written in
// any language or English-stemmed, ignoring case and accents; a misspelt title or ingredient
// still matches by trigram similarity. The vector, functions and indexes are in
// 015_search_and_indexes.sql.
type recipeQuery struct {
	Text, Cuisine, Author, Tag, Sort string
	// Follower limits the list to cooks this member follows.
	Follower string
	// AvoidGroups and AvoidTerms leave out recipes with any of them (a member's avoid list).
	AvoidGroups, AvoidTerms   []string
	MaxMinutes, Limit, Offset int
	// CookTested keeps only cook-tested recipes (cook_insights.go).
	CookTested bool
}

// searchWords splits a query into words of letters and digits; nothing else reaches to_tsquery.
func searchWords(q string) []string {
	words := strings.FieldsFunc(q, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && !unicode.Is(unicode.Mn, r)
	})
	if len(words) > 12 {
		words = words[:12]
	}
	return words
}

// Bayesian average for "Top rated": each recipe's reviews plus five at the site-wide mean, so
// one five-star review doesn't outrank a hundred 4.8s. The mean is computed once per query.
const (
	ratingPrior = `CROSS JOIN (SELECT COALESCE(avg(rating),0) AS mean FROM reviews) site `
	bayesRating = `(SELECT (COALESCE(sum(v.rating),0)+5*site.mean)/(count(*)+5) FROM reviews v WHERE v.recipe_id=r.id)`
)

// build returns the statement and its arguments. Filters are added only when set, so each
// stays indexable under a generic plan. ok is false when the text has nothing to search for.
func (q recipeQuery) build() (sql string, args []any, ok bool) {
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	where := []string{"r.published"}
	var rank, matched string
	if q.Text != "" {
		text := q.Text
		if utf8.RuneCountInString(text) > 200 {
			text = string([]rune(text)[:200])
		}
		words := searchWords(text)
		// The query terms are sub-selects so a cached generic plan computes them once, not per row.
		var arms, scores []string
		if len(words) > 0 {
			tsq := "(SELECT search_query(" + arg(words) + "::text[]))"
			matched = "r.search @@ " + tsq
			arms = append(arms, matched)
			scores = append(scores, "ts_rank(r.search,"+tsq+")")
		}
		// Trigram matching needs a few characters to be selective. A near miss in the title
		// ranks; one in an ingredient only matches.
		if utf8.RuneCountInString(strings.Join(words, "")) >= 3 {
			folded := "(SELECT search_fold(" + arg(text) + "::text))"
			arms = append(arms, "search_fold(r.title) %>> "+folded, "search_fold(recipe_ingredient_names(r.ingredients)) %>> "+folded)
			scores = append(scores, "0.5*strict_word_similarity("+folded+",search_fold(r.title))")
		}
		if len(arms) == 0 {
			return "", nil, false
		}
		where = append(where, "("+strings.Join(arms, " OR ")+")")
		rank = strings.Join(scores, "+")
	}
	if q.Cuisine != "" {
		where = append(where, "lower(r.cuisine)=lower("+arg(q.Cuisine)+")")
	}
	if q.Author != "" {
		where = append(where, "r.author_id="+arg(q.Author))
	}
	if q.Tag != "" {
		where = append(where, "r.tags@>ARRAY["+arg(q.Tag)+"::text]")
	}
	if q.MaxMinutes > 0 {
		where = append(where, "r.minutes<="+arg(q.MaxMinutes))
	}
	if q.Follower != "" {
		where = append(where, "r.author_id IN (SELECT creator_id FROM follows WHERE user_id="+arg(q.Follower)+")")
	}
	if q.CookTested {
		where = append(where, "r.id IN (SELECT recipe_id FROM recipe_cook_times WHERE cooks>="+arg(cookTestedCooks)+")")
	}
	if len(q.AvoidGroups) > 0 {
		where = append(where, "NOT r.allergens && "+arg(q.AvoidGroups)+"::text[]")
	}
	if len(q.AvoidTerms) > 0 {
		where = append(where, "NOT r.food_terms && "+arg(q.AvoidTerms)+"::text[]")
	}
	from := recipeFrom
	order := "r.created_at DESC,r.id"
	switch {
	case q.Sort == "Quickest":
		order = "r.minutes,r.id"
	case q.Sort == "Top rated":
		from += ratingPrior
		order = bayesRating + " DESC,r.created_at DESC,r.id"
	case rank != "":
		order = rank + " DESC," + order
	}
	// An explicit sort still lists exact matches before near misses.
	if matched != "" && (q.Sort == "Quickest" || q.Sort == "Top rated") {
		order = "(" + matched + ") DESC," + order
	}
	sql = `SELECT ` + recipeJSON + from + `WHERE ` + strings.Join(where, " AND ") + ` ORDER BY ` + order + ` LIMIT ` + arg(q.Limit) + ` OFFSET ` + arg(q.Offset)
	return sql, args, true
}

// cookQuery is GET /creators: the cooks who have published a recipe, most followed first, or
// with Everyone every member, those who have published first and then the newest, so someone who
// just joined can be found. Text matches each word as the start of a word in a member's name or
// handle, ignoring case and accents, and a misspelt name by trigram similarity; with Bio (the
// sous-chef's find_cooks) a bio's words match too, after the rest. A handle typed as it is comes
// first. Members are few beside recipes, so these read every row rather than keep indexes.
type cookQuery struct {
	Text          string
	Everyone, Bio bool
	Limit, Offset int
}

func (q cookQuery) build() (sql string, args []any, ok bool) {
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	where := []string{"u.suspended_at IS NULL"}
	order := "m.followers DESC,u.created_at,u.id"
	if q.Everyone {
		order = "m.published DESC,m.followers DESC,CASE WHEN m.published THEN u.created_at END,u.created_at DESC,u.id"
	} else {
		where = append(where, "m.published")
	}
	if q.Text != "" {
		text := q.Text
		if utf8.RuneCountInString(text) > 100 {
			text = string([]rune(text)[:100])
		}
		words := searchWords(text)
		var arms, ranks []string
		if len(words) > 0 {
			tsq := "(SELECT search_query(" + arg(words) + "::text[]))"
			named := "search_document(u.name||' '||u.handle) @@ " + tsq
			arms = append(arms, named)
			ranks = append(ranks, "("+named+") DESC")
			if q.Bio {
				arms = append(arms, "search_document(u.bio) @@ "+tsq)
			}
		}
		if utf8.RuneCountInString(strings.Join(words, "")) >= 3 {
			folded := "(SELECT search_fold(" + arg(text) + "::text))"
			arms = append(arms, "search_fold(u.name) %>> "+folded)
			ranks = append(ranks, "strict_word_similarity("+folded+",search_fold(u.name)) DESC")
		}
		if len(arms) == 0 {
			return "", nil, false
		}
		where = append(where, "("+strings.Join(arms, " OR ")+")")
		handle := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(text), "@"))
		order = "lower(u.handle)=" + arg(handle) + " DESC," + strings.Join(ranks, ",") + "," + order
	}
	sql = `SELECT ` + creatorJSON + ` FROM users u CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM recipes WHERE author_id=u.id AND published) AS published,(SELECT count(*) FROM follows WHERE creator_id=u.id) AS followers) m WHERE ` +
		strings.Join(where, " AND ") + ` ORDER BY ` + order + ` LIMIT ` + arg(q.Limit) + ` OFFSET ` + arg(q.Offset)
	return sql, args, true
}

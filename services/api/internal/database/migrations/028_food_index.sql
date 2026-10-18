-- What each recipe's ingredients are, read with the ingredient lexicon (food.go): every line's
-- key, allergen groups and terms, in order (ingredient_food, which the recipe page shows), and
-- the recipe's keys, groups and terms for pantry matching and search filters. food_source is
-- what an index is built from; a write that changes the ingredients or the language without
-- indexing them leaves food_indexed behind it, and the indexer catches up (indexFoods), as it
-- does for rows indexed under an older food_version.
ALTER TABLE recipes
  ADD COLUMN ingredient_food jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN ingredient_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN allergens text[] NOT NULL DEFAULT '{}',
  ADD COLUMN food_terms text[] NOT NULL DEFAULT '{}',
  ADD COLUMN food_version integer NOT NULL DEFAULT 0,
  ADD COLUMN food_indexed text NOT NULL DEFAULT '',
  ADD COLUMN food_source text GENERATED ALWAYS AS (md5(language || ingredients::text)) STORED;
CREATE INDEX recipes_allergens ON recipes USING gin(allergens);
CREATE INDEX recipes_food_terms ON recipes USING gin(food_terms);
CREATE INDEX recipes_ingredient_keys ON recipes USING gin(ingredient_keys);
CREATE INDEX recipes_food_stale ON recipes(id) WHERE food_indexed <> food_source;

-- What each pantry item lets a recipe skip: its key and what it is a kind of.
ALTER TABLE pantry
  ADD COLUMN food_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN food_version integer NOT NULL DEFAULT 0;

-- What each member avoids, read from the diets and allergies in their preferences: the groups
-- and terms filters use, and avoid ({"groups":{"peanut":["Peanuts"]},"terms":{…}}), which says
-- what they wrote for each so the app can say why. A table of its own, so indexing never
-- touches users.updated_at. Members who avoid nothing have no row.
CREATE TABLE food_avoid (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  avoid jsonb NOT NULL,
  groups text[] NOT NULL DEFAULT '{}',
  terms text[] NOT NULL DEFAULT '{}',
  food_version integer NOT NULL
);

-- A recipe's text in another of the app's languages, written by AI once and read by everyone who
-- reads the recipe in that language (translations.go): content is its title, description,
-- ingredient names and steps, {"title","description","ingredients":[{"name"}],"steps":[{"title","text"}]},
-- in the recipe's order. source_hash is a digest of the text it was made from, so an edited recipe
-- gets a fresh translation rather than one of different text. The janitor removes translations
-- nobody has read for 90 days; deleting the recipe removes its translations.
CREATE TABLE recipe_translations (
  recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  language text NOT NULL CHECK (language IN ('en','fr','de','ru','es','it','pt','zh','ja')),
  source_hash text NOT NULL,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipe_id, language)
);
CREATE INDEX recipe_translations_used ON recipe_translations(last_used_at);

-- Where recipes come from, comments, "I cooked this" and shared cookbooks (docs/API.md).

-- An imported recipe credits the page it came from; an adaptation keeps the recipe it adapts,
-- and only loses the link if that recipe is deleted.
ALTER TABLE recipes
  ADD COLUMN source_url text NOT NULL DEFAULT '' CHECK (char_length(source_url) <= 500),
  ADD COLUMN derived_from text REFERENCES recipes(id) ON DELETE SET NULL,
  ADD CONSTRAINT recipes_not_own_variation CHECK (derived_from <> id);
-- A recipe's variations, newest first; also what clearing the links of a deleted recipe uses.
CREATE INDEX recipes_derived_from_idx ON recipes(derived_from, created_at DESC) WHERE derived_from IS NOT NULL;

-- Comments on recipes, beyond the one review each. Replies are one level deep (a reply's parent
-- is always a top-level comment) and go with the comment they answer.
CREATE TABLE comments (
  id text PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id text REFERENCES comments(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_recipe_idx ON comments(recipe_id, created_at, id);
CREATE INDEX comments_parent_idx ON comments(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX comments_user_idx ON comments(user_id);
CREATE TRIGGER comments_touch BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- "I cooked this": one per member and recipe (cooking it again updates it), with an optional
-- photo and note.
CREATE TABLE cooks (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  photo text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, recipe_id)
);
CREATE INDEX cooks_recipe_idx ON cooks(recipe_id, created_at DESC);

-- Cookbooks stay private unless their owner shares them, which gives them a public page.
ALTER TABLE collections
  ADD COLUMN public boolean NOT NULL DEFAULT false,
  ADD COLUMN description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 300);
CREATE INDEX collections_public_idx ON collections(user_id) WHERE public;
-- A cookbook's recipes, newest saved first; deleting a cookbook clears its saves through it too.
CREATE INDEX saves_collection_idx ON saves(collection_id, created_at DESC) WHERE collection_id IS NOT NULL;

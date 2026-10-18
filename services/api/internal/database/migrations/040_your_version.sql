-- Your version of a recipe (your_version.go, docs/YOUR-VERSION.md): what a member changed in
-- someone else's recipe when they cooked it, so it opens their way next time, and kitchen notes,
-- facts about their kitchen and taste that apply to every recipe.

-- One change per member and part of a recipe, named as recipe_suggestions names parts (a step by
-- its text, an ingredient by its name). The recipe is never copied: changes apply over it as it
-- is, so its author's later fixes still arrive, and a change whose part changed since is the
-- member's to keep (on the part at its place now) or drop, never applied silently. said is what
-- the member said or typed ("I used half the chilli"); source is where it came from.
CREATE TABLE recipe_edits (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('time', 'heat', 'note', 'amount', 'swap')),
  part text NOT NULL CHECK (part IN ('step', 'ingredient')),
  target text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 200),
  place integer NOT NULL CHECK (place BETWEEN 1 AND 100),
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  said text NOT NULL DEFAULT '' CHECK (char_length(said) <= 500),
  source text NOT NULL DEFAULT 'typed' CHECK (source IN ('typed', 'cooking', 'sous_chef')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX recipe_edits_part ON recipe_edits(user_id, recipe_id, part, target);
CREATE INDEX recipe_edits_recipe ON recipe_edits(recipe_id);

-- "My oven runs hot", "we like it mild": short facts the sous-chef and hands-free answers use for
-- every recipe.
CREATE TABLE kitchen_notes (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note text NOT NULL CHECK (char_length(note) BETWEEN 2 AND 200),
  source text NOT NULL DEFAULT 'typed' CHECK (source IN ('typed', 'sous_chef')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kitchen_notes_user ON kitchen_notes(user_id, created_at);

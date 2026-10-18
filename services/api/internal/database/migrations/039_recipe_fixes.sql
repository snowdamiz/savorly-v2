-- Recipe fixes from cooks (docs/RECIPE-FIXES.md): changes a verified cook suggests to a recipe,
-- the cooks who say "same for me", and the versions accepting one writes, so its author can undo.

-- A change to one part of a recipe: a step (its text and timer), a step that's missing (after
-- the step named, or at the start), or an ingredient (its name, amount and unit). target names
-- that part as it was when suggested: a step by its text (cook_insights.go's cookStepKey), an
-- ingredient by its name, a missing step by the step it follows ('start' for none), so a recipe
-- that changed there since shows the suggestion as a note rather than applying it. before and
-- after are the part as it was and as the cook would have it. status: open until its author
-- answers; stale once it waited 30 days (it still shows, as a note); accepted, declined (with
-- response), withdrawn by the cook, or undone by the author after accepting.
CREATE TABLE recipe_suggestions (
  id text PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('time', 'heat', 'note', 'missing_step', 'amount', 'swap')),
  part text NOT NULL CHECK (part IN ('step', 'new_step', 'ingredient')),
  target text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 200),
  -- The part's 1-based place when suggested (a missing step: the step it follows, 0 for the start).
  place integer NOT NULL CHECK (place BETWEEN 0 AND 100),
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'stale', 'accepted', 'declined', 'withdrawn', 'undone')),
  response text NOT NULL DEFAULT '' CHECK (char_length(response) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
-- One suggestion waiting per cook and part of a recipe.
CREATE UNIQUE INDEX recipe_suggestions_waiting ON recipe_suggestions(recipe_id, user_id, part, target) WHERE status IN ('open', 'stale');
CREATE INDEX recipe_suggestions_recipe ON recipe_suggestions(recipe_id, status, created_at);
CREATE INDEX recipe_suggestions_user ON recipe_suggestions(user_id, created_at);
CREATE INDEX recipe_suggestions_open_age ON recipe_suggestions(created_at) WHERE status = 'open';

-- "Same for me": another verified cook of the recipe agreeing with a suggestion.
CREATE TABLE recipe_suggestion_votes (
  suggestion_id text NOT NULL REFERENCES recipe_suggestions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (suggestion_id, user_id)
);
CREATE INDEX recipe_suggestion_votes_user ON recipe_suggestion_votes(user_id);

-- What accepting a suggestion changed: the recipe's ingredients and steps before and after, in
-- order (number), so the author can undo it while nothing else changed since.
CREATE TABLE recipe_versions (
  id text PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  suggestion_id text REFERENCES recipe_suggestions(id) ON DELETE SET NULL,
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  UNIQUE (recipe_id, number)
);
CREATE INDEX recipe_versions_suggestion ON recipe_versions(suggestion_id) WHERE suggestion_id IS NOT NULL;

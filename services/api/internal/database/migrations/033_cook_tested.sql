-- Cook-tested recipes (docs/COOK-TESTED.md): what cooking mode records about each step, the
-- questions cooks ask while cooking, and what a nightly pass makes of them for each recipe.

-- events counts a session's step events (at most cookEventsPerSession). A session that didn't
-- become a verified cook is kept for the insights window when it has some, since where cooks give
-- up is part of what the recipe shows its author; without any it goes after two days as before.
ALTER TABLE cook_sessions ADD COLUMN events integer NOT NULL DEFAULT 0 CHECK (events >= 0);
-- A recipe's sessions newest first, for its insights.
CREATE INDEX cook_sessions_recipe_started_idx ON cook_sessions(recipe_id, started_at DESC) WHERE events > 0;

-- One moment of a cook session: a step entered or left, or its timer started, paused or run out.
-- step is 1-based; step_key names the step by its text (cookStepKey), so an edited step starts
-- fresh. at_ms is the app's clock in milliseconds: only differences within one session are used,
-- so a phone whose clock is off doesn't matter. seq is the app's own count of the session's
-- events, so a retried request adds nothing twice.
CREATE TABLE cook_step_events (
  session_id text NOT NULL REFERENCES cook_sessions(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq BETWEEN 0 AND 100000),
  kind text NOT NULL CHECK (kind IN ('enter', 'leave', 'timer_start', 'timer_pause', 'timer_end')),
  step integer NOT NULL CHECK (step BETWEEN 1 AND 100),
  step_key text NOT NULL CHECK (step_key ~ '^[0-9a-f]{16}$'),
  at_ms bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX cook_step_events_created_idx ON cook_step_events(created_at);

-- A question cooks keep asking at a step, reworded so that no cook's own words show, with its
-- answer: the sous-chef's, until the recipe's author edits or approves it (answered_by 'author').
-- The author can hide one. It shows on the recipe while at least 3 cooks asked it in the last
-- 90 days, which is as long as their questions are kept.
CREATE TABLE recipe_step_questions (
  id text PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  step_key text NOT NULL CHECK (step_key ~ '^[0-9a-f]{16}$'),
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 300),
  answer text NOT NULL DEFAULT '' CHECK (char_length(answer) <= 1000),
  answered_by text NOT NULL DEFAULT 'ai' CHECK (answered_by IN ('ai', 'author')),
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recipe_step_questions_recipe_idx ON recipe_step_questions(recipe_id, step_key);

-- What a cook asked at a step, hands-free or of the sous-chef, kept 90 days. cluster_id is the
-- question it was grouped into; clustered_at is when the nightly pass read it, grouped or not, so
-- nothing is sent to the model twice.
CREATE TABLE cook_questions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  step integer NOT NULL CHECK (step BETWEEN 1 AND 100),
  step_key text NOT NULL CHECK (step_key ~ '^[0-9a-f]{16}$'),
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
  source text NOT NULL CHECK (source IN ('hands_free', 'sous_chef')),
  cluster_id text REFERENCES recipe_step_questions(id) ON DELETE SET NULL,
  clustered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cook_questions_recipe_idx ON cook_questions(recipe_id, step_key, created_at);
CREATE INDEX cook_questions_unread_idx ON cook_questions(recipe_id) WHERE clustered_at IS NULL;
CREATE INDEX cook_questions_cluster_idx ON cook_questions(cluster_id) WHERE cluster_id IS NOT NULL;
CREATE INDEX cook_questions_created_idx ON cook_questions(created_at);
CREATE INDEX cook_questions_user_idx ON cook_questions(user_id, created_at);

-- How each step of a recipe really goes, from its latest sessions (cookInsightSample) in the
-- insights window: how many sessions spent usable time on it, their median and 75th percentile,
-- how many sessions that are over reached it (entered) and how many of those it was the last
-- step of without finishing (gave_up), and how many started its timer.
CREATE TABLE recipe_step_stats (
  recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  step_key text NOT NULL CHECK (step_key ~ '^[0-9a-f]{16}$'),
  sessions integer NOT NULL CHECK (sessions >= 0),
  median_seconds integer NOT NULL CHECK (median_seconds >= 0),
  p75_seconds integer NOT NULL CHECK (p75_seconds >= 0),
  entered integer NOT NULL CHECK (entered >= 0),
  gave_up integer NOT NULL CHECK (gave_up >= 0),
  timer_starts integer NOT NULL DEFAULT 0 CHECK (timer_starts >= 0),
  PRIMARY KEY (recipe_id, step_key)
);

-- The whole recipe's side: sessions that are over (finished, or a day old) and how many of them
-- finished, for "Finished by 9 in 10 who started".
CREATE TABLE recipe_insights (
  recipe_id text PRIMARY KEY REFERENCES recipes(id) ON DELETE CASCADE,
  sessions integer NOT NULL CHECK (sessions >= 0),
  finished integer NOT NULL CHECK (finished >= 0),
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- Recipes with something new for the nightly pass: step events or questions since it last read
-- them, or sessions still under way then.
CREATE TABLE recipe_insights_due (
  recipe_id text PRIMARY KEY REFERENCES recipes(id) ON DELETE CASCADE,
  since timestamptz NOT NULL DEFAULT now()
);

-- One nightly pass a UTC day: its row is written when the pass starts, under a lock, so a second
-- replica or a restart finds it and does nothing.
CREATE TABLE cook_insight_runs (
  day date PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  recipes integer NOT NULL DEFAULT 0,
  clustered integer NOT NULL DEFAULT 0
);

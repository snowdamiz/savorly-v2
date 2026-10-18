-- The whole-meal timeline (meal_timeline.go, docs/MEAL-TIMELINE.md): two to four recipes turned
-- into one timed plan, and cooked together.

-- How each step spends its time, as the server estimates it for steps whose cook didn't say
-- (step_timing.go): by step key (cook_insights.go's cookStepKey), the hands-on and waiting
-- seconds, the oven's heat and the burners, and where the estimate came from ("text", read from
-- the step; "guess", from the recipe's time; "model", the cheap model's). timing_source is what
-- the estimate reads (the steps, the language and the recipe's minutes): a write that changes it
-- leaves timing_indexed behind, and the index catches up, as it does for rows read under an older
-- timing_version. timing_guessed marks recipes with a guess the model may improve, and
-- timing_asked the source it was last asked about, so it's asked once a version.
ALTER TABLE recipes
  ADD COLUMN step_timing jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN timing_version integer NOT NULL DEFAULT 0,
  ADD COLUMN timing_indexed text NOT NULL DEFAULT '',
  ADD COLUMN timing_guessed boolean NOT NULL DEFAULT false,
  ADD COLUMN timing_asked text NOT NULL DEFAULT '',
  ADD COLUMN timing_source text GENERATED ALWAYS AS (md5(language || minutes::text || steps::text)) STORED;
CREATE INDEX recipes_timing_stale ON recipes(id) WHERE timing_indexed <> timing_source;
CREATE INDEX recipes_timing_guessed ON recipes(id) WHERE timing_guessed AND timing_asked <> timing_source;

-- A meal cooked together keeps one cook session per dish, as cooking one recipe does, linked by
-- the meal they were cooked in.
ALTER TABLE cook_sessions ADD COLUMN meal_id text;
CREATE INDEX cook_sessions_meal ON cook_sessions(meal_id) WHERE meal_id IS NOT NULL;

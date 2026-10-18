-- AI clips of a recipe's steps (step_clips_ai.go). A clip job is an ai_jobs row of kind 'clip';
-- step_clip_jobs says which recipe it's for and the text of the step it shows, which is how a
-- finished clip finds its step even after the steps were reordered; step is where it was, from
-- 0, when its clip was ordered. batch is the request's
-- Idempotency-Key, so asking again answers what was ordered. applied marks a clip that was put
-- on its step, or dropped because the step changed or got a clip of its own meanwhile.
ALTER TABLE ai_jobs DROP CONSTRAINT ai_jobs_kind_check,
  ADD CONSTRAINT ai_jobs_kind_check CHECK (kind IN ('recipe','adapt','substitute','nutrition','plan','assistant','image','video','clip'));
CREATE TABLE step_clip_jobs (
  job_id text PRIMARY KEY REFERENCES ai_jobs(id) ON DELETE CASCADE,
  recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  step_text text NOT NULL,
  step integer NOT NULL,
  batch text NOT NULL,
  applied boolean NOT NULL DEFAULT false
);
CREATE INDEX step_clip_jobs_recipe ON step_clip_jobs(recipe_id);
CREATE INDEX step_clip_jobs_batch ON step_clip_jobs(batch);
CREATE INDEX step_clip_jobs_waiting ON step_clip_jobs(job_id) WHERE NOT applied;

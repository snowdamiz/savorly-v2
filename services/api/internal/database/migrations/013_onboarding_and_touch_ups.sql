-- New kitchens walk through a short setup (photo, name, username, tastes, cooks to follow) until
-- they finish or skip it. Everyone who joined before the setup existed counts as set up.
ALTER TABLE users ADD COLUMN onboarded_at timestamptz;
UPDATE users SET onboarded_at = created_at;

-- A touch-up is an AI photo made from one the member already has; the job keeps where it started.
ALTER TABLE ai_jobs ADD COLUMN source text NOT NULL DEFAULT '';

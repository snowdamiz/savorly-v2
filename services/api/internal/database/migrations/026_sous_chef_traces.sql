-- What each sous-chef turn did, for the admin console: the model, how long each round took
-- and what it cost, and each tool it called with its time and any error. It never holds the
-- conversation or tool arguments. started_at is when a worker took the turn.
ALTER TABLE voice_actions ADD COLUMN trace jsonb NOT NULL DEFAULT '{}', ADD COLUMN started_at timestamptz;
-- The console lists turns newest first; by status, voice_actions_queue already serves it.
CREATE INDEX voice_actions_recent ON voice_actions(created_at DESC, id);

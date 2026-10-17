-- A deleted conversation loses its content at once but keeps a shell (its turns and voice
-- sessions, which carry spend and allowance use) until a purge 35 days later, past the 30-day
-- accounting window.
ALTER TABLE voice_projects ADD COLUMN deleted_at timestamptz;
CREATE INDEX voice_projects_deleted ON voice_projects(deleted_at) WHERE deleted_at IS NOT NULL;
-- The stale-session sweep finalizes every session left unfinalized once its heartbeat stops,
-- including one whose server lost it without being able to end it.
DROP INDEX IF EXISTS voice_sessions_open;
CREATE INDEX voice_sessions_unfinalized ON voice_sessions(heartbeat_at) WHERE NOT finalized;

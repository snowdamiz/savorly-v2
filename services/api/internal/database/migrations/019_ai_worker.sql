-- Conversations are polled, deleted (cascading) and pruned by project, and photo caps count a
-- member's private recipe photos by conversation; these tables had no index for it.
CREATE INDEX IF NOT EXISTS voice_sources_project ON voice_sources(project_id);
CREATE INDEX IF NOT EXISTS voice_actions_project ON voice_actions(project_id, created_at);
CREATE INDEX IF NOT EXISTS voice_sessions_project ON voice_sessions(project_id, created_at);
-- The worker's sweep for voice sessions whose server stopped reporting. 'closing' sessions
-- were asked to end and no longer hold the member's one voice slot.
CREATE INDEX IF NOT EXISTS voice_sessions_open ON voice_sessions(heartbeat_at) WHERE status IN ('connecting','active','closing');

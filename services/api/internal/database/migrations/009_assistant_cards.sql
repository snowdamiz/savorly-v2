-- Recipe cards the assistant chose to show with a reply.
ALTER TABLE voice_events ADD COLUMN recipes jsonb NOT NULL DEFAULT '[]';

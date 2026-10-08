-- What the user has open and their time zone, plus one action awaiting their yes.
ALTER TABLE voice_projects ADD COLUMN context jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN pending jsonb,
  ADD COLUMN pending_seq bigint NOT NULL DEFAULT 0;
-- Things the assistant does on the user's screen when its reply arrives.
ALTER TABLE voice_events ADD COLUMN actions jsonb NOT NULL DEFAULT '[]';

-- What a reply's turn did to the member's data, for the app's receipts, and how to take back
-- what can be (kept on the server).
ALTER TABLE voice_events ADD COLUMN effects jsonb NOT NULL DEFAULT '[]';
-- What a running turn is doing now, and whether the member asked to stop it.
ALTER TABLE voice_actions ADD COLUMN progress text NOT NULL DEFAULT '',
  ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;

-- A reply says whether its turn changed the member's data, so the app refreshes only then.
ALTER TABLE voice_events ADD COLUMN changed boolean NOT NULL DEFAULT false;
-- An answer the member tapped in the app ('yes' or 'no') to the action waiting at answer_seq.
-- The server carries it out, or drops it, itself rather than leaving the answer to the model.
ALTER TABLE voice_actions ADD COLUMN answer text NOT NULL DEFAULT '' CHECK (answer IN ('', 'yes', 'no')),
  ADD COLUMN answer_seq bigint NOT NULL DEFAULT 0;

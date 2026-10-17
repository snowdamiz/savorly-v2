-- Sessions slide forward while in use and are listed per device in My kitchen. public_id names
-- a session in the API without revealing its token hash; last_used_at is written at most every
-- few minutes, so reads don't turn into writes.
ALTER TABLE sessions
  ADD COLUMN public_id text NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN last_used_at timestamptz,
  ADD COLUMN user_agent text NOT NULL DEFAULT '';
UPDATE sessions SET last_used_at = created_at;
ALTER TABLE sessions ALTER COLUMN last_used_at SET NOT NULL, ALTER COLUMN last_used_at SET DEFAULT now();
CREATE UNIQUE INDEX sessions_public_id ON sessions(public_id);

-- Six-digit codes mailed to prove an address: 'verify' for the account's own email, 'change'
-- for the address it is moving to. One live code per purpose; a new one replaces it.
CREATE TABLE email_codes (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify','change')),
  email text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, purpose)
);

-- Single-use links that let a native app download its data export in the browser.
CREATE TABLE export_tokens (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX export_tokens_user ON export_tokens(user_id);

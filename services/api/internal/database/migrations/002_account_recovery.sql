CREATE TABLE password_resets (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 code_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL
);

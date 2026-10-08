-- Subscriptions are bought on the web through Stripe; the app only reads the result.
ALTER TABLE users
  ADD COLUMN plan text NOT NULL DEFAULT 'free',
  ADD COLUMN plan_status text NOT NULL DEFAULT '',
  ADD COLUMN plan_interval text NOT NULL DEFAULT '',
  ADD COLUMN plan_renews_at timestamptz,
  ADD COLUMN plan_cancels boolean NOT NULL DEFAULT false,
  ADD COLUMN stripe_customer_id text UNIQUE,
  ADD COLUMN stripe_subscription_id text NOT NULL DEFAULT '',
  -- Proven by a reset code or a provider's verified email; registration alone proves nothing.
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false;

-- Sign in with Apple / Google. The provider's subject identifies the person, not the email.
CREATE TABLE identities (
  provider text NOT NULL CHECK (provider IN ('apple','google')),
  subject text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL DEFAULT '',
  -- Apple only: revoking the app's access on account deletion needs the refresh token
  -- and the client it was issued to (the bundle ID natively, the Services ID on the web).
  refresh_token text NOT NULL DEFAULT '',
  client_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);
-- Single-use nonces bind each provider token to a sign-in this server started.
CREATE TABLE auth_nonces (hash text PRIMARY KEY, expires_at timestamptz NOT NULL);

-- Every AI cost in one place, for per-user plan ceilings and the shared free budget.
CREATE VIEW ai_spend AS
  SELECT user_id, estimated_cost::float8 AS cost, created_at FROM ai_jobs
  UNION ALL
  SELECT p.user_id, a.estimated_cost::float8, a.created_at FROM voice_actions a JOIN voice_projects p ON p.id = a.project_id
  UNION ALL
  SELECT user_id, estimated_cost::float8, created_at FROM narration_usage
  UNION ALL
  SELECT user_id, (CASE WHEN status IN ('connecting','active') OR NOT finalized THEN reserved_seconds ELSE greatest(seconds, 15) END) * 0.05 / 60, created_at
  FROM voice_sessions WHERE reserved_seconds > 0;
CREATE INDEX ai_jobs_user_created ON ai_jobs(user_id, created_at);
CREATE INDEX voice_sessions_user_created ON voice_sessions(user_id, created_at);
CREATE INDEX narration_usage_user_created ON narration_usage(user_id, created_at);

-- Owners are listed in ADMIN_EMAILS; this flag records the admins they appoint.
-- A suspended member can't sign in, and their recipes and profile leave public view.
ALTER TABLE users
  ADD COLUMN admin boolean NOT NULL DEFAULT false,
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN suspended_reason text NOT NULL DEFAULT '';
CREATE INDEX users_created ON users(created_at DESC);

-- Reports stay open until an admin acts; reporting the same recipe again reopens one.
ALTER TABLE reports
  ADD COLUMN status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  ADD COLUMN resolution text NOT NULL DEFAULT '',
  ADD COLUMN resolved_by text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN resolved_at timestamptz;
CREATE INDEX reports_open ON reports(recipe_id) WHERE status = 'open';

-- Every admin action, kept after the admin or what they acted on is gone.
CREATE TABLE admin_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id text REFERENCES users(id) ON DELETE SET NULL,
  admin_email text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_actions_created ON admin_actions(created_at DESC);
CREATE INDEX admin_actions_target ON admin_actions(target_type, target_id);

-- Operator overrides that apply without a redeploy (the admin console's Settings).
CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

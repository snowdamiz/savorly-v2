-- Small AI calls that are neither jobs, sous-chef turns, narration nor voice: a recipe's
-- translation (shared by every reader, so user_id is the member who asked first, or NULL) and a
-- question asked hands-free in cooking mode. kind names the feature; each row is a reservation,
-- settled to the provider's reported cost when the call ends. ai_spend counts every row toward
-- the member's 30 days and the day's budgets; rows without a member count as free use.
CREATE TABLE ai_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,40}$'),
  estimated_cost numeric NOT NULL CHECK (estimated_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_created ON ai_usage(created_at);
CREATE INDEX ai_usage_user_kind ON ai_usage(user_id, kind, created_at);

CREATE OR REPLACE VIEW ai_spend AS
  SELECT user_id, estimated_cost::float8 AS cost, created_at FROM ai_jobs
  UNION ALL
  SELECT p.user_id, a.estimated_cost::float8, a.created_at FROM voice_actions a JOIN voice_projects p ON p.id = a.project_id
  UNION ALL
  SELECT user_id, estimated_cost::float8, created_at FROM narration_usage
  UNION ALL
  SELECT user_id, (CASE WHEN status IN ('connecting','active') OR NOT finalized THEN reserved_seconds ELSE greatest(seconds, 15) END) * 0.05 / 60, created_at
  FROM voice_sessions WHERE reserved_seconds > 0
  UNION ALL
  SELECT user_id, estimated_cost::float8, created_at FROM ai_usage;

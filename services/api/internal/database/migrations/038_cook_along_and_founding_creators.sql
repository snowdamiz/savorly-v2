-- Getting the first cooks and creators (docs/CREATOR-FUND.md, docs/ADMIN.md): founding creators,
-- the weekly cook-along and its notification, when members start and stop paying (for the
-- console's month-3 retention), and indexes for the console's cooking metrics.

-- A founding creator, marked by an admin: their profile and their recipes' author lines say so,
-- and they take turns in the weekly cook-along. NULL for everyone else.
ALTER TABLE users ADD COLUMN founding_creator_at timestamptz;
CREATE INDEX users_founding_creator_idx ON users(founding_creator_at) WHERE founding_creator_at IS NOT NULL;

-- The weekly cook-along: one recipe a week, Monday to Sunday in UTC, featured on Home and
-- announced once. creator_id is the recipe's author when it was scheduled, which is how founding
-- creators take turns. A deleted recipe leaves its week empty rather than forgetting whose turn it
-- was. automatic marks a week the rotation filled because no admin scheduled it.
CREATE TABLE cook_alongs (
  week date PRIMARY KEY CHECK (extract(isodow FROM week) = 1),
  recipe_id text REFERENCES recipes(id) ON DELETE SET NULL,
  creator_id text REFERENCES users(id) ON DELETE SET NULL,
  scheduled_by text REFERENCES users(id) ON DELETE SET NULL,
  automatic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cook_alongs_recipe_idx ON cook_alongs(recipe_id);
CREATE INDEX cook_alongs_creator_idx ON cook_alongs(creator_id, week);
CREATE INDEX cook_alongs_scheduled_by_idx ON cook_alongs(scheduled_by);

-- The cook-along's notification is a kind of its own. Other migrations may have added kinds since
-- 022_review_replies.sql, so this adds 'cookalong' to whatever the check allows rather than
-- writing the list out again.
DO $$
DECLARE
  kinds text;
BEGIN
  SELECT string_agg(quote_literal(k), ',' ORDER BY k) INTO kinds FROM (
    SELECT (regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g'))[1] AS k
    FROM pg_constraint c WHERE c.conrelid = 'notification_outbox'::regclass AND c.conname = 'notification_outbox_kind_check'
    UNION SELECT 'cookalong') x;
  EXECUTE 'ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check, '
    || 'ADD CONSTRAINT notification_outbox_kind_check CHECK (kind IN (' || kinds || '))';
END $$;

-- When each member paid: a span opens when their plan starts bringing revenue (or is past due,
-- which Stripe is still retrying) and closes when it stops. A trigger keeps it, so every writer
-- (the billing webhook, an admin) is covered. Members already paying when this was added have a
-- span without a start, since when they began is unknown; month-3 retention leaves them out.
CREATE TABLE paid_spans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz
);
CREATE UNIQUE INDEX paid_spans_open ON paid_spans(user_id) WHERE ended_at IS NULL;
CREATE INDEX paid_spans_user ON paid_spans(user_id, started_at);
INSERT INTO paid_spans(user_id, started_at)
SELECT id, NULL FROM users WHERE plan <> 'free' AND plan_status IN ('active', 'past_due') AND plan_interval <> '';
CREATE FUNCTION track_paid_span() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan <> 'free' AND NEW.plan_status IN ('active', 'past_due') AND NEW.plan_interval <> '' THEN
    INSERT INTO paid_spans(user_id) VALUES (NEW.id) ON CONFLICT (user_id) WHERE ended_at IS NULL DO NOTHING;
  ELSE
    UPDATE paid_spans SET ended_at = now() WHERE user_id = NEW.id AND ended_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER paid_span_started AFTER INSERT ON users FOR EACH ROW
  WHEN (NEW.plan <> 'free') EXECUTE FUNCTION track_paid_span();
CREATE TRIGGER paid_span_changed AFTER UPDATE OF plan, plan_status, plan_interval ON users FOR EACH ROW
  WHEN (OLD.plan IS DISTINCT FROM NEW.plan OR OLD.plan_status IS DISTINCT FROM NEW.plan_status OR OLD.plan_interval IS DISTINCT FROM NEW.plan_interval)
  EXECUTE FUNCTION track_paid_span();

-- The console's cooking metrics: sessions started in a window (the finish rate), and members who
-- started a recipe in a week (the cook-along).
CREATE INDEX cook_sessions_started_idx ON cook_sessions(started_at);
CREATE INDEX cook_sessions_recipe_week_idx ON cook_sessions(recipe_id, started_at);

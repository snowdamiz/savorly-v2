-- Households share one grocery list. A member belongs to at most one household; when the owner
-- leaves, the longest-standing member takes over, and the last one out dissolves it (the trigger
-- below, so deleting an account follows the same rules).
CREATE TABLE households (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE household_members (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX household_members_household ON household_members(household_id, joined_at);
CREATE UNIQUE INDEX household_members_one_owner ON household_members(household_id) WHERE role = 'owner';
-- Invite codes are kept only as hashes, and each works until it expires.
CREATE TABLE household_invites (
  code_hash text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX household_invites_household ON household_invites(household_id, created_at);
CREATE INDEX household_invites_expires ON household_invites(expires_at);
-- A household's grocery lines carry its id; user_id stays the member who added the line.
ALTER TABLE groceries ADD COLUMN household_id text REFERENCES households(id) ON DELETE CASCADE;
CREATE INDEX groceries_household_idx ON groceries(household_id) WHERE household_id IS NOT NULL;
CREATE FUNCTION household_member_left() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM household_members WHERE household_id = OLD.household_id) THEN
    DELETE FROM households WHERE id = OLD.household_id;
  ELSIF NOT EXISTS (SELECT 1 FROM household_members WHERE household_id = OLD.household_id AND role = 'owner') THEN
    UPDATE household_members SET role = 'owner' WHERE user_id = (
      SELECT user_id FROM household_members WHERE household_id = OLD.household_id ORDER BY joined_at, user_id LIMIT 1);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER household_member_left AFTER DELETE ON household_members FOR EACH ROW EXECUTE FUNCTION household_member_left();

-- Expo push tokens, one row per device. A token moves to whoever registers it last, and belongs
-- to the session that registered it: signing out, or the session ending, stops its notifications.
CREATE TABLE push_tokens (
  token text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash text REFERENCES sessions(token_hash) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_user ON push_tokens(user_id);
CREATE INDEX push_tokens_session ON push_tokens(session_hash);
-- What is worth a notification, written by triggers so that every writer is covered. The sender
-- (notifications_outbox.go) turns each row into one message per recipient device.
CREATE TABLE notification_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('publish','review','comment','pantry')),
  actor_id text REFERENCES users(id) ON DELETE CASCADE,
  recipient_id text REFERENCES users(id) ON DELETE CASCADE,
  recipe_id text REFERENCES recipes(id) ON DELETE CASCADE,
  ref_id text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX notification_outbox_pending ON notification_outbox(id) WHERE processed_at IS NULL;
CREATE INDEX notification_outbox_recipe ON notification_outbox(recipe_id, actor_id, created_at);
CREATE INDEX notification_outbox_actor ON notification_outbox(actor_id);
CREATE INDEX notification_outbox_recipient ON notification_outbox(recipient_id);
CREATE INDEX notification_outbox_created ON notification_outbox(created_at);
-- One message per recipient device. A row is claimed ('sending') before it goes to Expo, so no
-- two senders send it; one left claimed by a stopped server fails instead of going out twice.
CREATE TABLE push_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbox_id bigint NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  ticket_id text NOT NULL DEFAULT '',
  receipt_checked boolean NOT NULL DEFAULT false,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_id, token)
);
CREATE INDEX push_messages_due ON push_messages(next_attempt_at) WHERE status = 'queued';
CREATE INDEX push_messages_claimed ON push_messages(claimed_at) WHERE status = 'sending';
CREATE INDEX push_messages_receipts ON push_messages(sent_at) WHERE status = 'sent' AND NOT receipt_checked AND ticket_id <> '';
CREATE INDEX push_messages_user ON push_messages(user_id);
CREATE INDEX push_messages_created ON push_messages(created_at);
-- A recipe is announced to its author's followers once, the first time it is published.
-- Recipes that have been public before (they were saved, reviewed, planned or reported, or an
-- admin holds them) count as announced already.
CREATE TABLE recipe_announcements (
  recipe_id text PRIMARY KEY REFERENCES recipes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO recipe_announcements(recipe_id)
SELECT id FROM recipes WHERE published OR unpublished_by_admin_at IS NOT NULL
UNION SELECT recipe_id FROM saves
UNION SELECT recipe_id FROM reviews
UNION SELECT recipe_id FROM meal_plans
UNION SELECT recipe_id FROM reports;
CREATE FUNCTION announce_recipe() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  added integer;
BEGIN
  INSERT INTO recipe_announcements(recipe_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  IF added > 0 THEN
    INSERT INTO notification_outbox(kind, actor_id, recipe_id) VALUES ('publish', NEW.author_id, NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER recipe_published AFTER INSERT ON recipes FOR EACH ROW WHEN (NEW.published) EXECUTE FUNCTION announce_recipe();
CREATE TRIGGER recipe_republished AFTER UPDATE OF published ON recipes FOR EACH ROW
  WHEN (NEW.published AND NOT OLD.published) EXECUTE FUNCTION announce_recipe();
-- A review tells the recipe's author, at most once a day per reviewer and recipe, however often
-- a review is deleted and written again. Editing a review is an update and tells no one.
CREATE FUNCTION announce_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM recipes WHERE id = NEW.recipe_id AND author_id = NEW.user_id)
    OR EXISTS (SELECT 1 FROM notification_outbox WHERE recipe_id = NEW.recipe_id AND actor_id = NEW.user_id AND kind = 'review' AND created_at > now() - interval '1 day') THEN
    RETURN NULL;
  END IF;
  INSERT INTO notification_outbox(kind, actor_id, recipe_id, ref_id, detail)
  VALUES ('review', NEW.user_id, NEW.recipe_id, NEW.id, jsonb_build_object('rating', NEW.rating, 'text', left(NEW.body, 200)));
  RETURN NULL;
END $$;
CREATE TRIGGER review_written AFTER INSERT ON reviews FOR EACH ROW EXECUTE FUNCTION announce_review();
-- Withdrawn before the sender got to it, a review or comment tells no one. Like a sent row, a
-- withdrawn one keeps no text.
CREATE FUNCTION withdraw_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE notification_outbox SET processed_at = now(), detail = '{}'
  WHERE processed_at IS NULL AND kind = TG_ARGV[0] AND ref_id = to_jsonb(OLD)->>'id';
  RETURN NULL;
END $$;
CREATE TRIGGER review_withdrawn AFTER DELETE ON reviews FOR EACH ROW EXECUTE FUNCTION withdraw_notice('review');
-- A comment tells the recipe's author, at most once an hour per commenter and recipe, so a
-- conversation doesn't buzz their phone at every reply. Comments (018_social.sql) are read
-- through to_jsonb, so this function doesn't depend on their exact columns.
CREATE FUNCTION announce_comment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c jsonb := to_jsonb(NEW);
  v_actor text := COALESCE(c->>'user_id', c->>'author_id');
  v_recipe text := c->>'recipe_id';
BEGIN
  IF v_actor IS NULL OR v_recipe IS NULL
    OR EXISTS (SELECT 1 FROM recipes WHERE id = v_recipe AND author_id = v_actor)
    OR EXISTS (SELECT 1 FROM notification_outbox WHERE recipe_id = v_recipe AND actor_id = v_actor AND kind = 'comment' AND created_at > now() - interval '1 hour') THEN
    RETURN NULL;
  END IF;
  INSERT INTO notification_outbox(kind, actor_id, recipe_id, ref_id, detail)
  VALUES ('comment', v_actor, v_recipe, COALESCE(c->>'id', ''), jsonb_build_object('text', left(COALESCE(c->>'body', ''), 200)));
  RETURN NULL;
END $$;
-- Each pantry item is mentioned once per expiry date, by the daily pass in the sender.
CREATE TABLE pantry_reminders (
  pantry_id text PRIMARY KEY REFERENCES pantry(id) ON DELETE CASCADE,
  expires_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The day a once-a-day pass last ran; claiming the day is what keeps replicas from repeating it.
CREATE TABLE notification_runs (
  name text PRIMARY KEY,
  ran_on date NOT NULL
);

-- First-party product analytics (events.go): what was done in the app, never where from. No IP
-- address or user agent is stored, and events go after 90 days (janitor.go) or with the account.
CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  props jsonb NOT NULL DEFAULT '{}',
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  session text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_created ON events(created_at);
CREATE INDEX events_name_created ON events(name, created_at);
CREATE INDEX events_user ON events(user_id) WHERE user_id IS NOT NULL;

-- Uploaded photos and videos leave storage once nothing uses them (media_cleanup.go). Whatever
-- stops using a URL queues it here; a deleted account queues its whole upload folders.
CREATE TABLE media_deletions (
  url text PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX media_deletions_queued ON media_deletions(queued_at);
CREATE TABLE media_owner_deletions (
  owner text PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION queue_media(urls text[]) RETURNS void LANGUAGE sql AS $$
  INSERT INTO media_deletions(url)
  SELECT DISTINCT u FROM unnest(urls) u WHERE u LIKE 'http%'
  ON CONFLICT (url) DO UPDATE SET queued_at = now(), attempts = 0
$$;
-- Every media URL a recipe shows: cover, video, gallery and step photos.
CREATE FUNCTION recipe_media(p_image text, p_video text, p_photos jsonb, p_steps jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT u), '{}') FROM (
    SELECT p_image AS u
    UNION ALL SELECT p_video
    UNION ALL SELECT p FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_photos) = 'array' THEN p_photos ELSE '[]' END) p
    UNION ALL SELECT s->>'image' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_steps) = 'array' THEN p_steps ELSE '[]' END) s WHERE jsonb_typeof(s) = 'object'
  ) x WHERE u IS NOT NULL AND u <> ''
$$;
CREATE FUNCTION release_recipe_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM queue_media(recipe_media(OLD.image, OLD.video, OLD.photos, OLD.steps));
  ELSE
    PERFORM queue_media(ARRAY(SELECT unnest(recipe_media(OLD.image, OLD.video, OLD.photos, OLD.steps))
      EXCEPT SELECT unnest(recipe_media(NEW.image, NEW.video, NEW.photos, NEW.steps))));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER recipe_media_released AFTER DELETE ON recipes FOR EACH ROW EXECUTE FUNCTION release_recipe_media();
CREATE TRIGGER recipe_media_replaced AFTER UPDATE OF image, video, photos, steps ON recipes FOR EACH ROW
  WHEN (OLD.image IS DISTINCT FROM NEW.image OR OLD.video IS DISTINCT FROM NEW.video OR OLD.photos IS DISTINCT FROM NEW.photos OR OLD.steps IS DISTINCT FROM NEW.steps)
  EXECUTE FUNCTION release_recipe_media();
CREATE FUNCTION release_avatar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_media(ARRAY[OLD.avatar]);
  IF TG_OP = 'DELETE' THEN
    INSERT INTO media_owner_deletions(owner) VALUES (OLD.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER account_media_released AFTER DELETE ON users FOR EACH ROW EXECUTE FUNCTION release_avatar();
CREATE TRIGGER avatar_replaced AFTER UPDATE OF avatar ON users FOR EACH ROW
  WHEN (OLD.avatar IS DISTINCT FROM NEW.avatar) EXECUTE FUNCTION release_avatar();
-- An AI job's photo or video, and a touch-up's original, stay while the job is in the member's
-- history; the janitor's purge of old jobs (and account deletion) lets them go.
CREATE FUNCTION release_job_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_media(ARRAY[OLD.result->>'url', OLD.source, OLD.result->'recipe'->>'image']);
  RETURN NULL;
END $$;
CREATE TRIGGER job_media_released AFTER DELETE ON ai_jobs FOR EACH ROW EXECUTE FUNCTION release_job_media();
CREATE FUNCTION release_cook_photo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_media(ARRAY[to_jsonb(OLD)->>'photo']);
  RETURN NULL;
END $$;

-- Comments and cooked-it photos come from 018_social.sql, which runs before this file. Their
-- triggers attach only where those tables exist in this schema; run SELECT
-- attach_social_triggers() again if they are created later.
CREATE FUNCTION attach_social_triggers() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass(format('%I.comments', current_schema())) IS NOT NULL THEN
    CREATE OR REPLACE TRIGGER comment_written AFTER INSERT ON comments FOR EACH ROW EXECUTE FUNCTION announce_comment();
    CREATE OR REPLACE TRIGGER comment_withdrawn AFTER DELETE ON comments FOR EACH ROW EXECUTE FUNCTION withdraw_notice('comment');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(format('%I.cooks', current_schema())) AND attname = 'photo' AND NOT attisdropped) THEN
    CREATE OR REPLACE TRIGGER cook_photo_released AFTER DELETE ON cooks FOR EACH ROW EXECUTE FUNCTION release_cook_photo();
    CREATE OR REPLACE TRIGGER cook_photo_replaced AFTER UPDATE OF photo ON cooks FOR EACH ROW
      WHEN (OLD.photo IS DISTINCT FROM NEW.photo) EXECUTE FUNCTION release_cook_photo();
  END IF;
END $$;
SELECT attach_social_triggers();

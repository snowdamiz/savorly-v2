-- A recipe's author can answer each review on it: one reply, which they can change or remove.
ALTER TABLE reviews
  ADD COLUMN reply text NOT NULL DEFAULT '' CHECK (char_length(reply) <= 1000),
  ADD COLUMN replied_at timestamptz;

-- The reviewer hears about a new reply (not an edit of one), at most once a day per review.
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check,
  ADD CONSTRAINT notification_outbox_kind_check CHECK (kind IN ('publish','review','comment','pantry','reply'));
CREATE FUNCTION announce_review_reply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE kind = 'reply' AND ref_id = NEW.id AND created_at > now() - interval '1 day') THEN
    RETURN NULL;
  END IF;
  INSERT INTO notification_outbox(kind, actor_id, recipient_id, recipe_id, ref_id, detail)
  SELECT 'reply', r.author_id, NEW.user_id, NEW.recipe_id, NEW.id, jsonb_build_object('text', left(NEW.reply, 200))
  FROM recipes r WHERE r.id = NEW.recipe_id AND r.author_id <> NEW.user_id;
  RETURN NULL;
END $$;
CREATE TRIGGER review_replied AFTER UPDATE OF reply ON reviews FOR EACH ROW
  WHEN (NEW.reply <> '' AND OLD.reply = '') EXECUTE FUNCTION announce_review_reply();

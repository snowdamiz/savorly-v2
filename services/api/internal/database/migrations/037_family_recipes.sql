-- Family recipes in their own voice (family.go, docs/FAMILY-RECIPES.md). A recording is a relative
-- talking through a dish, kept twice: url is the copy the app plays, in the public media bucket,
-- and source_key the private copy in the source bucket. Once written down it belongs to a recipe,
-- whose steps point into it (steps[].voice: the recording and a start and end in milliseconds);
-- deleting the recipe leaves the recording to its member. transcript is what speech-to-text heard,
-- in timed segments, kept so writing it down again costs no second transcription. Publishing a
-- recipe needs every recording on it to have the recorded person's agreement, which the member
-- confirms (consent_by, consent_at). Cookbooks can be shared with their owner's household.
CREATE TABLE recordings (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Deferred, so the recipe written from a recording can be saved after the recording points at it.
  recipe_id text REFERENCES recipes(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  speaker text NOT NULL CHECK (char_length(speaker) BETWEEN 1 AND 60),
  url text NOT NULL UNIQUE,
  source_key text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0),
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  language text NOT NULL DEFAULT '',
  transcript jsonb NOT NULL DEFAULT '[]',
  -- The latest job writing it down.
  job_id text REFERENCES ai_jobs(id) ON DELETE SET NULL,
  consent_by text REFERENCES users(id) ON DELETE SET NULL,
  consent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recordings_recipe ON recordings(recipe_id) WHERE recipe_id IS NOT NULL;
CREATE INDEX recordings_user ON recordings(user_id, created_at DESC);

-- Deleting a recording, or its member's account, deletes both copies: the public one through the
-- media janitor's queue (media_cleanup.go), the private one through source_deletions.
CREATE FUNCTION release_recording() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_media(ARRAY[OLD.url]);
  INSERT INTO source_deletions(object_key) VALUES (OLD.source_key) ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
CREATE TRIGGER recording_released AFTER DELETE ON recordings FOR EACH ROW EXECUTE FUNCTION release_recording();

-- A cookbook shared with the household: its owner's private recipes in it open for every member.
ALTER TABLE collections ADD COLUMN household boolean NOT NULL DEFAULT false;
CREATE INDEX collections_household ON collections(user_id) WHERE household;

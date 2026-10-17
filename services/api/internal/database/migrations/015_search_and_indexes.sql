-- Search: multilingual, accent-insensitive and typo-tolerant (see search.go).
-- Both extensions are trusted, so the database owner can install them on Neon and locally.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Resolve them wherever they were installed while this migration runs. The functions below
-- have SQL-standard bodies, which bind what they call when created, so they keep working
-- under any search_path afterwards (pg_restore uses an empty one).
SELECT set_config('search_path', concat_ws(',', nullif(current_setting('search_path'), ''), string_agg(DISTINCT quote_ident(n.nspname), ',')), true)
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname IN ('unaccent', 'pg_trgm');

-- unaccent() is STABLE because its dictionary could change; indexes need an IMMUTABLE wrapper.
CREATE FUNCTION search_fold(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN unaccent('unaccent'::regdictionary, lower(t));

CREATE FUNCTION recipe_ingredient_names(ingredients jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN (SELECT coalesce(string_agg(i->>'name', ' '), '') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ingredients) = 'array' THEN ingredients ELSE '[]' END) i);

-- Every word twice: as written (simple, for any language) and stemmed (english).
CREATE FUNCTION search_document(t text) RETURNS tsvector LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN to_tsvector('simple', search_fold(t)) || to_tsvector('english', search_fold(t));

CREATE FUNCTION recipe_search_vector(title text, description text, cuisine text, tags text[], ingredients jsonb)
RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN setweight(search_document(coalesce(title, '')), 'A')
  || setweight(search_document(coalesce(cuisine, '') || ' ' || coalesce(array_to_string(tags, ' '), '')), 'B')
  || setweight(search_document(coalesce(recipe_ingredient_names(ingredients), '')), 'C')
  || setweight(search_document(coalesce(description, '')), 'D');

-- Each word is a prefix in either form; all words must match. English stop words are skipped.
CREATE FUNCTION search_query(words text[]) RETURNS tsquery LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN (SELECT coalesce(string_agg(format('(%s:* | %s:*)', q.s, q.e), ' & '), '')::tsquery
  FROM unnest(words) w, LATERAL (SELECT plainto_tsquery('simple', search_fold(w))::text AS s, plainto_tsquery('english', search_fold(w))::text AS e) q
  WHERE q.s <> '' AND q.e <> '');

ALTER TABLE recipes DROP COLUMN search;
ALTER TABLE recipes ADD COLUMN search tsvector GENERATED ALWAYS AS (recipe_search_vector(title, description, cuisine, tags, ingredients)) STORED;
CREATE INDEX recipes_search_idx ON recipes USING gin(search) WHERE published;
CREATE INDEX recipes_title_trgm_idx ON recipes USING gin(search_fold(title) gin_trgm_ops) WHERE published;
CREATE INDEX recipes_ingredients_trgm_idx ON recipes USING gin(search_fold(recipe_ingredient_names(ingredients)) gin_trgm_ops) WHERE published;

-- Filters and the feed. Cuisine compares case-insensitively.
CREATE INDEX recipes_cuisine_idx ON recipes(lower(cuisine)) WHERE published;
CREATE INDEX recipes_minutes_idx ON recipes(minutes) WHERE published;
CREATE INDEX recipes_tags_idx ON recipes USING gin(tags) WHERE published;
CREATE INDEX saves_created_idx ON saves(created_at);

-- Cuisine is stored in the app's spelling from now on; bring older rows in line.
UPDATE recipes r SET cuisine = c.name FROM (VALUES ('Italian'), ('French'), ('Russian'), ('Japanese'), ('Mexican'), ('Indian'),
  ('Chinese'), ('Korean'), ('Thai'), ('Greek'), ('Spanish'), ('Vietnamese'), ('Turkish'), ('Moroccan'), ('Ethiopian'),
  ('Jamaican'), ('Brazilian'), ('Peruvian'), ('Indonesian'), ('Filipino'), ('American'), ('Ukrainian'), ('Georgian'),
  ('Polish'), ('German'), ('British'), ('Portuguese'), ('Lebanese'), ('Iranian'), ('Nigerian'), ('Malaysian'),
  ('Argentinian'), ('Mediterranean'), ('Asian'), ('Middle Eastern'), ('Caribbean'), ('Other')) c(name)
WHERE lower(btrim(r.cuisine)) = lower(c.name) AND r.cuisine <> c.name;

-- The recipe's own language (ISO 639-1), for reading it aloud; '' when unknown.
ALTER TABLE recipes ADD COLUMN language text NOT NULL DEFAULT '';

-- Editing a review keeps its place in the list.
ALTER TABLE reviews ADD COLUMN updated_at timestamptz;
UPDATE reviews SET updated_at = created_at;
ALTER TABLE reviews ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;

-- updated_at on every write, whoever writes.
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
ALTER TABLE users ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE users SET updated_at = created_at;
ALTER TABLE collections ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE groceries ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE pantry ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER collections_touch BEFORE UPDATE ON collections FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER groceries_touch BEFORE UPDATE ON groceries FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER pantry_touch BEFORE UPDATE ON pantry FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Housekeeping (janitor.go) and the AI budget's daily sums over every ai_spend source.
CREATE INDEX sessions_expires_idx ON sessions(expires_at);
CREATE INDEX ai_jobs_created ON ai_jobs(created_at);
CREATE INDEX voice_actions_created ON voice_actions(created_at);
CREATE INDEX voice_sessions_created ON voice_sessions(created_at);
-- Deleting a job cascades to voice_assets; without this every deleted job scans the table.
CREATE INDEX voice_assets_job ON voice_assets(job_id);

-- Narration audio moves to the private bucket; older rows keep their bytes.
ALTER TABLE recipe_narrations ALTER COLUMN audio DROP NOT NULL,
  ADD COLUMN object_key text,
  ADD COLUMN size integer,
  ADD COLUMN last_used_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT recipe_narrations_one_source CHECK ((audio IS NULL) <> (object_key IS NULL)),
  ADD CONSTRAINT recipe_narrations_object_size CHECK (object_key IS NULL OR size BETWEEN 1 AND 8388608);
CREATE INDEX recipe_narrations_last_used ON recipe_narrations(last_used_at);
-- Purged or cascaded rows queue their object for the worker that clears the source bucket.
CREATE TRIGGER narration_deleted AFTER DELETE ON recipe_narrations FOR EACH ROW
  WHEN (OLD.object_key IS NOT NULL) EXECUTE FUNCTION queue_source_deletion();

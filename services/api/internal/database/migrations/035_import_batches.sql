-- Bulk imports (import_batches.go): many recipe links, or recipes pasted as text, read on the
-- server into private drafts one at a time, so leaving the page doesn't stop them. purpose is
-- where the batch started: 'links' (Add a recipe), 'mealime' (the page for Mealime's members) or
-- 'own_site' (a creator bringing in recipes they published on their own site). An own_site batch
-- keeps the site and its member's confirmation that the recipes are theirs and that Savorly may
-- import them: the statement they agreed to and when. The member is the batch's user_id. read_at
-- is when the import loop last took one of its items, so batches take turns.
CREATE TABLE import_batches (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('links','mealime','own_site')),
  site text NOT NULL DEFAULT '',
  permission_statement text NOT NULL DEFAULT '',
  permission_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  finished_at timestamptz,
  CHECK (purpose <> 'own_site' OR (site <> '' AND permission_statement <> '' AND permission_at IS NOT NULL))
);
CREATE INDEX import_batches_user ON import_batches(user_id, created_at DESC);
CREATE INDEX import_batches_open ON import_batches(created_at) WHERE finished_at IS NULL;
CREATE INDEX import_batches_finished ON import_batches(finished_at) WHERE purpose <> 'own_site';

-- A batch's links and pasted recipes, in the order given. 'queued' waits its turn; 'reading' is
-- being read, by the importer or, when job_id is set, by the recipe model; 'imported' saved
-- recipe_id; 'failed' says why in error and never counts against the member's plan. image is the
-- photo an own_site page gives its recipe, kept while the model reads the page.
CREATE TABLE import_items (
  batch_id text NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  position integer NOT NULL,
  url text NOT NULL DEFAULT '',
  pasted text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','reading','imported','failed')),
  job_id text REFERENCES ai_jobs(id) ON DELETE SET NULL,
  recipe_id text REFERENCES recipes(id) ON DELETE SET NULL,
  image text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, position)
);
CREATE INDEX import_items_open ON import_items(updated_at, position) WHERE status IN ('queued','reading');
CREATE INDEX import_items_job ON import_items(job_id) WHERE job_id IS NOT NULL;

-- Single-use export links (export.go) also serve the export as files (export_files.go).
ALTER TABLE export_tokens ADD COLUMN format text NOT NULL DEFAULT 'json' CHECK (format IN ('json','files'));

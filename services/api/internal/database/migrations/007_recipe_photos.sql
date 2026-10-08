-- Extra photos shown after the cover in the recipe gallery.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]';

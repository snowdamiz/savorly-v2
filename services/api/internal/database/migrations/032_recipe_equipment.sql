-- What a recipe needs besides its ingredients (equipment.go). equipment is the pots, pans,
-- appliances and tools its author lists, in their order and words; equipment_detected is the
-- equipment its method mentions, read with the equipment lexicon as English keys the app names in
-- the reader's language. equipment_source is what detection reads (the steps and the language); a
-- write that changes them without reading them again leaves equipment_indexed behind it, and the
-- indexer catches up (indexEquipment), as it does for rows read under an older equipment_version.
ALTER TABLE recipes
  ADD COLUMN equipment text[] NOT NULL DEFAULT '{}',
  ADD COLUMN equipment_detected text[] NOT NULL DEFAULT '{}',
  ADD COLUMN equipment_version integer NOT NULL DEFAULT 0,
  ADD COLUMN equipment_indexed text NOT NULL DEFAULT '',
  ADD COLUMN equipment_source text GENERATED ALWAYS AS (md5(language || steps::text)) STORED;
CREATE INDEX recipes_equipment_stale ON recipes(id) WHERE equipment_indexed <> equipment_source;

-- What each name on a cook's own equipment list names, for its illustration (equipment.go's
-- nameEquipment): an equipment key, an everyday tool the lexicon reads only on lists ("bowl",
-- "spoon"), or '' for none, one for one with equipment. It is read with the method, and recipes
-- read before it existed are read again (equipmentVersion 3).
ALTER TABLE recipes ADD COLUMN equipment_kinds text[] NOT NULL DEFAULT '{}';

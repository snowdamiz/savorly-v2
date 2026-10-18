-- What a recipe without its own equipment list likely uses, and when (equipment_guess.go): the
-- cheap model's guess merged with what the method names, as [{"key","steps"}], keys as
-- equipment_detected has them and steps 1-based. equipment_asked is the equipment_source it was
-- last asked about, so a published recipe is asked about once a version, and a guess about other
-- steps is never shown.
ALTER TABLE recipes
  ADD COLUMN equipment_guess jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN equipment_asked text NOT NULL DEFAULT '';
CREATE INDEX recipes_equipment_unguessed ON recipes(id) WHERE published AND equipment = '{}' AND equipment_asked <> equipment_source;

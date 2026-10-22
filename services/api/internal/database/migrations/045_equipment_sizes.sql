-- How big a recipe's pots, pans and dishes should be (equipment_guess.go): the guess's pieces
-- carry a size, as {"liters"}, {"cm"} or {"cm","lengthCm"}. equipment_guess_version is the
-- equipmentGuessVersion a guess was made under; older guesses keep showing until the model is
-- asked again, after the recipes it hasn't been asked about.
ALTER TABLE recipes ADD COLUMN equipment_guess_version integer NOT NULL DEFAULT 0;
CREATE INDEX recipes_equipment_unsized ON recipes(id) WHERE published AND equipment = '{}' AND equipment_guess_version < 1;

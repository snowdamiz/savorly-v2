-- Households share the meal plan and the pantry as well as the grocery list (household.go). Like
-- grocery lines, a household's plans and pantry items carry its id, and user_id stays the member
-- who planned or added them. A day's meal and a pantry name are unique within a kitchen: the
-- member's own while they have no household, the household's while they do.
ALTER TABLE meal_plans ADD COLUMN household_id text REFERENCES households(id) ON DELETE CASCADE;
ALTER TABLE meal_plans DROP CONSTRAINT meal_plans_user_id_day_meal_key;
CREATE UNIQUE INDEX meal_plans_own_slot ON meal_plans(user_id, day, meal) WHERE household_id IS NULL;
CREATE UNIQUE INDEX meal_plans_household_slot ON meal_plans(household_id, day, meal) WHERE household_id IS NOT NULL;

ALTER TABLE pantry ADD COLUMN household_id text REFERENCES households(id) ON DELETE CASCADE;
ALTER TABLE pantry DROP CONSTRAINT pantry_user_id_name_key;
CREATE UNIQUE INDEX pantry_own_name ON pantry(user_id, name) WHERE household_id IS NULL;
CREATE UNIQUE INDEX pantry_household_name ON pantry(household_id, name) WHERE household_id IS NOT NULL;

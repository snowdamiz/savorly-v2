-- The primary keys start with user_id; public recipe/creator counts look up the other side.
CREATE INDEX IF NOT EXISTS saves_recipe_idx ON saves(recipe_id);
CREATE INDEX IF NOT EXISTS follows_creator_idx ON follows(creator_id);

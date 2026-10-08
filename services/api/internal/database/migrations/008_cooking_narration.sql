CREATE TABLE recipe_narrations (
    cache_key text PRIMARY KEY,
    recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    audio bytea NOT NULL CHECK (octet_length(audio) BETWEEN 1 AND 8388608),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recipe_narrations_recipe ON recipe_narrations(recipe_id);

-- Keep conservative spend reservations even when generation fails or a recipe is deleted.
CREATE TABLE narration_usage (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cache_key text NOT NULL,
    user_id text REFERENCES users(id) ON DELETE SET NULL,
    estimated_cost numeric NOT NULL CHECK (estimated_cost >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX narration_usage_created ON narration_usage(created_at);
CREATE INDEX narration_usage_key ON narration_usage(cache_key, created_at);

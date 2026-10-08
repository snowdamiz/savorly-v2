CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
 name text NOT NULL, handle text NOT NULL UNIQUE, bio text NOT NULL DEFAULT '',
 avatar text NOT NULL DEFAULT '', preferences jsonb NOT NULL DEFAULT '{"diets":[],"allergies":[]}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS recipes (
 id text PRIMARY KEY, author_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL, description text NOT NULL, cuisine text NOT NULL,
 minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 1440), servings integer NOT NULL CHECK(servings BETWEEN 1 AND 100),
 difficulty text NOT NULL CHECK(difficulty IN ('Easy','Medium','Advanced')),
 image text NOT NULL DEFAULT '', video text NOT NULL DEFAULT '',
 ingredients jsonb NOT NULL, steps jsonb NOT NULL, tags text[] NOT NULL DEFAULT '{}',
 calories integer NOT NULL DEFAULT 0 CHECK(calories BETWEEN 0 AND 10000),
 ai_generated boolean NOT NULL DEFAULT false, published boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 search tsvector GENERATED ALWAYS AS (to_tsvector('english',title || ' ' || description || ' ' || cuisine)) STORED
);
CREATE INDEX IF NOT EXISTS recipes_search_idx ON recipes USING gin(search);
CREATE INDEX IF NOT EXISTS recipes_author_idx ON recipes(author_id);
CREATE INDEX IF NOT EXISTS recipes_created_idx ON recipes(created_at DESC) WHERE published;
CREATE TABLE IF NOT EXISTS collections (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,name)
);
CREATE TABLE IF NOT EXISTS saves (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
 collection_id text REFERENCES collections(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,recipe_id)
);
CREATE TABLE IF NOT EXISTS follows (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 creator_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,creator_id), CHECK(user_id <> creator_id)
);
CREATE TABLE IF NOT EXISTS reviews (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
 rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5), body text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,recipe_id)
);
CREATE INDEX IF NOT EXISTS reviews_recipe_idx ON reviews(recipe_id);
CREATE TABLE IF NOT EXISTS meal_plans (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
 day date NOT NULL, meal text NOT NULL CHECK(meal IN ('Breakfast','Lunch','Dinner')),
 servings integer NOT NULL CHECK(servings BETWEEN 1 AND 100), UNIQUE(user_id,day,meal)
);
CREATE TABLE IF NOT EXISTS groceries (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL, quantity text NOT NULL DEFAULT '', category text NOT NULL DEFAULT 'Other',
 checked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS groceries_user_idx ON groceries(user_id);
CREATE TABLE IF NOT EXISTS pantry (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL, quantity text NOT NULL DEFAULT '', expires_on date,
 UNIQUE(user_id,name)
);
CREATE TABLE IF NOT EXISTS reports (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,recipe_id)
);
CREATE TABLE IF NOT EXISTS ai_jobs (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('recipe','adapt','substitute','nutrition','plan','assistant','image','video')),
 prompt text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','processing','completed','failed')),
 request_key text NOT NULL, provider_id text NOT NULL DEFAULT '',
 result jsonb NOT NULL DEFAULT '{}', error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,request_key)
);
CREATE INDEX IF NOT EXISTS ai_jobs_pending_idx ON ai_jobs(created_at) WHERE status IN ('queued','processing');

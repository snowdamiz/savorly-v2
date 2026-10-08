CREATE TABLE voice_projects (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_id text REFERENCES recipes(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'listening',
  reply text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  confirmed_revision integer NOT NULL DEFAULT -1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_projects_owner ON voice_projects(user_id, updated_at DESC);
CREATE TABLE voice_sessions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES voice_projects(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'connecting',
  seconds double precision NOT NULL DEFAULT 15,
  reserved_seconds integer NOT NULL,
  finalized boolean NOT NULL DEFAULT false,
  close_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX voice_one_session_per_user ON voice_sessions(user_id) WHERE status IN ('connecting','active');
CREATE TABLE voice_events (
  seq bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES voice_projects(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id,event_id)
);
CREATE INDEX voice_events_project ON voice_events(project_id,seq);
CREATE TABLE voice_actions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES voice_projects(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  delegation_id text NOT NULL,
  through_seq bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued',
  reply text NOT NULL DEFAULT '',
  delivered boolean NOT NULL DEFAULT false,
  estimated_cost numeric(10,4) NOT NULL DEFAULT 0.05,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id,delegation_id)
);
CREATE INDEX voice_actions_queue ON voice_actions(status,created_at);
CREATE TABLE voice_assets (
  project_id text NOT NULL REFERENCES voice_projects(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image','video')),
  job_id text NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  applied boolean NOT NULL DEFAULT false,
  PRIMARY KEY(project_id,revision,kind)
);
ALTER TABLE voice_events ADD COLUMN images jsonb NOT NULL DEFAULT '[]';
CREATE TABLE voice_sources (
 id text PRIMARY KEY,
 project_id text NOT NULL REFERENCES voice_projects(id) ON DELETE CASCADE,
 object_key text NOT NULL,
 mime text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);

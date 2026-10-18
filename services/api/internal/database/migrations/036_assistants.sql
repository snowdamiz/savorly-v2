-- Savorly in ChatGPT and Claude (docs/ASSISTANTS.md): the OAuth 2.1 authorization server that
-- links a member's kitchen to an assistant, for the MCP server at /mcp (oauth_server.go, mcp.go).
-- Codes, tokens and client secrets are stored as SHA-256 hashes, like sessions.

-- An app that may ask members for access: registered by the app itself (RFC 7591), or read from
-- the client ID metadata document its id points to (metadata_document; refreshed_at says when).
-- auth_method is how it proves itself at the token endpoint: none (PKCE only), or a secret.
-- last_used_at is the last time a member said yes to it; the janitor forgets apps nobody uses.
CREATE TABLE oauth_clients (
  id text PRIMARY KEY,
  name text NOT NULL,
  uri text NOT NULL DEFAULT '',
  redirect_uris text[] NOT NULL,
  auth_method text NOT NULL DEFAULT 'none' CHECK (auth_method IN ('none','client_secret_post','client_secret_basic')),
  secret_hash text NOT NULL DEFAULT '',
  metadata_document boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- A member's yes to one app: what it may do (scopes) at which server (resource, the MCP URL its
-- tokens are for). Disconnecting the app, or a refresh token used twice, deletes the grant and
-- every token with it. id is what My kitchen's Connected apps names it by.
CREATE TABLE oauth_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scopes text[] NOT NULL,
  resource text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_grants_user ON oauth_grants(user_id, created_at);
CREATE INDEX oauth_grants_client ON oauth_grants(client_id);

-- Authorization codes live a few minutes and work once. A used code keeps its row until it
-- expires, with the grant it started, so presenting it again revokes that grant.
CREATE TABLE oauth_codes (
  code_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scopes text[] NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  grant_id text REFERENCES oauth_grants(id) ON DELETE SET NULL
);
CREATE INDEX oauth_codes_expiry ON oauth_codes(expires_at);

-- Access tokens (an hour) and refresh tokens (rotated on every use; a used one stays, marked
-- used_at, until it expires so a second use is caught).
CREATE TABLE oauth_tokens (
  token_hash text PRIMARY KEY,
  grant_id text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access','refresh')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id, kind);
CREATE INDEX oauth_tokens_expiry ON oauth_tokens(expires_at);

-- An MCP session of a client on a protocol version before 2026-07-28, which starts with
-- initialize and names its session in the Mcp-Session-Id header (id_hash is that id, hashed).
-- It holds no authority, only the version agreed on: every request carries its own token. The
-- janitor ends sessions idle for 30 days; a client then starts a new one.
CREATE TABLE mcp_sessions (
  id_hash text PRIMARY KEY,
  protocol_version text NOT NULL,
  client_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_sessions_used ON mcp_sessions(last_used_at);

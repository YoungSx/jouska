-- Machine credentials for the stateless MCP endpoint.
-- The bearer value is never stored; only its SHA-256 digest is indexed.
CREATE TABLE mcp_tokens (
  id                 TEXT PRIMARY KEY,
  token_hash         TEXT NOT NULL UNIQUE,
  token_prefix       TEXT NOT NULL,
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  owner_user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  issued_by_user_id  INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  scopes             TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  revoked_at         INTEGER,
  revoked_by_user_id INTEGER REFERENCES users (id) ON DELETE RESTRICT,
  revoke_reason      TEXT,
  last_used_at       INTEGER,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500)
);

CREATE INDEX mcp_tokens_active_idx
  ON mcp_tokens (token_hash, revoked_at, expires_at);

CREATE INDEX mcp_tokens_owner_idx
  ON mcp_tokens (owner_user_id, revoked_at, expires_at);

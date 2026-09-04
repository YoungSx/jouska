-- Rebuild mcp_tokens so the three user links survive account deletion.
--
-- Under 0004 all three were ON DELETE RESTRICT, which made deleting any user
-- who ever minted or revoked a token an unhandled FOREIGN KEY constraint
-- failure: the panel answered 500 and the row stayed. SET NULL keeps the token
-- rows (their hashes, scopes, and audit value) while marking the ownership
-- gone; resolveMcpToken's inner JOIN drops orphaned rows out on its own, and
-- the delete path revokes before deleting so the revocation record itself is
-- explicit (revoke_reason = 'owner_deleted').
--
-- Table rebuild because SQLite cannot ALTER a foreign key: create the new
-- shape, copy every row (all references are valid under the old RESTRICT, so
-- no cleanup pass is needed), drop the old table, rename, recreate indexes.
CREATE TABLE mcp_tokens_new (
  id                 TEXT PRIMARY KEY,
  token_hash         TEXT NOT NULL UNIQUE,
  token_prefix       TEXT NOT NULL,
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  owner_user_id      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  issued_by_user_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  scopes             TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  revoked_at         INTEGER,
  revoked_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  revoke_reason      TEXT,
  last_used_at       INTEGER,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500)
);

INSERT INTO mcp_tokens_new
  (id, token_hash, token_prefix, name, owner_user_id, issued_by_user_id, scopes,
   created_at, expires_at, revoked_at, revoked_by_user_id, revoke_reason, last_used_at)
SELECT id, token_hash, token_prefix, name, owner_user_id, issued_by_user_id, scopes,
       created_at, expires_at, revoked_at, revoked_by_user_id, revoke_reason, last_used_at
FROM mcp_tokens;

DROP TABLE mcp_tokens;
ALTER TABLE mcp_tokens_new RENAME TO mcp_tokens;

CREATE INDEX mcp_tokens_active_idx
  ON mcp_tokens (token_hash, revoked_at, expires_at);

CREATE INDEX mcp_tokens_owner_idx
  ON mcp_tokens (owner_user_id, revoked_at, expires_at);

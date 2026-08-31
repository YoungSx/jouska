-- Sessions for password auth. The token itself is never stored: the cookie
-- carries 32 random bytes, and this table holds their SHA-256. A dumped D1
-- database therefore cannot be replayed as a session.
CREATE TABLE sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  -- Unix seconds. Sliding: refreshed on use up to a hard cap.
  expires_at INTEGER NOT NULL
);

-- One row per route. The primary key doubles as the route's `id` in the
-- compiled document, which is also what resolveConfig merges by and what
-- rate-limit buckets are namespaced with — one identifier, three uses.
-- `definition` holds the route JSON without its `id` (the row injects it);
-- a definition that carries a conflicting `id` is rejected at compile time.
CREATE TABLE routes (
  id         TEXT    PRIMARY KEY,
  definition TEXT    NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- Match order is significant in the compiled document, so it is a managed
  -- column, not part of the JSON the operator edits.
  position   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT    NOT NULL
);

-- Key/value table for table-wide config: the `defaults` block under key
-- 'defaults'. A settings row is free-form on purpose — keys are added when
-- code needs them, and there is nothing to ALTER.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Append-only. `detail` is JSON; for publishes it carries the shadow warnings
-- and the revision written to KV, so "what changed and why" is answerable
-- without reconstructing the KV history.
CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  actor  TEXT    NOT NULL,
  action TEXT    NOT NULL,
  target TEXT,
  detail TEXT
);

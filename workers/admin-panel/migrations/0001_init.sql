-- Multi-user shape from the start; a single-user deployment just has one row
-- in `users`. Nothing here needs an ALTER TABLE to add the second user.

CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Stable external identity. For Cloudflare Access this is the email from
  -- the Access JWT; for password auth it is the chosen login name.
  subject    TEXT    NOT NULL,
  email      TEXT,
  role       TEXT    NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'viewer')),
  -- NULL when the user authenticates through Cloudflare Access.
  password   TEXT,
  disabled   INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  last_seen  INTEGER,
  -- Brute-force throttle: N consecutive failures park the account until
  -- locked_until. Reset on success.
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER
);

CREATE UNIQUE INDEX users_subject_idx ON users (subject);

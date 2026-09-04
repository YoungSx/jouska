-- Password authentication is gone; Cloudflare Access is the only door.
--
-- `sessions` existed only to hold the cookie token digest for that door, so the
-- whole table goes. Every live cookie stops working the moment this runs, which
-- is the intent — a migration that left old sessions valid would have removed
-- nothing. Dropped before the users rebuild so its ON DELETE CASCADE reference
-- is already gone by then.
DROP TABLE IF EXISTS sessions;

-- Three columns on `users` were password bookkeeping and nothing else:
-- the PBKDF2 digest, and the brute-force throttle that only a password can
-- trip. Dropped one at a time rather than by rebuilding the table: `users` is
-- the parent of three ON DELETE RESTRICT foreign keys in `mcp_tokens`, and a
-- DROP/rename round trip would have to disarm and re-arm those to survive.
-- None of the three columns is indexed, part of a key, or named in a CHECK,
-- which is exactly the case SQLite's DROP COLUMN accepts.
ALTER TABLE users DROP COLUMN password;
ALTER TABLE users DROP COLUMN failed_attempts;
ALTER TABLE users DROP COLUMN locked_until;

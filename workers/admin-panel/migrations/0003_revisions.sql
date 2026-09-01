-- One row per publish. `document` is the compiled ConfigInput exactly as it
-- went to KV, minus `meta`: meta is regenerated per publish (operator, time,
-- note), so storing it would make rollback restore stale provenance. Without
-- meta the document is also what the live digest covers, so a restored draft
-- digests identically to the revision it came from.
--
-- Immutable by design: no code path UPDATEs or DELETEs individual rows except
-- the retention prune, and the primary key is the revision number itself, so
-- a revision can never be republished under the same number.
--
-- Retention keeps the most recent KEEP_REVISIONS (see api/config.ts); the
-- prune runs inside the publish transaction, so history and live state never
-- disagree about what exists.
CREATE TABLE revisions (
  revision    INTEGER PRIMARY KEY CHECK (revision > 0),
  document    TEXT    NOT NULL,
  actor       TEXT    NOT NULL,
  at          INTEGER NOT NULL,
  note        TEXT,
  rollback_of INTEGER,
  route_count INTEGER NOT NULL
);

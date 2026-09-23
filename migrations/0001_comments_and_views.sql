-- nano-blog — comments and view counts
--
-- Applied once, against the D1 database bound as `COMMENTS_DB`. The command is
-- recorded in docs/CLOUDFLARE_SETUP.md; nothing here runs at build time and the
-- build does not read this file.
--
-- Three tables, and the design of each answers a privacy question rather than a
-- storage one:
--
--   comments     no email, no IP — only hashes of both, and the hash of the
--                email is enough to look up an avatar, which is the only thing
--                the address was ever needed for.
--   views        a row per visitor per day, so the number shown is "people who
--                read this", not "times this page was opened". A self-incrementing
--                counter would be moved by the refresh key and would mean nothing.
--   rate_limits  counters keyed by hashed caller, deleted as they expire.
--
-- Timestamps are ISO 8601 text in UTC. SQLite has no date type, and storing the
-- string the application already produces avoids a conversion that could only
-- lose information.

CREATE TABLE IF NOT EXISTS comments (
  id              TEXT PRIMARY KEY,
  post_id         TEXT NOT NULL,
  author_name     TEXT NOT NULL,
  -- MD5 of the lower-cased address, which is what Gravatar is addressed by.
  -- Deterministic, so it is not a secret; it is also not the address.
  email_hash      TEXT NOT NULL,
  body_markdown   TEXT NOT NULL,
  -- Rendered once at write time. Reading it back is a column read rather than a
  -- parse and sanitise per request, and it freezes what was reviewed: a comment
  -- approved under one renderer cannot change meaning under the next.
  body_html       TEXT NOT NULL,
  -- HMAC-SHA-256 of the caller's address under a server secret. Used only for
  -- rate limiting and abuse response; not reversible to an address.
  ip_hash         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at      TEXT NOT NULL
);

-- The read path: approved comments for one page, oldest first.
CREATE INDEX IF NOT EXISTS comments_by_post
  ON comments (post_id, status, created_at);

-- The moderation path: newest first, filtered by state.
CREATE INDEX IF NOT EXISTS comments_by_status
  ON comments (status, created_at DESC);

CREATE TABLE IF NOT EXISTS views (
  post_id      TEXT NOT NULL,
  -- UTC date, YYYY-MM-DD.
  day          TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  -- The primary key is the de-duplication. A repeat visit on the same day
  -- conflicts and is ignored, so the daily figure counts visitors rather than
  -- requests without needing a read-then-write race to get there.
  PRIMARY KEY (post_id, day, visitor_hash)
);

CREATE INDEX IF NOT EXISTS views_by_post ON views (post_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_kind TEXT NOT NULL,
  window_key  TEXT NOT NULL,
  caller      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (bucket_kind, window_key, caller)
);

-- Expired counters are swept opportunistically; this index makes that cheap.
CREATE INDEX IF NOT EXISTS rate_limits_by_window
  ON rate_limits (bucket_kind, window_key);

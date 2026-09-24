-- The day's tool calls for each principal, and for everyone together.
--
-- One agent looping must not spend everyone's day, so each principal has a cap
-- of its own. The total still has one, because every call reads planify's
-- database and its daily reads are shared with the app. The total
-- is the row whose principal is '*', which no email or client id can be.
--
-- Today's count so far is dropped with the old table; it only ever holds a day.

DROP TABLE mcp_usage;

CREATE TABLE mcp_usage (
  principal TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL
);

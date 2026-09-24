-- How many tool calls today, to cap them.
--
-- Every tool call reads the roadmap in planify's database, and an agent stuck
-- in a loop would spend the database's daily reads — the app's too. One row,
-- one write per call: the day it counts and the calls so far. A new day starts
-- the count again in the same statement.

CREATE TABLE mcp_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  day TEXT NOT NULL,
  calls INTEGER NOT NULL
);

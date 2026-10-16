-- Contribution graphs: a 'token' tier for work done through an API token, which is how agents and automations outside Golf connect (for
-- example a coding CLI over MCP). Golf cannot tell an agent from a script behind a token, so it reports the token, not a claim.
-- contribution_ledger replaces contribution_events as the ledger, with 'token' in its ai_tier CHECK (a CHECK cannot widen in place, and
-- migrations here only add). contribution_events stays, unused. contribution_rebuilds records each one-time rebuild of the derived
-- counts by name: the maintenance sweep, finding no 'token-tier' row, empties both ledgers and the rollup, resets the sweep cursors and
-- Git walks, and records the row in the same batch, then counts everything again from Golf's own records. People's privacy choices
-- (contribution_settings) are kept. Replay-safe.
CREATE TABLE IF NOT EXISTS contribution_ledger (
 key TEXT PRIMARY KEY,
 day TEXT NOT NULL CHECK(length(day)=10),
 actor_id INTEGER NOT NULL,
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 kind TEXT NOT NULL CHECK(kind IN ('commit','pull_opened','pull_merged','review','issue_opened','issue_closed','comment','proposal_created','proposal_accepted')),
 ai_tier TEXT NOT NULL CHECK(ai_tier IN ('agent','token','assisted','declared','none')),
 pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1))
);
CREATE INDEX IF NOT EXISTS contribution_ledger_pending ON contribution_ledger(pending) WHERE pending=1;
CREATE TABLE IF NOT EXISTS contribution_rebuilds (
 name TEXT PRIMARY KEY,
 done_at TEXT NOT NULL
);

-- Contribution graphs: a 'token' tier for work done through an API token, which is how agents and automations outside Golf connect (for
-- example a coding CLI over MCP). Golf cannot tell an agent from a script behind a token, so it reports the token, not a claim.
-- The ledger's ai_tier CHECK gains 'token'. The ledger and the daily rollup are derived from records Golf keeps, so both are rebuilt:
-- the ledger is recreated empty, the rollup emptied, and the sweep and Git walk positions reset; the maintenance sweep counts everything
-- again. People's privacy choices (contribution_settings) are kept. Replay-safe: a replay rebuilds the same derived data.
DROP TABLE IF EXISTS contribution_events;
CREATE TABLE IF NOT EXISTS contribution_events (
 key TEXT PRIMARY KEY,
 day TEXT NOT NULL CHECK(length(day)=10),
 actor_id INTEGER NOT NULL,
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 kind TEXT NOT NULL CHECK(kind IN ('commit','pull_opened','pull_merged','review','issue_opened','issue_closed','comment','proposal_created','proposal_accepted')),
 ai_tier TEXT NOT NULL CHECK(ai_tier IN ('agent','token','assisted','declared','none')),
 pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1))
);
CREATE INDEX IF NOT EXISTS contribution_events_pending ON contribution_events(pending) WHERE pending=1;
DELETE FROM contribution_days;
DELETE FROM contribution_cursors;
UPDATE contribution_git SET next_commit='',pending=1,walked=0,checked_at=NULL;

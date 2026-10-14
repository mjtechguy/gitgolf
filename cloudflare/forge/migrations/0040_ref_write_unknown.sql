-- Unknown ref-write outcomes (docs/AGENTIC_MODE_PLAN.md AM-1). A write whose outcome is unknown keeps only its own ref fenced in
-- git_ref_writes, so pushes to other branches proceed; this row marks it so that changes that must not interleave with an unresolved
-- write (branch rules, settings, merges, evidence) still wait until maintenance reads the ref back and deletes it. Replay-safe.
CREATE TABLE IF NOT EXISTS git_ref_unknown (
 operation_id TEXT PRIMARY KEY REFERENCES git_operations(id),
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS git_ref_unknown_repository ON git_ref_unknown(repository_id);

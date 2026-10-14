-- Branch-level push fence (docs/AGENTIC_MODE_PLAN.md AM-1). A push reserves its ref here in the batch that journals its git_operations
-- row: two unsettled writes to one ref conflict, writes to different refs proceed. A confirmed write deletes its row; an unknown outcome
-- keeps it until maintenance reads the ref back (APPLIED, or outcome NOT_APPLIED kept here). The outcome lives in this table because a
-- column cannot be added to git_operations repeatably. Replay-safe.
CREATE TABLE IF NOT EXISTS git_ref_writes (
 operation_id TEXT PRIMARY KEY REFERENCES git_operations(id),
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 ref TEXT NOT NULL,
 outcome TEXT CHECK(outcome IS NULL OR outcome='NOT_APPLIED'),
 settled_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS git_ref_writes_unsettled ON git_ref_writes(repository_id,ref) WHERE outcome IS NULL;
-- Pull request merges journal through their own statement: one onto a ref with an unsettled push is not journaled, so its reservation
-- reports the existing conflict instead of racing the push at the provider.
CREATE TRIGGER IF NOT EXISTS git_ref_writes_fence BEFORE INSERT ON git_operations
WHEN NEW.state='DISPATCHED' AND EXISTS(SELECT 1 FROM git_ref_writes WHERE repository_id=NEW.repository_id AND ref=NEW.ref AND outcome IS NULL)
BEGIN SELECT RAISE(IGNORE); END;

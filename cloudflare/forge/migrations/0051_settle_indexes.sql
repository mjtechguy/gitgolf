-- settleRefWrites (ref-writes.mjs), every maintenance pass: it read every git_operations row and, for each dispatched one, every merge
-- operation (77,944 rows a call on the hosted demo with 151 dispatched operations and 509 merges). Both lookups now use an index.
CREATE INDEX IF NOT EXISTS git_operations_dispatched ON git_operations(created_at,id) WHERE state='DISPATCHED';
CREATE INDEX IF NOT EXISTS pull_merge_operations_git ON pull_merge_operations(git_operation_id);

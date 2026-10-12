-- Native push policy and original mutation receipts; no Git objects are rewritten.
CREATE TABLE IF NOT EXISTS repository_rules (
 repository_id INTEGER PRIMARY KEY REFERENCES repositories(id), artifact_name TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), branches TEXT NOT NULL, tags TEXT NOT NULL,
 next_tag INTEGER NOT NULL CHECK(next_tag>0)
);
CREATE TABLE IF NOT EXISTS repository_rule_operations (
 operation_id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id),
 actor_id INTEGER NOT NULL REFERENCES users(id), input_hash TEXT NOT NULL,
 receipt TEXT NOT NULL, current_rules TEXT
);

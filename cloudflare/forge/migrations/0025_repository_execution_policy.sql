-- Repository switch for pull-request runs and automatic push tests; no row means both are enabled within the operator allocation.
CREATE TABLE IF NOT EXISTS repository_execution_policy (
 repository_id INTEGER PRIMARY KEY REFERENCES repositories(id), artifact_name TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), manual INTEGER NOT NULL CHECK(manual IN (0,1)),
 push INTEGER NOT NULL CHECK(push IN (0,1)), updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL
);

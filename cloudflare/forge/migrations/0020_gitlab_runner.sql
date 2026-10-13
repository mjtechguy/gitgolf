ALTER TABLE native_runner_machines ADD COLUMN protocol TEXT NOT NULL DEFAULT 'native' CHECK(protocol IN ('native','gitlab'));

CREATE TABLE gitlab_runner_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_job_id TEXT NOT NULL UNIQUE REFERENCES evidence_jobs(id),
  machine_id TEXT NOT NULL REFERENCES native_runner_machines(id),
  token_digest TEXT NOT NULL,
  trace TEXT NOT NULL DEFAULT '',
  trace_bytes INTEGER NOT NULL DEFAULT 0,
  completed_state TEXT,
  completed_exit_code INTEGER,
  CHECK(length(trace) <= 65536),
  CHECK(trace_bytes BETWEEN 0 AND 49152)
);
CREATE INDEX gitlab_runner_jobs_machine ON gitlab_runner_jobs(machine_id);

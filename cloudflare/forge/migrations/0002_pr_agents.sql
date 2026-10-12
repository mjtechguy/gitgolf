-- Apply once after 0001 to an existing native D1 installation; fresh schema includes these columns.
ALTER TABLE evidence_jobs ADD COLUMN agent_state TEXT NOT NULL DEFAULT 'NONE' CHECK(agent_state IN ('NONE','REQUESTED','FORK_PENDING','RUNNING','succeeded','failed','cancelled','timed_out','lost'));
ALTER TABLE evidence_jobs ADD COLUMN agent_fork TEXT;
ALTER TABLE evidence_jobs ADD COLUMN agent_publish TEXT CHECK(agent_publish IN ('DISPATCHED','APPLIED'));
ALTER TABLE evidence_jobs ADD COLUMN agent_result TEXT;
ALTER TABLE evidence_jobs ADD COLUMN agent_proposal TEXT;

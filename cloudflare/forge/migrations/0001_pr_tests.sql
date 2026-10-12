-- Existing native D1 installs only; fresh installs already include these columns.
ALTER TABLE evidence_jobs ADD COLUMN test_state TEXT NOT NULL DEFAULT 'NONE' CHECK(test_state IN ('NONE','REQUESTED','RUNNING','PASSED','FAILED','TIMED_OUT','CANCELLED','LOST'));
ALTER TABLE evidence_jobs ADD COLUMN test_result TEXT;

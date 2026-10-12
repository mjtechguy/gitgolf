-- Native D1 only. Apply once to an existing installation before deploying.
ALTER TABLE repositories ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'main';

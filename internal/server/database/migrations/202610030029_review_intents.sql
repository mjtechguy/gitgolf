-- +goose Up
-- A comment or explicit request consumes at most one admission across head changes.
CREATE UNIQUE INDEX golf_reviewer_once_intent ON golf_reviewer_runs(reviewer_id,intent) WHERE intent <> 'change';
ALTER TABLE golf_reviewers ADD CONSTRAINT golf_reviewers_positive CHECK (revision>0 AND local_version>0 AND publisher_id>0 AND repository_id>0 AND owner_id>0);
ALTER TABLE golf_reviewer_runs ADD CONSTRAINT golf_reviewer_runs_identity CHECK (reviewer_revision>0 AND pull_number BETWEEN 1 AND 2147483647 AND publisher_id>0 AND base_commit ~ '^[a-f0-9]{40,64}$' AND head_commit ~ '^[a-f0-9]{40,64}$');
ALTER TABLE golf_reviewer_runs ADD CONSTRAINT golf_reviewer_runs_state CHECK (state IN ('admitting','queued','running','failed','outdated','publishing','published','publication_unknown'));
-- +goose Down
DROP INDEX golf_reviewer_once_intent;
ALTER TABLE golf_reviewer_runs DROP CONSTRAINT golf_reviewer_runs_identity;
ALTER TABLE golf_reviewer_runs DROP CONSTRAINT golf_reviewer_runs_state;
ALTER TABLE golf_reviewers DROP CONSTRAINT golf_reviewers_positive;

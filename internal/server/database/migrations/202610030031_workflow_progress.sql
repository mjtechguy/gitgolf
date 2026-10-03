-- +goose Up
CREATE TABLE golf_workflow_run_progress (
 run_id uuid NOT NULL REFERENCES golf_workflow_runs(id),
 attempt_id text NOT NULL CHECK(attempt_id ~ '^[a-f0-9]{32}$'),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 100),
 step_index integer NOT NULL CHECK(step_index BETWEEN 0 AND 49),
 kind text NOT NULL CHECK(kind IN ('started','finished')),
 exit_code integer CHECK(exit_code BETWEEN 0 AND 255),
 log_sequence bigint NOT NULL CHECK(log_sequence>=0),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,sequence),
 UNIQUE(run_id,step_index,kind),
 CHECK((kind='started' AND exit_code IS NULL) OR (kind='finished' AND exit_code IS NOT NULL))
);
CREATE TRIGGER golf_workflow_progress_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_workflow_run_progress FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN IF EXISTS(SELECT 1 FROM golf_workflow_run_progress) THEN RAISE EXCEPTION 'Preserve workflow progress before explicit downgrade'; END IF; END $$;
-- +goose StatementEnd
DROP TABLE golf_workflow_run_progress;

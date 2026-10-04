-- +goose Up
-- A native job/setup log has an exact admitted job instance but no step.
-- Preserve that original empty coordinate; never invent a source step.
ALTER TABLE golf_workflow_quarantined_outputs
 DROP CONSTRAINT golf_workflow_quarantined_outputs_step_id_check;
ALTER TABLE golf_workflow_quarantined_outputs
 ADD CONSTRAINT golf_workflow_quarantined_outputs_step_id_check
 CHECK(step_id='' OR step_id ~ '^[A-Za-z0-9_-]{1,64}$');
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained job-level encrypted output requires coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd

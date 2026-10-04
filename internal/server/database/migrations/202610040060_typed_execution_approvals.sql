-- +goose Up
ALTER TABLE golf_execution_binding_versions
 ADD COLUMN input_contract text NOT NULL DEFAULT '',
 ADD COLUMN input_schema_sha256 text NOT NULL DEFAULT '',
 ADD COLUMN submitted_inputs_sha256 text NOT NULL DEFAULT '',
 ADD COLUMN effective_inputs_sha256 text NOT NULL DEFAULT '';
ALTER TABLE golf_execution_binding_versions DROP CONSTRAINT golf_execution_binding_versions_engine_catalog_check;
ALTER TABLE golf_execution_binding_versions ADD CONSTRAINT golf_execution_binding_typed_inputs CHECK
 ((engine_catalog='golf.workflow.act.v0.2.89.linux.v1' AND input_contract='' AND input_schema_sha256='' AND submitted_inputs_sha256='' AND effective_inputs_sha256='') OR
  (engine_catalog='golf.workflow.act.v0.2.89.linux.v2' AND event='manual' AND event_ref='' AND input_contract='golf.workflow.dispatch.inputs.v1' AND input_schema_sha256 ~ '^[a-f0-9]{64}$' AND submitted_inputs_sha256 ~ '^[a-f0-9]{64}$' AND effective_inputs_sha256 ~ '^[a-f0-9]{64}$'));
-- Existing immutable versions remain unchanged. No input bodies or new credential
-- family are introduced; accepted maps remain in encrypted workflow inputs059.
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained typed execution approvals require coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd

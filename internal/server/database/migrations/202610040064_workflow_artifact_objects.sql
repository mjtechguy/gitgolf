-- +goose Up
-- Existing062 outputs remain byte-identical PostgreSQL records.
ALTER TABLE golf_workflow_artifacts ADD COLUMN storage text NOT NULL DEFAULT 'postgres' CHECK(storage IN ('postgres','env_s3','profile_s3'));
ALTER TABLE golf_workflow_artifacts ADD COLUMN object_key text NOT NULL DEFAULT '';
ALTER TABLE golf_workflow_artifacts ADD COLUMN object_fingerprint text NOT NULL DEFAULT '';
ALTER TABLE golf_workflow_artifacts ADD COLUMN object_profile_id uuid;
ALTER TABLE golf_workflow_artifacts ADD COLUMN object_profile_version bigint;
ALTER TABLE golf_workflow_artifacts ADD COLUMN archive_bytes bigint;
-- The existing immutable statement trigger must be restored before applications
-- can use this migration. This one metadata backfill never changes archive bytes.
DROP TRIGGER golf_workflow_artifacts_immutable ON golf_workflow_artifacts;
UPDATE golf_workflow_artifacts SET archive_bytes=octet_length(archive);
CREATE TRIGGER golf_workflow_artifacts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_workflow_artifacts FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
ALTER TABLE golf_workflow_artifacts ALTER COLUMN archive_bytes SET NOT NULL;
ALTER TABLE golf_workflow_artifacts ALTER COLUMN archive DROP NOT NULL;
ALTER TABLE golf_workflow_artifacts ADD CONSTRAINT golf_workflow_artifacts_archive_bytes CHECK(archive_bytes BETWEEN 1024 AND 10485760);
ALTER TABLE golf_workflow_artifacts ADD CONSTRAINT golf_workflow_artifact_object_binding CHECK(
 (storage='postgres' AND archive IS NOT NULL AND octet_length(archive)=archive_bytes AND object_key='' AND object_fingerprint='' AND object_profile_id IS NULL AND object_profile_version IS NULL)
 OR (storage IN ('env_s3','profile_s3') AND archive IS NULL AND object_key='ci-artifacts/'||run_id::text||'/'||attempt_id||'/'||archive_sha256||'.tar' AND
 ((storage='env_s3' AND object_fingerprint ~ '^[a-f0-9]{64}$' AND object_profile_id IS NULL AND object_profile_version IS NULL)
 OR (storage='profile_s3' AND object_fingerprint='' AND object_profile_id IS NOT NULL AND object_profile_version IS NOT NULL AND object_profile_version>0)))
);
ALTER TABLE golf_workflow_artifacts ADD CONSTRAINT golf_workflow_artifact_profile FOREIGN KEY(object_profile_id,object_profile_version) REFERENCES golf_infrastructure_connection_versions(profile_id,version) ON DELETE RESTRICT;
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION golf_workflow_artifact_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM golf_workflow_runs r WHERE r.id=NEW.run_id AND r.forge_url=NEW.forge_url AND r.repository_id=NEW.repository_id AND r.owner_id=NEW.owner_id AND r.commit_id=NEW.commit_id AND r.workflow_path=NEW.workflow_path AND r.blob_id=NEW.blob_id AND r.source_sha256=NEW.source_sha256 AND r.attempt_id=NEW.attempt_id AND r.engine_catalog='golf.workflow.shell.v1' AND r.format=2 AND r.plan ? 'artifactPaths' AND r.state='running' AND r.input_contract='' AND r.source_storage=NEW.storage AND r.source_fingerprint=NEW.object_fingerprint AND r.source_profile_id IS NOT DISTINCT FROM NEW.object_profile_id AND r.source_profile_version IS NOT DISTINCT FROM NEW.object_profile_version) OR EXISTS(SELECT 1 FROM golf_workflow_execution_bindings WHERE run_id=NEW.run_id) THEN RAISE EXCEPTION 'Artifact source or private execution binding invalid'; END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained artifact object references require coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd

-- +goose Up
ALTER TABLE golf_workflow_runs ALTER COLUMN source_archive DROP NOT NULL;
ALTER TABLE golf_workflow_runs ADD COLUMN source_storage text NOT NULL DEFAULT 'postgres' CHECK(source_storage IN ('postgres','env_s3','profile_s3'));
ALTER TABLE golf_workflow_runs ADD COLUMN source_key text NOT NULL DEFAULT '';
ALTER TABLE golf_workflow_runs ADD COLUMN source_fingerprint text NOT NULL DEFAULT '';
ALTER TABLE golf_workflow_runs ADD COLUMN source_profile_id uuid;
ALTER TABLE golf_workflow_runs ADD COLUMN source_profile_version bigint;
ALTER TABLE golf_workflow_runs ADD CONSTRAINT workflow_source_binding CHECK (
 (source_storage='postgres' AND source_archive IS NOT NULL AND source_key='' AND source_fingerprint='' AND source_profile_id IS NULL AND source_profile_version IS NULL)
 OR (source_storage='env_s3' AND source_archive IS NULL AND source_key ~ '^ci-sources/[a-f0-9]{64}\.tar$' AND source_fingerprint ~ '^[a-f0-9]{64}$' AND source_profile_id IS NULL AND source_profile_version IS NULL)
 OR (source_storage='profile_s3' AND source_archive IS NULL AND source_key ~ '^ci-sources/[a-f0-9]{64}\.tar$' AND source_fingerprint='' AND source_profile_id IS NOT NULL AND source_profile_version>0)
);
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_workflow_runs WHERE source_storage<>'postgres') THEN RAISE EXCEPTION 'Object-backed workflow sources exist; preserve references before explicit downgrade'; END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE golf_workflow_runs DROP CONSTRAINT workflow_source_binding;
ALTER TABLE golf_workflow_runs DROP COLUMN source_profile_version,DROP COLUMN source_profile_id,DROP COLUMN source_fingerprint,DROP COLUMN source_key,DROP COLUMN source_storage;
ALTER TABLE golf_workflow_runs ALTER COLUMN source_archive SET NOT NULL;

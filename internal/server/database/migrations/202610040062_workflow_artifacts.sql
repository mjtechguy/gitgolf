-- +goose Up
-- Bounded private PostgreSQL artifact profile. No public object URL or inline HTML.
CREATE TABLE golf_workflow_artifacts (
 run_id uuid PRIMARY KEY REFERENCES golf_workflow_runs(id),
 attempt_id text NOT NULL CHECK(attempt_id ~ '^[a-f0-9]{32}$'),
 forge_url text NOT NULL,
 repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),
 commit_id text NOT NULL CHECK(commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 workflow_path text NOT NULL,blob_id text NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 archive_sha256 text NOT NULL CHECK(archive_sha256 ~ '^[a-f0-9]{64}$'),
 file_count integer NOT NULL CHECK(file_count BETWEEN 1 AND 128),
 file_bytes bigint NOT NULL CHECK(file_bytes BETWEEN 0 AND 8388608),
 archive bytea NOT NULL CHECK(octet_length(archive) BETWEEN 1024 AND 10485760),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX golf_workflow_artifacts_repository ON golf_workflow_artifacts(forge_url,repository_id);
-- +goose StatementBegin
CREATE FUNCTION golf_workflow_artifact_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM golf_workflow_runs r WHERE r.id=NEW.run_id AND r.forge_url=NEW.forge_url AND r.repository_id=NEW.repository_id AND r.owner_id=NEW.owner_id AND r.commit_id=NEW.commit_id AND r.workflow_path=NEW.workflow_path AND r.blob_id=NEW.blob_id AND r.source_sha256=NEW.source_sha256 AND r.attempt_id=NEW.attempt_id AND r.engine_catalog='golf.workflow.shell.v1' AND r.format=2 AND r.plan ? 'artifactPaths' AND r.state='running' AND r.input_contract='') OR EXISTS(SELECT 1 FROM golf_workflow_execution_bindings WHERE run_id=NEW.run_id) THEN RAISE EXCEPTION 'Artifact source or private execution binding invalid'; END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER golf_workflow_artifact_binding BEFORE INSERT ON golf_workflow_artifacts FOR EACH ROW EXECUTE FUNCTION golf_workflow_artifact_binding();
CREATE TRIGGER golf_workflow_artifacts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_workflow_artifacts FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained workflow artifacts require coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd

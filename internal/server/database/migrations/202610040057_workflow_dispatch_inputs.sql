-- +goose Up
-- Immutable manual-input payloads remain encrypted for every terminal/history state.
-- Run admission, key inventory/rotation and qualified worker release are separate
-- coordinated consumers; this table does not grant execution authority.
CREATE TABLE golf_workflow_dispatch_inputs (
 run_id uuid PRIMARY KEY REFERENCES golf_workflow_runs(id),
 contract_version integer NOT NULL CHECK(contract_version=1),
 forge_url text NOT NULL CHECK(octet_length(forge_url) BETWEEN 1 AND 2048),
 user_id bigint NOT NULL REFERENCES golf_users(id),native_actor_id bigint NOT NULL CHECK(native_actor_id>0),
 repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),
 idempotency_key uuid NOT NULL,
 commit_id text NOT NULL CHECK(commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 workflow_path text NOT NULL CHECK(octet_length(workflow_path) BETWEEN 1 AND 255),
 blob_id text NOT NULL CHECK(blob_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 schema_sha256 text NOT NULL CHECK(schema_sha256 ~ '^[a-f0-9]{64}$'),
 submitted_sha256 text NOT NULL CHECK(submitted_sha256 ~ '^[a-f0-9]{64}$'),
 effective_sha256 text NOT NULL CHECK(effective_sha256 ~ '^[a-f0-9]{64}$'),
 payload_bytes integer NOT NULL CHECK(payload_bytes BETWEEN 1 AND 16512),
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 encrypted_content bytea NOT NULL CHECK(octet_length(encrypted_content)=payload_bytes+28),
 content_binding bytea NOT NULL CHECK(octet_length(content_binding)=32),credential_key_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX golf_workflow_dispatch_inputs_key_idx ON golf_workflow_dispatch_inputs(credential_key_id,run_id);
CREATE TRIGGER golf_workflow_dispatch_input_key_guard BEFORE INSERT OR UPDATE OF encrypted_content,credential_key_id ON golf_workflow_dispatch_inputs FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
-- +goose StatementBegin
CREATE FUNCTION golf_workflow_dispatch_input_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'encrypted_content'-'credential_key_id') IS DISTINCT FROM (to_jsonb(OLD)-'encrypted_content'-'credential_key_id') THEN RAISE EXCEPTION 'Immutable workflow dispatch input identity'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM golf_workflow_runs r WHERE r.id=NEW.run_id AND r.origin='manual' AND r.forge_url=NEW.forge_url AND r.user_id=NEW.user_id AND r.repository_id=NEW.repository_id AND r.owner_id=NEW.owner_id AND r.idempotency_key=NEW.idempotency_key AND r.commit_id=NEW.commit_id AND r.workflow_path=NEW.workflow_path AND r.blob_id=NEW.blob_id AND r.source_sha256=NEW.source_sha256) OR
   NOT EXISTS(SELECT 1 FROM golf_users u WHERE u.id=NEW.user_id AND u.forge_url=NEW.forge_url AND u.forge_user_id=NEW.native_actor_id) THEN RAISE EXCEPTION 'Workflow dispatch input run or actor binding invalid'; END IF;
 END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER golf_workflow_dispatch_input_identity BEFORE INSERT OR UPDATE ON golf_workflow_dispatch_inputs FOR EACH ROW EXECUTE FUNCTION golf_workflow_dispatch_input_identity();
CREATE TRIGGER golf_workflow_dispatch_inputs_no_delete BEFORE DELETE OR TRUNCATE ON golf_workflow_dispatch_inputs FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained workflow inputs require coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd

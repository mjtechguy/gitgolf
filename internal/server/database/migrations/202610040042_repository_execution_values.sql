-- +goose Up
-- Named metadata and immutable encrypted versions are separate: old keys remain
-- visible to recovery/rotation even after a value is deleted or a run is lost.
CREATE TABLE golf_execution_value_brokers (
 forge_url text NOT NULL,repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),PRIMARY KEY(forge_url,repository_id,owner_id)
);
CREATE TABLE golf_execution_values (
 id uuid PRIMARY KEY,forge_url text NOT NULL,repository_id bigint NOT NULL,owner_id bigint NOT NULL,
 name text NOT NULL CHECK(name ~ '^[A-Z][A-Z0-9_]{0,63}$'),kind text NOT NULL CHECK(kind IN ('secret','variable')),
 version bigint NOT NULL CHECK(version>0),deleted boolean NOT NULL DEFAULT false,value_bytes integer NOT NULL CHECK(value_bytes BETWEEN 1 AND 8192),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(forge_url,repository_id,owner_id) REFERENCES golf_execution_value_brokers,UNIQUE(forge_url,repository_id,owner_id,name)
);
CREATE TABLE golf_execution_value_versions (
 id uuid NOT NULL REFERENCES golf_execution_values(id),version bigint NOT NULL CHECK(version>0),value_bytes integer NOT NULL CHECK(value_bytes BETWEEN 1 AND 8192),
 encrypted_content bytea NOT NULL CHECK(octet_length(encrypted_content) BETWEEN 29 AND 8220),
 content_binding bytea NOT NULL CHECK(octet_length(content_binding)=32),credential_key_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(id,version)
);
CREATE INDEX golf_execution_value_versions_key_idx ON golf_execution_value_versions(credential_key_id,id,version);
CREATE TRIGGER golf_execution_value_key_guard BEFORE INSERT OR UPDATE OF encrypted_content,credential_key_id ON golf_execution_value_versions FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
CREATE TABLE golf_execution_bindings (
 id uuid PRIMARY KEY,forge_url text NOT NULL,repository_id bigint NOT NULL,owner_id bigint NOT NULL,
 version bigint NOT NULL CHECK(version>0),deleted boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(forge_url,repository_id,owner_id) REFERENCES golf_execution_value_brokers
);
CREATE TABLE golf_execution_binding_versions (
 id uuid NOT NULL REFERENCES golf_execution_bindings(id),version bigint NOT NULL CHECK(version>0),
 workflow_path text NOT NULL CHECK(length(workflow_path) BETWEEN 1 AND 4096),commit_id text NOT NULL CHECK(commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 blob_id text NOT NULL CHECK(blob_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 engine_catalog text NOT NULL CHECK(engine_catalog='golf.workflow.act.v0.2.89.linux.v1'),event text NOT NULL CHECK(event IN ('manual','push')),event_ref text NOT NULL,
 value_refs jsonb NOT NULL CHECK(jsonb_typeof(value_refs)='array' AND jsonb_array_length(value_refs) BETWEEN 1 AND 64 AND octet_length(value_refs::text)<=8192),
 approver_user_id bigint NOT NULL REFERENCES golf_users(id),approver_native_id bigint NOT NULL CHECK(approver_native_id>0),approval_session_hash bytea NOT NULL CHECK(octet_length(approval_session_hash)=32),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(id,version),CHECK(expires_at>created_at)
);
CREATE TABLE golf_execution_value_operations (
 forge_url text NOT NULL,repository_id bigint NOT NULL,owner_id bigint NOT NULL,user_id bigint NOT NULL REFERENCES golf_users(id),operation_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('save_value','delete_value','save_binding','delete_binding')),item_id uuid NOT NULL,
 accepted_version bigint NOT NULL CHECK(accepted_version>0),accepted_broker_revision bigint NOT NULL CHECK(accepted_broker_revision>0),
 request_metadata jsonb NOT NULL CHECK(octet_length(request_metadata::text)<=16384),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(forge_url,repository_id,owner_id,user_id,operation_id),FOREIGN KEY(forge_url,repository_id,owner_id) REFERENCES golf_execution_value_brokers
);
CREATE TABLE golf_workflow_execution_bindings (
 run_id uuid PRIMARY KEY REFERENCES golf_workflow_runs(id),binding_id uuid NOT NULL,binding_version bigint NOT NULL,
 output_state text NOT NULL DEFAULT 'withheld' CHECK(output_state IN ('withheld','redacted')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(binding_id,binding_version) REFERENCES golf_execution_binding_versions(id,version)
);
CREATE TABLE golf_workflow_quarantined_outputs (
 run_id uuid NOT NULL REFERENCES golf_workflow_execution_bindings(run_id),attempt_id text NOT NULL CHECK(attempt_id ~ '^[a-f0-9]{32}$'),sequence bigint NOT NULL CHECK(sequence BETWEEN 1 AND 16384),
 forge_url text NOT NULL,repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),
 job_instance_id text NOT NULL CHECK(job_instance_id ~ '^[a-f0-9]{32}$'),step_id text NOT NULL CHECK(step_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 raw_bytes integer NOT NULL CHECK(raw_bytes BETWEEN 1 AND 16384),encrypted_content bytea NOT NULL CHECK(octet_length(encrypted_content) BETWEEN 29 AND 16412),
 content_binding bytea NOT NULL CHECK(octet_length(content_binding)=32),credential_key_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(run_id,sequence)
);
CREATE INDEX golf_workflow_quarantined_outputs_key_idx ON golf_workflow_quarantined_outputs(credential_key_id,run_id,sequence);
CREATE TRIGGER golf_workflow_quarantined_key_guard BEFORE INSERT OR UPDATE OF encrypted_content,credential_key_id ON golf_workflow_quarantined_outputs FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
ALTER TABLE golf_crypto_events ADD COLUMN execution_values_count bigint NOT NULL DEFAULT 0 CHECK(execution_values_count>=0),ADD COLUMN quarantined_outputs_count bigint NOT NULL DEFAULT 0 CHECK(quarantined_outputs_count>=0);
-- +goose StatementBegin
CREATE FUNCTION golf_execution_value_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.forge_url,NEW.repository_id,NEW.owner_id,NEW.name,NEW.kind,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.forge_url,OLD.repository_id,OLD.owner_id,OLD.name,OLD.kind,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Immutable execution value identity or nonsequential version'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_execution_binding_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.forge_url,NEW.repository_id,NEW.owner_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.forge_url,OLD.repository_id,OLD.owner_id,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Immutable execution binding identity or nonsequential version'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_execution_cipher_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'encrypted_content'-'credential_key_id') IS DISTINCT FROM (to_jsonb(OLD)-'encrypted_content'-'credential_key_id') THEN RAISE EXCEPTION 'Immutable execution encrypted-content identity'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_workflow_binding_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.run_id,NEW.binding_id,NEW.binding_version,NEW.created_at) IS DISTINCT FROM ROW(OLD.run_id,OLD.binding_id,OLD.binding_version,OLD.created_at) OR OLD.output_state<>'withheld' OR NEW.output_state<>'redacted' THEN RAISE EXCEPTION 'Immutable workflow binding or invalid output release'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_execution_value_identity BEFORE UPDATE ON golf_execution_values FOR EACH ROW EXECUTE FUNCTION golf_execution_value_identity();
CREATE TRIGGER golf_execution_binding_identity BEFORE UPDATE ON golf_execution_bindings FOR EACH ROW EXECUTE FUNCTION golf_execution_binding_identity();
CREATE TRIGGER golf_execution_value_cipher_identity BEFORE UPDATE ON golf_execution_value_versions FOR EACH ROW EXECUTE FUNCTION golf_execution_cipher_identity();
CREATE TRIGGER golf_quarantined_output_cipher_identity BEFORE UPDATE ON golf_workflow_quarantined_outputs FOR EACH ROW EXECUTE FUNCTION golf_execution_cipher_identity();
CREATE TRIGGER golf_workflow_binding_identity BEFORE UPDATE ON golf_workflow_execution_bindings FOR EACH ROW EXECUTE FUNCTION golf_workflow_binding_identity();
-- +goose StatementEnd
CREATE TRIGGER golf_execution_values_no_delete BEFORE DELETE OR TRUNCATE ON golf_execution_values FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_execution_value_versions_no_delete BEFORE DELETE OR TRUNCATE ON golf_execution_value_versions FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_execution_bindings_no_delete BEFORE DELETE OR TRUNCATE ON golf_execution_bindings FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_execution_binding_versions_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_execution_binding_versions FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_execution_operations_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_execution_value_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_workflow_bindings_no_delete BEFORE DELETE OR TRUNCATE ON golf_workflow_execution_bindings FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_quarantined_outputs_no_delete BEFORE DELETE OR TRUNCATE ON golf_workflow_quarantined_outputs FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained execution values and quarantined output require coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd

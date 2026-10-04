-- +goose Up
-- Organization values have an immutable organization identity and independent
-- ciphertext domain. No repository ID, provider credential or secret plaintext
-- is fabricated/copied into this scope. Policy and content share one version.
CREATE TABLE golf_organization_execution_brokers (
 forge_url text NOT NULL,organization_id bigint NOT NULL CHECK(organization_id>0),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),PRIMARY KEY(forge_url,organization_id)
);
CREATE TABLE golf_organization_execution_values (
 id uuid PRIMARY KEY,forge_url text NOT NULL,organization_id bigint NOT NULL,
 name text NOT NULL CHECK(name ~ '^[A-Z][A-Z0-9_]{0,63}$'),kind text NOT NULL CHECK(kind IN ('secret','variable')),
 version bigint NOT NULL CHECK(version>0),deleted boolean NOT NULL DEFAULT false,value_bytes integer NOT NULL CHECK(value_bytes BETWEEN 1 AND 8192),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(forge_url,organization_id) REFERENCES golf_organization_execution_brokers,
 UNIQUE(forge_url,organization_id,name)
);
CREATE TABLE golf_organization_execution_versions (
 id uuid NOT NULL REFERENCES golf_organization_execution_values(id),version bigint NOT NULL CHECK(version>0),
 value_bytes integer NOT NULL CHECK(value_bytes BETWEEN 1 AND 8192),
 selected_repositories jsonb NOT NULL CHECK(jsonb_typeof(selected_repositories)='array' AND jsonb_array_length(selected_repositories)<=20 AND octet_length(selected_repositories::text)<=16384),
 approver_user_id bigint NOT NULL REFERENCES golf_users(id),approver_native_id bigint NOT NULL CHECK(approver_native_id>0),
 approval_session_hash bytea NOT NULL CHECK(octet_length(approval_session_hash)=32),expires_at timestamptz NOT NULL,
 encrypted_content bytea NOT NULL CHECK(octet_length(encrypted_content) BETWEEN 29 AND 8220),
 content_binding bytea NOT NULL CHECK(octet_length(content_binding)=32),credential_key_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(id,version),CHECK(expires_at>created_at)
);
CREATE INDEX golf_organization_execution_versions_key_idx ON golf_organization_execution_versions(credential_key_id,id,version);
CREATE TRIGGER golf_organization_execution_active_key BEFORE INSERT OR UPDATE OF encrypted_content,credential_key_id ON golf_organization_execution_versions FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
CREATE TABLE golf_organization_execution_operations (
 forge_url text NOT NULL,organization_id bigint NOT NULL,user_id bigint NOT NULL REFERENCES golf_users(id),operation_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('save_value','delete_value')),item_id uuid NOT NULL,
 accepted_version bigint NOT NULL CHECK(accepted_version>0),accepted_broker_revision bigint NOT NULL CHECK(accepted_broker_revision>0),
 request_metadata jsonb NOT NULL CHECK(octet_length(request_metadata::text)<=16384),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(forge_url,organization_id,user_id,operation_id),FOREIGN KEY(forge_url,organization_id) REFERENCES golf_organization_execution_brokers
);
ALTER TABLE golf_crypto_events ADD COLUMN organization_execution_values_count bigint NOT NULL DEFAULT 0 CHECK(organization_execution_values_count>=0);
-- +goose StatementBegin
CREATE FUNCTION golf_organization_execution_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.forge_url,NEW.organization_id,NEW.name,NEW.kind,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.forge_url,OLD.organization_id,OLD.name,OLD.kind,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Immutable organization execution value identity or nonsequential version'; END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER golf_organization_execution_identity BEFORE UPDATE ON golf_organization_execution_values FOR EACH ROW EXECUTE FUNCTION golf_organization_execution_identity();
CREATE TRIGGER golf_organization_execution_cipher_identity BEFORE UPDATE ON golf_organization_execution_versions FOR EACH ROW EXECUTE FUNCTION golf_execution_cipher_identity();
CREATE TRIGGER golf_organization_execution_values_no_delete BEFORE DELETE OR TRUNCATE ON golf_organization_execution_values FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_organization_execution_versions_no_delete BEFORE DELETE OR TRUNCATE ON golf_organization_execution_versions FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_organization_execution_operations_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_organization_execution_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained organization execution values require coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd

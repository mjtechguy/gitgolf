-- +goose Up
CREATE TABLE golf_infrastructure_connections (
 id uuid PRIMARY KEY,
 current_version bigint NOT NULL CHECK (current_version > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE golf_infrastructure_connection_versions (
 profile_id uuid NOT NULL REFERENCES golf_infrastructure_connections(id) ON DELETE RESTRICT,
 version bigint NOT NULL CHECK (version > 0),
 config jsonb NOT NULL,
 encrypted_credential bytea NOT NULL CHECK (octet_length(encrypted_credential) BETWEEN 28 AND 32768),
 credential_binding bytea NOT NULL CHECK (octet_length(credential_binding)=32),
 credential_key_id text NOT NULL CHECK (credential_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 actor_user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 actor_session_id bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (profile_id,version)
);
ALTER TABLE golf_workflow_runs ADD CONSTRAINT golf_workflow_source_profile FOREIGN KEY(source_profile_id,source_profile_version) REFERENCES golf_infrastructure_connection_versions(profile_id,version) ON DELETE RESTRICT;
CREATE INDEX golf_infrastructure_connection_key ON golf_infrastructure_connection_versions(credential_key_id,profile_id,version);
CREATE TRIGGER golf_infrastructure_connection_active_key BEFORE INSERT OR UPDATE OF encrypted_credential,credential_key_id ON golf_infrastructure_connection_versions
FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
-- Configuration/source bindings and actor evidence never change after a save;
-- only ciphertext/key labels may be rewritten by the existing operator rotation.
-- +goose StatementBegin
CREATE FUNCTION golf_infrastructure_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Infrastructure connection history is immutable'; END IF;
 IF NEW.profile_id <> OLD.profile_id OR NEW.version <> OLD.version OR NEW.config <> OLD.config OR NEW.credential_binding <> OLD.credential_binding OR NEW.actor_user_id <> OLD.actor_user_id OR NEW.actor_session_id <> OLD.actor_session_id OR NEW.created_at <> OLD.created_at THEN
  RAISE EXCEPTION 'Infrastructure connection history is immutable';
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_infrastructure_version_immutable BEFORE UPDATE OR DELETE ON golf_infrastructure_connection_versions FOR EACH ROW EXECUTE FUNCTION golf_infrastructure_version_immutable();
CREATE TRIGGER golf_infrastructure_no_truncate BEFORE TRUNCATE ON golf_infrastructure_connection_versions FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TABLE golf_active_object_connection (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 profile_id uuid, version bigint, revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 CHECK ((profile_id IS NULL)=(version IS NULL)),
 FOREIGN KEY(profile_id,version) REFERENCES golf_infrastructure_connection_versions(profile_id,version) ON DELETE RESTRICT
);
INSERT INTO golf_active_object_connection(singleton) VALUES(true);
CREATE TABLE golf_infrastructure_activation_events (
 revision bigint PRIMARY KEY CHECK(revision>0),
 profile_id uuid NOT NULL,version bigint NOT NULL,
 actor_user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 actor_session_id bigint NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(profile_id,version) REFERENCES golf_infrastructure_connection_versions(profile_id,version) ON DELETE RESTRICT
);
CREATE TRIGGER golf_infrastructure_activation_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_infrastructure_activation_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
ALTER TABLE golf_crypto_events ADD COLUMN infrastructure_connections_count bigint NOT NULL DEFAULT 0 CHECK(infrastructure_connections_count>=0);
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_infrastructure_connection_versions) THEN RAISE EXCEPTION 'Preserve infrastructure connection history before downgrade'; END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE golf_workflow_runs DROP CONSTRAINT golf_workflow_source_profile;
DROP TABLE golf_infrastructure_activation_events;
DROP TABLE golf_active_object_connection;
ALTER TABLE golf_crypto_events DROP COLUMN infrastructure_connections_count;
DROP TABLE golf_infrastructure_connection_versions;
DROP FUNCTION golf_infrastructure_version_immutable();
DROP TABLE golf_infrastructure_connections;

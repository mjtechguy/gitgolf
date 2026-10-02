-- +goose Up
CREATE TABLE golf_automation_grants (
 id uuid PRIMARY KEY,
 forge_url text NOT NULL,
 repository_id bigint NOT NULL CHECK(repository_id>0),
 owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL,
 repository_name text NOT NULL,
 organization_owned boolean NOT NULL,
 sponsor_user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 sponsor_native_user_id bigint NOT NULL CHECK(sponsor_native_user_id>0),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 revocation_epoch bigint NOT NULL DEFAULT 1 CHECK(revocation_epoch>0),
 enabled boolean NOT NULL DEFAULT true,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 idempotency_key uuid NOT NULL,
 input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32),
 UNIQUE(forge_url,sponsor_user_id,idempotency_key),
 branches jsonb NOT NULL CHECK(jsonb_typeof(branches)='array'),
 workflow_paths jsonb NOT NULL CHECK(jsonb_typeof(workflow_paths)='array'),
 CHECK(expires_at>created_at)
);
CREATE INDEX golf_automation_grants_repository ON golf_automation_grants(forge_url,repository_id,id);
CREATE TABLE golf_automation_credentials (
 grant_id uuid PRIMARY KEY REFERENCES golf_automation_grants(id) ON DELETE RESTRICT,
 version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 encrypted_credential bytea NOT NULL CHECK(octet_length(encrypted_credential) BETWEEN 28 AND 2048),
 credential_binding bytea NOT NULL CHECK(octet_length(credential_binding)=32),
 credential_key_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX golf_automation_credential_key ON golf_automation_credentials(credential_key_id,grant_id);
CREATE TRIGGER golf_automation_credential_active_key BEFORE INSERT OR UPDATE OF encrypted_credential,credential_key_id ON golf_automation_credentials FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
-- +goose StatementBegin
CREATE FUNCTION golf_automation_credential_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR NEW.grant_id<>OLD.grant_id OR NEW.version<>OLD.version OR NEW.credential_binding<>OLD.credential_binding OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'Automation credential identity is immutable';
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_automation_credential_immutable BEFORE UPDATE OR DELETE ON golf_automation_credentials FOR EACH ROW EXECUTE FUNCTION golf_automation_credential_immutable();
CREATE TRIGGER golf_automation_credential_no_truncate BEFORE TRUNCATE ON golf_automation_credentials FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TABLE golf_automation_grant_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 grant_id uuid NOT NULL REFERENCES golf_automation_grants(id) ON DELETE RESTRICT,
 revision bigint NOT NULL,
 action text NOT NULL CHECK(action IN ('CREATED','REVOKED','SPONSOR_DISABLED','RECOVERY_REVOKED')),
 actor_user_id bigint REFERENCES golf_users(id) ON DELETE RESTRICT,
 actor_session_id bigint,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(grant_id,revision),
 CHECK((action IN ('SPONSOR_DISABLED','RECOVERY_REVOKED') AND actor_user_id IS NULL AND actor_session_id IS NULL) OR (action NOT IN ('SPONSOR_DISABLED','RECOVERY_REVOKED') AND actor_user_id IS NOT NULL AND actor_session_id IS NOT NULL))
);
CREATE TRIGGER golf_automation_grant_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_automation_grant_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- A disabled local sponsor permanently revokes its grants. Re-enabling never
-- silently restores old delegated authority; logout/password changes are separate.
-- +goose StatementBegin
CREATE FUNCTION golf_automation_sponsor_disabled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL THEN
  WITH revoked AS (
   UPDATE golf_automation_grants SET enabled=false,revision=revision+1,revocation_epoch=revocation_epoch+1
   WHERE sponsor_user_id=NEW.user_id AND enabled RETURNING id,revision
  ) INSERT INTO golf_automation_grant_events(grant_id,revision,action) SELECT id,revision,'SPONSOR_DISABLED' FROM revoked;
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_automation_sponsor_disabled AFTER UPDATE OF disabled_at ON golf_local_accounts FOR EACH ROW EXECUTE FUNCTION golf_automation_sponsor_disabled();
ALTER TABLE golf_crypto_events ADD COLUMN automation_credentials_count bigint NOT NULL DEFAULT 0 CHECK(automation_credentials_count>=0);
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_automation_grants) THEN RAISE EXCEPTION 'Preserve automation grant history before downgrade'; END IF;
END $$;
-- +goose StatementEnd
DROP TRIGGER golf_automation_sponsor_disabled ON golf_local_accounts;
DROP FUNCTION golf_automation_sponsor_disabled();
DROP TABLE golf_automation_grant_events;
DROP TABLE golf_automation_credentials;
DROP FUNCTION golf_automation_credential_immutable();
DROP TABLE golf_automation_grants;
ALTER TABLE golf_crypto_events DROP COLUMN automation_credentials_count;

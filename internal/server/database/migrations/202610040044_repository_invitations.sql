-- +goose Up
-- Private metadata and explicit delegation to an EXISTING encrypted account.
-- No copied token/email proof and no native database or repository writes.
CREATE TABLE golf_repository_invitations (
 id uuid PRIMARY KEY,
 forge_url text NOT NULL,
 repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL,repository_name text NOT NULL,organization_owned boolean NOT NULL,
 issuer_user_id bigint NOT NULL REFERENCES golf_users(id),issuer_native_id bigint NOT NULL CHECK(issuer_native_id>0),
 issuer_login text NOT NULL,issuer_account_id bigint NOT NULL REFERENCES golf_local_accounts(id),issuer_account_version bigint NOT NULL CHECK(issuer_account_version>0),
 recipient_native_id bigint NOT NULL CHECK(recipient_native_id>0),recipient_login text NOT NULL,
 recipient_revision text NOT NULL CHECK(recipient_revision ~ '^[a-f0-9]{64}$'),
 permission text NOT NULL CHECK(permission IN ('read','write','admin')),
 access_revision text NOT NULL CHECK(access_revision ~ '^[a-f0-9]{64}$'),
 persistent_consent boolean NOT NULL CHECK(persistent_consent),
 expires_at timestamptz NOT NULL,revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','GRANTING','ACCEPTED','REJECTED','REVOKED','EXPIRED')),
 create_key text NOT NULL,input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(issuer_user_id,create_key),CHECK(issuer_native_id<>recipient_native_id)
);
CREATE UNIQUE INDEX golf_invitation_live_target ON golf_repository_invitations(forge_url,repository_id,recipient_native_id) WHERE state IN ('PENDING','GRANTING');
CREATE INDEX golf_invitation_inbox ON golf_repository_invitations(forge_url,recipient_native_id,created_at DESC,id DESC);
CREATE TABLE golf_repository_invitation_operations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 invitation_id uuid NOT NULL REFERENCES golf_repository_invitations(id),user_id bigint NOT NULL REFERENCES golf_users(id),
 idempotency_key text NOT NULL,invitation_revision bigint NOT NULL CHECK(invitation_revision>0),
 decision text NOT NULL CHECK(decision IN ('ACCEPT','REJECT')),input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,idempotency_key),CHECK((phase='REJECTED')=(failure_code='preflight_refused'))
);
CREATE UNIQUE INDEX golf_invitation_unresolved ON golf_repository_invitation_operations(invitation_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_repository_invitation_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,invitation_id uuid NOT NULL REFERENCES golf_repository_invitations(id),
 state text NOT NULL,revision bigint NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(invitation_id,revision)
);
CREATE TABLE golf_repository_invitation_operation_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,operation_id bigint NOT NULL REFERENCES golf_repository_invitation_operations(id),
 phase text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(operation_id,phase)
);
CREATE TRIGGER golf_invitation_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_invitations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_invitation_operation_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_invitation_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_invitation_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_invitation_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_invitation_operation_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_invitation_operation_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_invitation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM golf_repository_lifecycle_lock(NEW.forge_url,NEW.repository_id,false);
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM golf_repository_invitations WHERE issuer_user_id=NEW.issuer_user_id AND create_key=NEW.create_key) THEN RETURN NEW; END IF;
  IF NEW.state<>'PENDING' OR NEW.revision<>1 OR golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) THEN RAISE EXCEPTION 'Invitation admission unavailable' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','updated_at']) OR NEW.revision<>OLD.revision+1 OR
   NOT (OLD.state='PENDING' AND NEW.state IN ('GRANTING','REJECTED','REVOKED','EXPIRED') OR OLD.state='GRANTING' AND NEW.state='ACCEPTED') THEN RAISE EXCEPTION 'Invitation identity/state immutable'; END IF;
  IF NEW.state='GRANTING' AND golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) THEN RAISE EXCEPTION 'Invitation grant unavailable' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_invitation_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO golf_repository_invitation_events(invitation_id,state,revision) VALUES(NEW.id,NEW.state,NEW.revision);RETURN NEW;END; $$;
CREATE FUNCTION golf_invitation_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invitation golf_repository_invitations;
BEGIN
 SELECT * INTO invitation FROM golf_repository_invitations WHERE id=NEW.invitation_id;
 PERFORM golf_repository_lifecycle_lock(invitation.forge_url,invitation.repository_id,false);
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM golf_repository_invitation_operations WHERE user_id=NEW.user_id AND idempotency_key=NEW.idempotency_key) THEN RETURN NEW; END IF;
  IF NEW.phase<>'RESERVED' OR invitation.state<>'PENDING' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=invitation.forge_url AND forge_user_id=invitation.recipient_native_id) OR golf_repository_lifecycle_blocked(invitation.forge_url,invitation.repository_id) THEN RAISE EXCEPTION 'Invitation decision unavailable' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','updated_at']) OR
   NOT(OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','SUCCEEDED','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') OR
   NEW.phase='DISPATCH_UNKNOWN' AND NEW.decision<>'ACCEPT' OR OLD.phase='RESERVED' AND NEW.phase='SUCCEEDED' AND NEW.decision<>'REJECT' THEN RAISE EXCEPTION 'Invitation operation immutable'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_invitation_operation_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invitation golf_repository_invitations;
BEGIN
 INSERT INTO golf_repository_invitation_operation_events(operation_id,phase) VALUES(NEW.id,NEW.phase);
 -- The recipient gains access only after a verified native grant; no pending/private event leaks.
 IF NEW.phase='SUCCEEDED' AND NEW.decision='ACCEPT' THEN
  SELECT * INTO invitation FROM golf_repository_invitations WHERE id=NEW.invitation_id;
  PERFORM golf_append_repository_activity(invitation.forge_url,invitation.repository_id,0,'source');
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_invitation_account_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.disabled_at IS NOT NULL OR NEW.credential_version IS DISTINCT FROM OLD.credential_version THEN
  UPDATE golf_repository_invitations SET state='EXPIRED',revision=revision+1,updated_at=clock_timestamp() WHERE issuer_account_id=NEW.id AND state='PENDING' AND (NEW.disabled_at IS NOT NULL OR issuer_account_version<>NEW.credential_version);
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER golf_invitation_guard BEFORE INSERT OR UPDATE ON golf_repository_invitations FOR EACH ROW EXECUTE FUNCTION golf_invitation_guard();
CREATE TRIGGER golf_invitation_event AFTER INSERT OR UPDATE ON golf_repository_invitations FOR EACH ROW EXECUTE FUNCTION golf_invitation_event();
CREATE TRIGGER golf_invitation_operation_guard BEFORE INSERT OR UPDATE ON golf_repository_invitation_operations FOR EACH ROW EXECUTE FUNCTION golf_invitation_operation_guard();
CREATE TRIGGER golf_invitation_operation_event AFTER INSERT OR UPDATE ON golf_repository_invitation_operations FOR EACH ROW EXECUTE FUNCTION golf_invitation_operation_event();
CREATE TRIGGER golf_invitation_account_expiry AFTER UPDATE ON golf_local_accounts FOR EACH ROW EXECUTE FUNCTION golf_invitation_account_expiry();
-- Existing admission aggregate remains exact; unresolved invitation grants also block archive.
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_invitations;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$
 SELECT golf_repository_lifecycle_active_before_invitations(f,r)+(SELECT count(*) FROM golf_repository_invitation_operations o JOIN golf_repository_invitations i ON i.id=o.invitation_id WHERE i.forge_url=f AND i.repository_id=r AND o.phase IN ('RESERVED','DISPATCH_UNKNOWN'));
$$;
-- +goose StatementEnd
-- +goose Down
DO $$ BEGIN IF EXISTS(SELECT 1 FROM golf_repository_invitations) THEN RAISE EXCEPTION 'Preserve retained invitation/grant journals before explicit downgrade'; END IF; END $$;
DROP FUNCTION golf_repository_lifecycle_active(text,bigint);
ALTER FUNCTION golf_repository_lifecycle_active_before_invitations(text,bigint) RENAME TO golf_repository_lifecycle_active;
DROP TRIGGER golf_invitation_account_expiry ON golf_local_accounts;
DROP TABLE golf_repository_invitation_operation_events,golf_repository_invitation_events,golf_repository_invitation_operations,golf_repository_invitations;
DROP FUNCTION golf_invitation_guard(),golf_invitation_event(),golf_invitation_operation_guard(),golf_invitation_operation_event(),golf_invitation_account_expiry();

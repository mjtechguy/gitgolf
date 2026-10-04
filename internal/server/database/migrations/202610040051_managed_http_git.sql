-- +goose Up
-- Hash-only Git capabilities never enlarge the source managed session's authority.
-- An operator-reviewed fresh deployment receipt, not environment-variable self-certification.
CREATE TABLE golf_git_transport_profiles (
 forge_url text NOT NULL, incarnation uuid NOT NULL, native_version text NOT NULL CHECK(native_version='1.27.3'),
 qualifier_source_commit text NOT NULL CHECK(qualifier_source_commit ~ '^[a-f0-9]{40}$'),
 golf_image_digest text NOT NULL CHECK(golf_image_digest ~ '^sha256:[a-f0-9]{64}$'),
 native_image_digest text NOT NULL CHECK(native_image_digest ~ '^sha256:[a-f0-9]{64}$'),
 native_runtime_id text NOT NULL CHECK(native_runtime_id ~ '^[a-f0-9]{64}$'),
 receipt_sha256 text NOT NULL CHECK(receipt_sha256 ~ '^[a-f0-9]{64}$'),
 qualified_at timestamptz NOT NULL DEFAULT clock_timestamp(),suspended_at timestamptz,
 PRIMARY KEY(forge_url,incarnation)
);
CREATE TRIGGER golf_git_profile_no_delete BEFORE DELETE OR TRUNCATE ON golf_git_transport_profiles FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TABLE golf_git_credentials (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id), forge_url text NOT NULL,
 repository_id bigint NOT NULL CHECK(repository_id>0), owner_id bigint NOT NULL CHECK(owner_id>0),
 native_user_id bigint NOT NULL CHECK(native_user_id>0), source_session_id bigint NOT NULL,
 source_token_hash bytea NOT NULL CHECK(octet_length(source_token_hash)=32),
 token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32),
 label text NOT NULL CHECK(octet_length(label) BETWEEN 1 AND 64), mode text NOT NULL CHECK(mode IN ('READ','WRITE')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 revoked_at timestamptz,CHECK(expires_at>created_at)
);
CREATE INDEX golf_git_credentials_owner ON golf_git_credentials(user_id,forge_url,repository_id,id);
CREATE TABLE golf_git_receive_operations (
 id uuid PRIMARY KEY, forge_url text NOT NULL, repository_id bigint NOT NULL CHECK(repository_id>0),
 owner_id bigint NOT NULL CHECK(owner_id>0), user_id bigint NOT NULL REFERENCES golf_users(id),
 native_user_id bigint NOT NULL CHECK(native_user_id>0),credential_id bigint NOT NULL REFERENCES golf_git_credentials(id),
 command_hash bytea NOT NULL CHECK(octet_length(command_hash)=32), command_count integer NOT NULL CHECK(command_count BETWEEN 1 AND 32),
 phase text NOT NULL CHECK(phase IN ('RESERVED','COMPLETED','UNKNOWN')),
 accepted_count integer,rejected_count integer,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(credential_id,command_hash),
 CHECK((phase='COMPLETED')=(accepted_count IS NOT NULL AND rejected_count IS NOT NULL)),
 CHECK(accepted_count>=0 AND rejected_count>=0 AND accepted_count+rejected_count=command_count)
);
CREATE UNIQUE INDEX golf_git_receive_unresolved ON golf_git_receive_operations(forge_url,repository_id) WHERE phase IN ('RESERVED','UNKNOWN');
CREATE TABLE golf_git_receive_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,operation_id uuid NOT NULL REFERENCES golf_git_receive_operations(id),
 phase text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(operation_id,phase)
);
CREATE TRIGGER golf_git_credentials_no_delete BEFORE DELETE OR TRUNCATE ON golf_git_credentials FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_git_receive_no_delete BEFORE DELETE OR TRUNCATE ON golf_git_receive_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_git_receive_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_git_receive_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_git_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'suspended_at') IS DISTINCT FROM (to_jsonb(OLD)-'suspended_at') OR OLD.suspended_at IS NOT NULL OR NEW.suspended_at IS NULL THEN RAISE EXCEPTION 'Managed Git profile immutable; suspension is permanent'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER golf_git_profile_guard BEFORE UPDATE ON golf_git_transport_profiles FOR EACH ROW EXECUTE FUNCTION golf_git_profile_guard();
CREATE FUNCTION golf_git_credentials_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'Git capability immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER golf_git_credentials_guard BEFORE UPDATE ON golf_git_credentials FOR EACH ROW EXECUTE FUNCTION golf_git_credentials_guard();
ALTER FUNCTION golf_repository_lifecycle_blocked(text,bigint) RENAME TO golf_repository_lifecycle_blocked_before_git;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_blocked(f text,r bigint) RETURNS boolean LANGUAGE sql AS $$
 SELECT golf_repository_lifecycle_blocked_before_git(f,r) OR EXISTS(SELECT 1 FROM golf_git_receive_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','UNKNOWN'));
$$;
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_git;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$
 SELECT golf_repository_lifecycle_active_before_git(f,r)+(SELECT count(*) FROM golf_git_receive_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','UNKNOWN'));
$$;
CREATE FUNCTION golf_git_receive_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c golf_git_credentials;
BEGIN
 IF TG_OP='INSERT' THEN
  -- Application admission acquires managed-user/session locks then this exclusive scoped gate.
  -- Direct SQL is only a defensive backstop, not an ordinary-client authority mechanism.
  PERFORM golf_repository_lifecycle_lock(NEW.forge_url,NEW.repository_id,true);
  IF NEW.phase<>'RESERVED' OR golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) OR golf_repository_lifecycle_active_before_git(NEW.forge_url,NEW.repository_id)<>0 THEN RAISE EXCEPTION 'Git receive admission unavailable' USING ERRCODE='55000'; END IF;
  SELECT * INTO c FROM golf_git_credentials WHERE id=NEW.credential_id;
  IF NOT FOUND OR c.user_id<>NEW.user_id OR c.forge_url<>NEW.forge_url OR c.repository_id<>NEW.repository_id OR c.owner_id<>NEW.owner_id OR c.native_user_id<>NEW.native_user_id OR c.mode<>'WRITE' OR c.revoked_at IS NOT NULL OR c.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Git capability unavailable' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','accepted_count','rejected_count','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','accepted_count','rejected_count','updated_at']) OR NOT(OLD.phase='RESERVED' AND NEW.phase='UNKNOWN' OR OLD.phase='UNKNOWN' AND NEW.phase='COMPLETED') THEN RAISE EXCEPTION 'Git receive immutable or unresolved'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_git_receive_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO golf_git_receive_events(operation_id,phase) VALUES(NEW.id,NEW.phase);
 IF NEW.phase='COMPLETED' AND NEW.accepted_count>0 THEN PERFORM golf_append_repository_activity(NEW.forge_url,NEW.repository_id,0,'source'); END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER golf_git_receive_guard BEFORE INSERT OR UPDATE ON golf_git_receive_operations FOR EACH ROW EXECUTE FUNCTION golf_git_receive_guard();
CREATE TRIGGER golf_git_receive_event AFTER INSERT OR UPDATE ON golf_git_receive_operations FOR EACH ROW EXECUTE FUNCTION golf_git_receive_event();
-- +goose StatementEnd
-- +goose Down
DO $$ BEGIN IF EXISTS(SELECT 1 FROM golf_git_transport_profiles) OR EXISTS(SELECT 1 FROM golf_git_credentials) OR EXISTS(SELECT 1 FROM golf_git_receive_operations) THEN RAISE EXCEPTION 'Preserve retained Git capability and receive metadata before explicit downgrade'; END IF; END $$;
DROP FUNCTION golf_repository_lifecycle_active(text,bigint);
ALTER FUNCTION golf_repository_lifecycle_active_before_git(text,bigint) RENAME TO golf_repository_lifecycle_active;
DROP FUNCTION golf_repository_lifecycle_blocked(text,bigint);
ALTER FUNCTION golf_repository_lifecycle_blocked_before_git(text,bigint) RENAME TO golf_repository_lifecycle_blocked;
DROP TABLE golf_git_receive_events,golf_git_receive_operations,golf_git_credentials,golf_git_transport_profiles;
DROP FUNCTION golf_git_profile_guard(),golf_git_credentials_guard(),golf_git_receive_guard(),golf_git_receive_event();

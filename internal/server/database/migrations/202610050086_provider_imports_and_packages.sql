-- +goose Up
CREATE TABLE golf_provider_connections (
 id uuid PRIMARY KEY,user_id bigint NOT NULL REFERENCES golf_users(id),forge_url text NOT NULL,actor_id bigint NOT NULL CHECK(actor_id>0),provider text NOT NULL CHECK(provider IN ('github','gitlab')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),provider_account_id text NOT NULL,provider_login text NOT NULL,version bigint NOT NULL DEFAULT 1 CHECK(version>0),revoked boolean NOT NULL DEFAULT false,
 encrypted_credential bytea NOT NULL,credential_binding bytea NOT NULL CHECK(octet_length(credential_binding)=32),credential_key_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,forge_url,id)
);
CREATE INDEX golf_provider_connection_owner ON golf_provider_connections(user_id,forge_url,created_at,id);
CREATE TABLE golf_provider_connection_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,connection_id uuid NOT NULL REFERENCES golf_provider_connections(id),version bigint NOT NULL,action text NOT NULL CHECK(action IN ('CREATED','RENAMED','REVOKED')),occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(connection_id,version));
CREATE TRIGGER golf_provider_connections_no_delete BEFORE DELETE OR TRUNCATE ON golf_provider_connections FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_provider_connection_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_provider_connection_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_provider_connection_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.revoked OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid provider connection identity';END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['version','name','revoked','encrypted_credential','credential_key_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','name','revoked','encrypted_credential','credential_key_id']) THEN RAISE EXCEPTION 'Provider connection identity immutable';END IF;
  IF NEW.version=OLD.version THEN
   IF NEW.name<>OLD.name OR NEW.revoked<>OLD.revoked THEN RAISE EXCEPTION 'Provider connection update requires version';END IF;
  ELSE
   IF NEW.version<>OLD.version+1 OR OLD.revoked OR (NEW.encrypted_credential,NEW.credential_key_id) IS DISTINCT FROM (OLD.encrypted_credential,OLD.credential_key_id) THEN RAISE EXCEPTION 'Provider connection state transition invalid';END IF;
  END IF;
 END IF;
 IF TG_OP='INSERT' OR (NEW.encrypted_credential,NEW.credential_key_id) IS DISTINCT FROM (OLD.encrypted_credential,OLD.credential_key_id) THEN
  IF NEW.credential_key_id IS DISTINCT FROM (SELECT active_key_id FROM golf_encryption_policy WHERE singleton=true) THEN RAISE EXCEPTION 'Provider credential must use active key';END IF;
 END IF;RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_provider_connection_active_key BEFORE INSERT OR UPDATE OF encrypted_credential,credential_key_id ON golf_provider_connections FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
CREATE TRIGGER golf_provider_connection_guard BEFORE INSERT OR UPDATE ON golf_provider_connections FOR EACH ROW EXECUTE FUNCTION golf_provider_connection_guard();
CREATE TABLE golf_provider_import_operations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id bigint NOT NULL REFERENCES golf_users(id),forge_url text NOT NULL,actor_id bigint NOT NULL CHECK(actor_id>0),operation_id uuid NOT NULL,
 connection_id uuid NOT NULL REFERENCES golf_provider_connections(id),connection_version bigint NOT NULL CHECK(connection_version>0),source_url text NOT NULL,provider_repository_id text NOT NULL,source_head_commit_id text NOT NULL CHECK(source_head_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 destination_name text NOT NULL,input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32),phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 repository_id bigint NOT NULL DEFAULT 0 CHECK(repository_id>=0),failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,forge_url,operation_id),CHECK((phase='REJECTED')=(failure_code='preflight_refused')),CHECK((phase='SUCCEEDED')=(repository_id>0))
);
CREATE UNIQUE INDEX golf_provider_import_unresolved ON golf_provider_import_operations(forge_url,user_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_provider_import_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,operation_id bigint NOT NULL REFERENCES golf_provider_import_operations(id),phase text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(operation_id,phase));
CREATE TRIGGER golf_provider_import_no_delete BEFORE DELETE OR TRUNCATE ON golf_provider_import_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_provider_import_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_provider_import_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_provider_import_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.forge_url||'/provider-import-admission',0));
  IF (SELECT count(*) FROM golf_provider_import_operations WHERE forge_url=NEW.forge_url AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))>=2 THEN RAISE EXCEPTION 'Provider import admission full';END IF;
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_provider_connections WHERE id=NEW.connection_id AND user_id=NEW.user_id AND forge_url=NEW.forge_url AND actor_id=NEW.actor_id AND version=NEW.connection_version AND NOT revoked) THEN RAISE EXCEPTION 'Invalid import reservation';END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','repository_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','repository_id']) OR NOT(OLD.phase='RESERVED' AND NEW.phase IN ('REJECTED','DISPATCH_UNKNOWN') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') THEN RAISE EXCEPTION 'Provider import immutable';END IF;
 END IF;RETURN NEW;
END; $$;
CREATE FUNCTION golf_provider_import_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO golf_provider_import_events(operation_id,phase) VALUES(NEW.id,NEW.phase);RETURN NEW;END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_provider_import_guard BEFORE INSERT OR UPDATE ON golf_provider_import_operations FOR EACH ROW EXECUTE FUNCTION golf_provider_import_guard();
CREATE TRIGGER golf_provider_import_event AFTER INSERT OR UPDATE ON golf_provider_import_operations FOR EACH ROW EXECUTE FUNCTION golf_provider_import_event();
CREATE TABLE golf_package_publications (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id bigint NOT NULL REFERENCES golf_users(id),forge_url text NOT NULL,actor_id bigint NOT NULL CHECK(actor_id>0),operation_id uuid NOT NULL,
 repository_owner text NOT NULL,repository_name text NOT NULL,repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),access_revision text NOT NULL CHECK(access_revision ~ '^[a-f0-9]{64}$'),
 package_name text NOT NULL,version text NOT NULL,file_name text NOT NULL,input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32),content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),content_size bigint NOT NULL CHECK(content_size BETWEEN 0 AND 262144),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),result_package_id bigint NOT NULL DEFAULT 0,result_file_id bigint NOT NULL DEFAULT 0,
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),UNIQUE(user_id,forge_url,operation_id),CHECK((phase='REJECTED')=(failure_code='preflight_refused')),CHECK((phase='SUCCEEDED' AND result_package_id>0 AND result_file_id>0) OR (phase<>'SUCCEEDED' AND result_package_id=0 AND result_file_id=0))
);
CREATE UNIQUE INDEX golf_package_publication_unresolved ON golf_package_publications(forge_url,owner_id,package_name) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_package_publication_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,operation_id bigint NOT NULL REFERENCES golf_package_publications(id),phase text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(operation_id,phase));
CREATE TRIGGER golf_package_publication_no_delete BEFORE DELETE OR TRUNCATE ON golf_package_publications FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_package_publication_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_package_publication_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_package_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_repository_lifecycle_lock(NEW.forge_url,NEW.repository_id,true);
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid package publication identity';END IF;
  IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=NEW.forge_url AND (repository_id=NEW.repository_id OR source_repository_id=NEW.repository_id) AND phase IN ('RESERVED','DISPATCH_UNKNOWN')) THEN RAISE EXCEPTION 'Repository operation unresolved';END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','result_package_id','result_file_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','result_package_id','result_file_id']) OR NOT(OLD.phase='RESERVED' AND NEW.phase IN ('REJECTED','DISPATCH_UNKNOWN') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') THEN RAISE EXCEPTION 'Package publication immutable';END IF;
 END IF;RETURN NEW;
END; $$;
CREATE FUNCTION golf_package_publication_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO golf_package_publication_events(operation_id,phase) VALUES(NEW.id,NEW.phase);RETURN NEW;END; $$;
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_package_publication;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_package_publication(f,r)+(SELECT count(*) FROM golf_package_publications WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
ALTER FUNCTION golf_repository_lifecycle_blocked(text,bigint) RENAME TO golf_repository_lifecycle_blocked_before_package_publication;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_blocked(f text,r bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_blocked_before_package_publication(f,r) OR EXISTS(SELECT 1 FROM golf_package_publications WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
CREATE TRIGGER golf_package_publication_guard BEFORE INSERT OR UPDATE ON golf_package_publications FOR EACH ROW EXECUTE FUNCTION golf_package_publication_guard();
CREATE TRIGGER golf_package_publication_event AFTER INSERT OR UPDATE ON golf_package_publications FOR EACH ROW EXECUTE FUNCTION golf_package_publication_event();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Provider import evidence/credentials require qualified recovery; no downgrade';END $$;
-- +goose StatementEnd

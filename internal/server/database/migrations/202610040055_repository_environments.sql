-- +goose Up
-- Local configuration only; no deployment credentials or dispatch capability.
CREATE TABLE golf_repository_environments (
 forge_url text NOT NULL, id uuid NOT NULL, repository_id bigint NOT NULL CHECK(repository_id>0), owner_id bigint NOT NULL CHECK(owner_id>0),
 name_key text NOT NULL CHECK(octet_length(name_key) BETWEEN 1 AND 512), current_version bigint NOT NULL CHECK(current_version>0), deleted boolean NOT NULL,
 PRIMARY KEY(forge_url,id)
);
CREATE UNIQUE INDEX golf_repository_environment_names ON golf_repository_environments(forge_url,repository_id,owner_id,name_key) WHERE NOT deleted;
CREATE TABLE golf_repository_environment_versions (
 forge_url text NOT NULL, environment_id uuid NOT NULL, repository_id bigint NOT NULL CHECK(repository_id>0), owner_id bigint NOT NULL CHECK(owner_id>0),
 version bigint NOT NULL CHECK(version>0), name text NOT NULL CHECK(octet_length(name) BETWEEN 1 AND 128), deleted boolean NOT NULL,
 policy bytea NOT NULL CHECK(octet_length(policy) BETWEEN 1 AND 16384),
 creator_user_id bigint NOT NULL REFERENCES golf_users(id), creator_native_id bigint NOT NULL CHECK(creator_native_id>0),
 actor_user_id bigint NOT NULL REFERENCES golf_users(id), actor_native_id bigint NOT NULL CHECK(actor_native_id>0),
 repository_owner text NOT NULL, repository_name text NOT NULL, access_revision text NOT NULL CHECK(access_revision ~ '^[a-f0-9]{64}$'),
 environment_created_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(forge_url,environment_id,version), FOREIGN KEY(forge_url,environment_id) REFERENCES golf_repository_environments(forge_url,id), CHECK(created_at>=environment_created_at)
);
ALTER TABLE golf_repository_environments ADD CONSTRAINT golf_environment_current_version FOREIGN KEY(forge_url,id,current_version) REFERENCES golf_repository_environment_versions(forge_url,environment_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE golf_repository_environment_operations (
 user_id bigint NOT NULL REFERENCES golf_users(id), operation_id uuid NOT NULL, forge_url text NOT NULL,
 environment_id uuid NOT NULL, repository_id bigint NOT NULL CHECK(repository_id>0), owner_id bigint NOT NULL CHECK(owner_id>0),
 action text NOT NULL CHECK(action IN ('save','delete')), expected_version bigint NOT NULL CHECK(expected_version>=0), version bigint NOT NULL CHECK(version=expected_version+1),
 input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32), created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,operation_id), UNIQUE(forge_url,environment_id,version), FOREIGN KEY(forge_url,environment_id,version) REFERENCES golf_repository_environment_versions(forge_url,environment_id,version),
 CHECK(action<>'delete' OR expected_version>0)
);
CREATE INDEX golf_environment_inventory ON golf_repository_environments(forge_url,repository_id,owner_id,current_version) WHERE NOT deleted;
CREATE TRIGGER golf_environment_versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_environment_versions FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_environment_operations_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_environment_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_environments_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_environments FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_repository_environment_lock(f text,r bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM golf_repository_lifecycle_lock(f,r,false);
 PERFORM pg_advisory_xact_lock(hashtextextended(f||'/repository-environments/'||r::text,0));
END; $$;
CREATE FUNCTION golf_environment_current_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM golf_repository_environment_lock(NEW.forge_url,NEW.repository_id);
 IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) THEN RAISE EXCEPTION 'Repository lifecycle blocks environment change' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.current_version<>1 OR NEW.deleted THEN RAISE EXCEPTION 'Invalid new environment'; END IF;
 ELSE
  IF OLD.deleted OR NEW.forge_url<>OLD.forge_url OR NEW.id<>OLD.id OR NEW.repository_id<>OLD.repository_id OR NEW.owner_id<>OLD.owner_id OR NEW.current_version<>OLD.current_version+1 THEN RAISE EXCEPTION 'Environment identity/tombstone/version immutable' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_environment_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_row golf_repository_environments;
BEGIN
 SELECT * INTO current_row FROM golf_repository_environments WHERE forge_url=NEW.forge_url AND id=NEW.environment_id;
 IF NOT FOUND OR current_row.repository_id<>NEW.repository_id OR current_row.owner_id<>NEW.owner_id OR current_row.current_version<>NEW.version OR current_row.deleted<>NEW.deleted OR current_row.name_key<>lower(NEW.name) THEN RAISE EXCEPTION 'Environment snapshot does not match selected version'; END IF;
 IF NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.actor_user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_native_id) OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.creator_user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.creator_native_id) THEN RAISE EXCEPTION 'Environment actor binding invalid'; END IF;
 IF NEW.version>1 AND NOT EXISTS(SELECT 1 FROM golf_repository_environment_versions WHERE forge_url=NEW.forge_url AND environment_id=NEW.environment_id AND version=1 AND creator_user_id=NEW.creator_user_id AND creator_native_id=NEW.creator_native_id AND environment_created_at=NEW.environment_created_at) THEN RAISE EXCEPTION 'Environment creation metadata changed'; END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_environment_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM golf_repository_environment_versions v WHERE v.forge_url=NEW.forge_url AND v.environment_id=NEW.environment_id AND v.version=NEW.version AND v.repository_id=NEW.repository_id AND v.owner_id=NEW.owner_id AND v.actor_user_id=NEW.user_id AND v.created_at=NEW.created_at AND v.deleted=(NEW.action='delete')) THEN RAISE EXCEPTION 'Environment operation binding invalid'; END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_environment_current_guard BEFORE INSERT OR UPDATE ON golf_repository_environments FOR EACH ROW EXECUTE FUNCTION golf_environment_current_guard();
CREATE TRIGGER golf_environment_snapshot_guard BEFORE INSERT ON golf_repository_environment_versions FOR EACH ROW EXECUTE FUNCTION golf_environment_snapshot_guard();
CREATE TRIGGER golf_environment_operation_guard BEFORE INSERT ON golf_repository_environment_operations FOR EACH ROW EXECUTE FUNCTION golf_environment_operation_guard();
-- No native effect/reservation is created. All three rows commit atomically.
-- Do not replace any existing lifecycle admission aggregate for configuration.
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained environment configuration requires qualified offline recovery'; END $$;
-- +goose StatementEnd

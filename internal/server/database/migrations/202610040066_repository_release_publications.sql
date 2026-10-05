-- +goose Up
-- Plaintext title/notes never enter the retained operation journal.
CREATE TABLE golf_repository_release_publications (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id), forge_url text NOT NULL,
 actor_id bigint NOT NULL CHECK(actor_id>0),
 operation_id text NOT NULL CHECK(operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 repository_id bigint NOT NULL CHECK(repository_id>0), owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL, repository_name text NOT NULL,
 access_revision text NOT NULL CHECK(access_revision ~ '^[a-f0-9]{64}$'),
 tag_name text NOT NULL CHECK(octet_length(tag_name) BETWEEN 1 AND 1024),
 tag_object_id text NOT NULL CHECK(tag_object_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 commit_id text NOT NULL CHECK(commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND length(commit_id)=length(tag_object_id)),
 title_sha256 text NOT NULL CHECK(title_sha256 ~ '^[a-f0-9]{64}$'),
 body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
 prerelease boolean NOT NULL,
 input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 release_id bigint NOT NULL DEFAULT 0 CHECK(release_id>=0),
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,forge_url,operation_id),
 CHECK((phase='REJECTED')=(failure_code='preflight_refused')),
 CHECK((phase='SUCCEEDED')=(release_id>0))
);
-- One unresolved publication per repository excludes competing metadata writes;
-- successful history does not exclude another tag's explicitly requested release.
CREATE UNIQUE INDEX golf_release_publications_unresolved ON golf_repository_release_publications(forge_url,repository_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_repository_release_publication_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 operation_id bigint NOT NULL REFERENCES golf_repository_release_publications(id),
 phase text NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(operation_id,phase)
);
CREATE TRIGGER golf_release_publications_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_release_publications FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_release_publication_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_release_publication_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_release_publication_lock(f text,r bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_repository_lifecycle_lock(f,r,false);
 PERFORM pg_advisory_xact_lock(hashtextextended(f||'/release-publication/'||r::text,0));
END; $$;
CREATE FUNCTION golf_release_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_release_publication_lock(NEW.forge_url,NEW.repository_id);
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid release publication reservation'; END IF;
  IF EXISTS(SELECT 1 FROM golf_repository_release_publications WHERE user_id=NEW.user_id AND forge_url=NEW.forge_url AND operation_id=NEW.operation_id) THEN RETURN NEW; END IF;
  IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) THEN RAISE EXCEPTION 'Release publication or lifecycle unresolved' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','release_id','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','release_id','updated_at']) OR NOT(OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') THEN RAISE EXCEPTION 'Release publication identity/outcome immutable'; END IF;
  NEW.updated_at=greatest(clock_timestamp(),OLD.updated_at);
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_release_publication_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO golf_repository_release_publication_events(operation_id,phase) VALUES(NEW.id,NEW.phase);
 RETURN NEW;
END; $$;
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_release_publication;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_release_publication(f,r)+(SELECT count(*) FROM golf_repository_release_publications WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
ALTER FUNCTION golf_repository_lifecycle_blocked(text,bigint) RENAME TO golf_repository_lifecycle_blocked_before_release_publication;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_blocked(f text,r bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_blocked_before_release_publication(f,r) OR EXISTS(SELECT 1 FROM golf_repository_release_publications WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
CREATE TRIGGER golf_release_publication_guard BEFORE INSERT OR UPDATE ON golf_repository_release_publications FOR EACH ROW EXECUTE FUNCTION golf_release_publication_guard();
CREATE TRIGGER golf_release_publication_event AFTER INSERT OR UPDATE ON golf_repository_release_publications FOR EACH ROW EXECUTE FUNCTION golf_release_publication_event();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained native publication outcomes require qualified offline recovery; no automatic downgrade'; END $$;
-- +goose StatementEnd

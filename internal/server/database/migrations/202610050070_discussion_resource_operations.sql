-- +goose Up
CREATE TABLE golf_discussion_resource_operations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id), forge_url text NOT NULL, actor_id bigint NOT NULL CHECK(actor_id>0),
 operation_id text NOT NULL CHECK(operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 repository_id bigint NOT NULL CHECK(repository_id>0), repository_owner text NOT NULL, repository_name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('CREATE_LABEL','UPDATE_LABEL','DELETE_LABEL','CREATE_MILESTONE','UPDATE_MILESTONE','DELETE_MILESTONE','UPDATE_COMMENT','DELETE_COMMENT')),
 resource_id bigint NOT NULL CHECK(resource_id>=0), observed_resource_id bigint NOT NULL DEFAULT 0 CHECK(observed_resource_id>=0),
 expected_revision text NOT NULL, comment_author_id bigint NOT NULL DEFAULT 0 CHECK(comment_author_id>=0),
 issue_id bigint NOT NULL DEFAULT 0 CHECK(issue_id>=0), issue_number bigint NOT NULL DEFAULT 0 CHECK(issue_number BETWEEN 0 AND 2147483647), pull_request boolean NOT NULL DEFAULT false,
 input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,forge_url,operation_id), CHECK((phase='REJECTED')=(failure_code='preflight_refused')),
 CHECK((kind LIKE 'CREATE_%' AND resource_id=0 AND expected_revision='') OR (kind NOT LIKE 'CREATE_%' AND resource_id>0 AND expected_revision ~ '^[a-f0-9]{64}$')),
 CHECK((kind IN ('UPDATE_COMMENT','DELETE_COMMENT') AND issue_id>0 AND issue_number>0 AND comment_author_id>0) OR (kind NOT IN ('UPDATE_COMMENT','DELETE_COMMENT') AND issue_id=0 AND issue_number=0 AND NOT pull_request AND comment_author_id=0)),
 CHECK(phase<>'SUCCEEDED' OR observed_resource_id>0)
);
CREATE UNIQUE INDEX golf_discussion_resources_unresolved ON golf_discussion_resource_operations(forge_url,repository_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_discussion_resource_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, operation_id bigint NOT NULL REFERENCES golf_discussion_resource_operations(id),
 phase text NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(operation_id,phase)
);
CREATE TRIGGER golf_discussion_resources_no_delete BEFORE DELETE OR TRUNCATE ON golf_discussion_resource_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_discussion_resource_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_discussion_resource_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_discussion_resource_lock(f text,r bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_repository_lifecycle_lock(f,r,true);
 PERFORM pg_advisory_xact_lock(hashtextextended(f||'/discussion-resource/'||r::text,0));
END; $$;
CREATE FUNCTION golf_discussion_resource_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_discussion_resource_lock(NEW.forge_url,NEW.repository_id);
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'RESERVED' OR NEW.observed_resource_id<>0 OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid discussion resource reservation'; END IF;
  IF EXISTS(SELECT 1 FROM golf_discussion_resource_operations WHERE user_id=NEW.user_id AND forge_url=NEW.forge_url AND operation_id=NEW.operation_id) THEN RETURN NEW; END IF;
  IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=NEW.forge_url AND (repository_id=NEW.repository_id OR source_repository_id=NEW.repository_id) AND phase IN ('RESERVED','DISPATCH_UNKNOWN')) THEN RAISE EXCEPTION 'Discussion resource or lifecycle unresolved' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','observed_resource_id','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','observed_resource_id','updated_at']) OR NOT(OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') AND NEW.observed_resource_id=0 OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED' AND NEW.observed_resource_id>0 AND (NEW.kind LIKE 'CREATE_%' OR NEW.observed_resource_id=NEW.resource_id)) THEN RAISE EXCEPTION 'Discussion resource identity/outcome immutable'; END IF;
  NEW.updated_at=greatest(clock_timestamp(),OLD.updated_at);
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_discussion_resource_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO golf_discussion_resource_events(operation_id,phase) VALUES(NEW.id,NEW.phase); RETURN NEW;
END; $$;
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_discussion_resource;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_discussion_resource(f,r)+(SELECT count(*) FROM golf_discussion_resource_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
ALTER FUNCTION golf_repository_lifecycle_blocked(text,bigint) RENAME TO golf_repository_lifecycle_blocked_before_discussion_resource;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_blocked(f text,r bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_blocked_before_discussion_resource(f,r) OR EXISTS(SELECT 1 FROM golf_discussion_resource_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
CREATE TRIGGER golf_discussion_resource_guard BEFORE INSERT OR UPDATE ON golf_discussion_resource_operations FOR EACH ROW EXECUTE FUNCTION golf_discussion_resource_guard();
CREATE TRIGGER golf_discussion_resource_event AFTER INSERT OR UPDATE ON golf_discussion_resource_operations FOR EACH ROW EXECUTE FUNCTION golf_discussion_resource_event();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained discussion resource outcomes require qualified offline recovery; no automatic downgrade'; END $$;
-- +goose StatementEnd

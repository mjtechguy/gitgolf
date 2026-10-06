-- +goose Up
CREATE TABLE golf_pull_review_authoring_operations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id), forge_url text NOT NULL, actor_id bigint NOT NULL CHECK(actor_id>0),
 operation_id text NOT NULL CHECK(operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 repository_id bigint NOT NULL CHECK(repository_id>0), original bytea NOT NULL CHECK(octet_length(original) BETWEEN 1 AND 4096),
 input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32),
 observed_review_id bigint NOT NULL DEFAULT 0 CHECK(observed_review_id>=0),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,forge_url,operation_id), CHECK((phase='REJECTED')=(failure_code='preflight_refused'))
);
CREATE UNIQUE INDEX golf_review_authorings_unresolved ON golf_pull_review_authoring_operations(forge_url,repository_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_pull_review_authoring_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, operation_id bigint NOT NULL REFERENCES golf_pull_review_authoring_operations(id),
 phase text NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(operation_id,phase)
);
CREATE TRIGGER golf_review_authorings_no_delete BEFORE DELETE OR TRUNCATE ON golf_pull_review_authoring_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_review_authoring_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_pull_review_authoring_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_review_authoring_lock(f text,r bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_repository_lifecycle_lock(f,r,true);
 PERFORM pg_advisory_xact_lock(hashtextextended(f||'/review-request/'||r::text,0));
END; $$;
CREATE FUNCTION golf_review_authoring_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_review_authoring_lock(NEW.forge_url,NEW.repository_id);
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'RESERVED' OR NEW.observed_review_id<>0 OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid review authoring reservation'; END IF;
  IF EXISTS(SELECT 1 FROM golf_pull_review_authoring_operations WHERE user_id=NEW.user_id AND forge_url=NEW.forge_url AND operation_id=NEW.operation_id) THEN RETURN NEW; END IF;
  IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=NEW.forge_url AND (repository_id=NEW.repository_id OR source_repository_id=NEW.repository_id) AND phase IN ('RESERVED','DISPATCH_UNKNOWN')) THEN RAISE EXCEPTION 'Review authoring or lifecycle unresolved' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','updated_at','observed_review_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','updated_at','observed_review_id']) OR NOT(OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') OR NOT(NEW.observed_review_id=OLD.observed_review_id OR OLD.observed_review_id=0 AND OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED' AND NEW.observed_review_id>0) THEN RAISE EXCEPTION 'Review authoring identity/outcome immutable'; END IF;
  NEW.updated_at=greatest(clock_timestamp(),OLD.updated_at);
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_review_authoring_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO golf_pull_review_authoring_events(operation_id,phase) VALUES(NEW.id,NEW.phase); RETURN NEW;
END; $$;
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_review_authoring;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_review_authoring(f,r)+(SELECT count(*) FROM golf_pull_review_authoring_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
ALTER FUNCTION golf_repository_lifecycle_blocked(text,bigint) RENAME TO golf_repository_lifecycle_blocked_before_review_authoring;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_blocked(f text,r bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_blocked_before_review_authoring(f,r) OR EXISTS(SELECT 1 FROM golf_pull_review_authoring_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
CREATE TRIGGER golf_review_authoring_guard BEFORE INSERT OR UPDATE ON golf_pull_review_authoring_operations FOR EACH ROW EXECUTE FUNCTION golf_review_authoring_guard();
CREATE TRIGGER golf_review_authoring_event AFTER INSERT OR UPDATE ON golf_pull_review_authoring_operations FOR EACH ROW EXECUTE FUNCTION golf_review_authoring_event();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Preserve retained review authoring outcomes through qualified recovery'; END $$;
-- +goose StatementEnd

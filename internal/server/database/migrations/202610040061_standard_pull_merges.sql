-- +goose Up
-- Native requested messages are fingerprints only, never stored plaintext.
CREATE TABLE golf_standard_pull_merges (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id),
 forge_url text NOT NULL,
 actor_id bigint NOT NULL CHECK(actor_id>0),
 operation_id text NOT NULL CHECK(operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 repository_id bigint NOT NULL CHECK(repository_id>0), owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL, repository_name text NOT NULL,
 pull_request_id bigint NOT NULL CHECK(pull_request_id>0), number bigint NOT NULL CHECK(number BETWEEN 1 AND 4294967295),
 expected_pull_revision text NOT NULL CHECK(expected_pull_revision ~ '^[a-f0-9]{64}$'),
 head_commit_id text NOT NULL CHECK(head_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 observed_base_commit_id text NOT NULL CHECK(observed_base_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND length(observed_base_commit_id)=length(head_commit_id)),
 source_ref text NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 1024), target_ref text NOT NULL CHECK(length(target_ref) BETWEEN 1 AND 1024),
 input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 merge_commit_id text NOT NULL DEFAULT '', actual_base_commit_id text NOT NULL DEFAULT '',
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,forge_url,operation_id),
 CHECK((phase='REJECTED')=(failure_code='preflight_refused')),
 CHECK(phase='SUCCEEDED' AND merge_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND actual_base_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND length(merge_commit_id)=length(head_commit_id) AND length(actual_base_commit_id)=length(head_commit_id) OR phase<>'SUCCEEDED' AND merge_commit_id='' AND actual_base_commit_id='')
);
CREATE UNIQUE INDEX golf_standard_pull_merges_unresolved ON golf_standard_pull_merges(forge_url,repository_id,pull_request_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_standard_pull_merge_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 operation_id bigint NOT NULL REFERENCES golf_standard_pull_merges(id),
 phase text NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(operation_id,phase)
);
CREATE TRIGGER golf_standard_pull_merges_no_delete BEFORE DELETE OR TRUNCATE ON golf_standard_pull_merges FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_standard_pull_merge_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_standard_pull_merge_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_standard_pull_merge_lock(f text,r bigint,p bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_repository_lifecycle_lock(f,r,false);
 PERFORM pg_advisory_xact_lock(hashtextextended(f||'/standard-pull-merge/'||r::text||'/'||p::text,0));
END; $$;
CREATE FUNCTION golf_standard_pull_merge_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_standard_pull_merge_lock(NEW.forge_url,NEW.repository_id,NEW.pull_request_id);
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid standard merge reservation'; END IF;
  IF EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE user_id=NEW.user_id AND forge_url=NEW.forge_url AND operation_id=NEW.operation_id) THEN RETURN NEW; END IF;
  IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=NEW.forge_url AND repository_id=NEW.repository_id AND pull_request_id=NEW.pull_request_id AND phase IN ('RESERVED','DISPATCH_UNKNOWN')) THEN RAISE EXCEPTION 'Standard merge or lifecycle unresolved' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','merge_commit_id','actual_base_commit_id','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','merge_commit_id','actual_base_commit_id','updated_at']) OR NOT (OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') THEN RAISE EXCEPTION 'Standard merge identity/outcome immutable'; END IF;
  NEW.updated_at=greatest(clock_timestamp(),OLD.updated_at);
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_standard_pull_merge_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO golf_standard_pull_merge_events(operation_id,phase) VALUES(NEW.id,NEW.phase);
 IF NEW.phase='SUCCEEDED' THEN
  PERFORM golf_append_repository_activity(NEW.forge_url,NEW.repository_id,0,'pulls');
  PERFORM golf_append_repository_activity(NEW.forge_url,NEW.repository_id,0,'source');
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_standard_pull_merge_guard BEFORE INSERT OR UPDATE ON golf_standard_pull_merges FOR EACH ROW EXECUTE FUNCTION golf_standard_pull_merge_guard();
CREATE TRIGGER golf_standard_pull_merge_event AFTER INSERT OR UPDATE ON golf_standard_pull_merges FOR EACH ROW EXECUTE FUNCTION golf_standard_pull_merge_event();
-- Append to every prior active-family count. UNKNOWN never expires or unlocks
-- archive. This is not an all-native-writer or protected publication barrier.
-- +goose StatementBegin
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_standard_merge;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_standard_merge(f,r)+(SELECT count(*) FROM golf_standard_pull_merges WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained native merge outcomes require qualified offline recovery; no automatic downgrade'; END $$;
-- +goose StatementEnd

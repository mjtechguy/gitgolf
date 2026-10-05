-- +goose Up
CREATE TABLE golf_repository_file_mutations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id), forge_url text NOT NULL, actor_id bigint NOT NULL CHECK(actor_id>0),
 operation_id text NOT NULL CHECK(operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 repository_id bigint NOT NULL CHECK(repository_id>0), owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL, repository_name text NOT NULL,
 access_revision text NOT NULL CHECK(access_revision ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN ('CREATE','UPDATE','DELETE')),
 branch_name text NOT NULL CHECK(octet_length(branch_name) BETWEEN 1 AND 100),
 expected_commit_id text NOT NULL CHECK(expected_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 file_path text NOT NULL CHECK(octet_length(file_path) BETWEEN 1 AND 500),
 expected_blob_id text NOT NULL CHECK((kind='CREATE' AND expected_blob_id='') OR (kind<>'CREATE' AND expected_blob_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND length(expected_blob_id)=length(expected_commit_id))),
 content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
 content_size_bytes bigint NOT NULL CHECK(content_size_bytes BETWEEN 0 AND 262144),
 message_sha256 text NOT NULL CHECK(message_sha256 ~ '^[a-f0-9]{64}$'),
 result_commit_id text NOT NULL DEFAULT '', result_blob_id text NOT NULL DEFAULT '',
 input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,forge_url,operation_id), CHECK((phase='REJECTED')=(failure_code='preflight_refused')), CHECK((phase='SUCCEEDED' AND result_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND length(result_commit_id)=length(expected_commit_id) AND ((kind='DELETE' AND result_blob_id='') OR (kind<>'DELETE' AND result_blob_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND length(result_blob_id)=length(expected_commit_id)))) OR (phase<>'SUCCEEDED' AND result_commit_id='' AND result_blob_id=''))
);
CREATE UNIQUE INDEX golf_file_mutations_unresolved ON golf_repository_file_mutations(forge_url,repository_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_repository_file_mutation_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, operation_id bigint NOT NULL REFERENCES golf_repository_file_mutations(id),
 phase text NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(operation_id,phase)
);
CREATE TRIGGER golf_file_mutations_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_file_mutations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_file_mutation_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_file_mutation_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_file_mutation_lock(f text,r bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_repository_lifecycle_lock(f,r,true);
 PERFORM pg_advisory_xact_lock(hashtextextended(f||'/file-mutation/'||r::text,0));
END; $$;
CREATE FUNCTION golf_file_mutation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_file_mutation_lock(NEW.forge_url,NEW.repository_id);
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid file mutation reservation'; END IF;
  IF EXISTS(SELECT 1 FROM golf_repository_file_mutations WHERE user_id=NEW.user_id AND forge_url=NEW.forge_url AND operation_id=NEW.operation_id) THEN RETURN NEW; END IF;
  IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=NEW.forge_url AND (repository_id=NEW.repository_id OR source_repository_id=NEW.repository_id) AND phase IN ('RESERVED','DISPATCH_UNKNOWN')) THEN RAISE EXCEPTION 'Ref mutation or lifecycle unresolved' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','updated_at','result_commit_id','result_blob_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','updated_at','result_commit_id','result_blob_id']) OR NOT(OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') THEN RAISE EXCEPTION 'Ref mutation identity/outcome immutable'; END IF;
  IF NEW.phase<>'SUCCEEDED' AND (NEW.result_commit_id<>OLD.result_commit_id OR NEW.result_blob_id<>OLD.result_blob_id) THEN RAISE EXCEPTION 'File outcome may only bind succeeded receipt'; END IF;
  NEW.updated_at=greatest(clock_timestamp(),OLD.updated_at);
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_file_mutation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO golf_repository_file_mutation_events(operation_id,phase) VALUES(NEW.id,NEW.phase); RETURN NEW;
END; $$;
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_file_mutation;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_file_mutation(f,r)+(SELECT count(*) FROM golf_repository_file_mutations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
ALTER FUNCTION golf_repository_lifecycle_blocked(text,bigint) RENAME TO golf_repository_lifecycle_blocked_before_file_mutation;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_blocked(f text,r bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_blocked_before_file_mutation(f,r) OR EXISTS(SELECT 1 FROM golf_repository_file_mutations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
CREATE TRIGGER golf_file_mutation_guard BEFORE INSERT OR UPDATE ON golf_repository_file_mutations FOR EACH ROW EXECUTE FUNCTION golf_file_mutation_guard();
CREATE TRIGGER golf_file_mutation_event AFTER INSERT OR UPDATE ON golf_repository_file_mutations FOR EACH ROW EXECUTE FUNCTION golf_file_mutation_event();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained native file outcomes require qualified offline recovery; no automatic downgrade'; END $$;
-- +goose StatementEnd

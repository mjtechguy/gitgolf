-- +goose Up
-- Retain batch metadata without file/message plaintext in the existing file journal.
ALTER TABLE golf_repository_file_mutations ADD COLUMN batch_original bytea NOT NULL DEFAULT ''::bytea;
ALTER TABLE golf_repository_file_mutations DROP CONSTRAINT golf_repository_file_mutations_kind_check;
ALTER TABLE golf_repository_file_mutations ADD CONSTRAINT golf_repository_file_mutations_kind_check CHECK(kind IN ('CREATE','UPDATE','DELETE','BATCH'));
-- The original unnamed checks must be located by their exact referenced columns.
-- +goose StatementBegin
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='golf_repository_file_mutations'::regclass AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%result_commit_id%' OR pg_get_constraintdef(oid) LIKE '%expected_blob_id%') LOOP
  EXECUTE format('ALTER TABLE golf_repository_file_mutations DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
-- +goose StatementEnd
ALTER TABLE golf_repository_file_mutations ADD CONSTRAINT golf_repository_file_mutations_original_blob_check CHECK((kind IN ('CREATE','BATCH') AND expected_blob_id='') OR (kind NOT IN ('CREATE','BATCH') AND expected_blob_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND length(expected_blob_id)=length(expected_commit_id)));
ALTER TABLE golf_repository_file_mutations ADD CONSTRAINT golf_file_mutation_result_check CHECK((phase='SUCCEEDED' AND result_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND length(result_commit_id)=length(expected_commit_id) AND ((kind IN ('DELETE','BATCH') AND result_blob_id='') OR (kind NOT IN ('DELETE','BATCH') AND result_blob_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND length(result_blob_id)=length(expected_commit_id)))) OR (phase<>'SUCCEEDED' AND result_commit_id='' AND result_blob_id=''));
ALTER TABLE golf_repository_file_mutations ADD CONSTRAINT golf_file_batch_original_check CHECK((kind='BATCH')=(octet_length(batch_original)>0));
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION golf_file_mutation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO golf_repository_file_mutation_events(operation_id,phase) VALUES(NEW.id,NEW.phase);
 IF NEW.phase='SUCCEEDED' THEN PERFORM golf_append_repository_activity(NEW.forge_url,NEW.repository_id,0,'source'); END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TABLE golf_attachment_upload_operations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id), forge_url text NOT NULL,
 actor_id bigint NOT NULL CHECK(actor_id>0), repository_id bigint NOT NULL CHECK(repository_id>0),
 operation_id text NOT NULL CHECK(operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 original bytea NOT NULL CHECK(octet_length(original) BETWEEN 1 AND 8192),
 input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32),
 result bytea NOT NULL DEFAULT ''::bytea,
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,forge_url,operation_id),CHECK((phase='REJECTED')=(failure_code='preflight_refused')),
 CHECK((phase='SUCCEEDED')=(octet_length(result)>0))
);
CREATE UNIQUE INDEX golf_attachment_upload_unresolved ON golf_attachment_upload_operations(forge_url,repository_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_attachment_upload_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,operation_id bigint NOT NULL REFERENCES golf_attachment_upload_operations(id),
 phase text NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(operation_id,phase)
);
CREATE TRIGGER golf_attachment_upload_no_delete BEFORE DELETE OR TRUNCATE ON golf_attachment_upload_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_attachment_upload_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_attachment_upload_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_attachment_upload_lock(f text,r bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_repository_lifecycle_lock(f,r,true);
 PERFORM pg_advisory_xact_lock(hashtextextended(f||'/attachment-upload/'||r::text,0));
END; $$;
CREATE FUNCTION golf_attachment_upload_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_attachment_upload_lock(NEW.forge_url,NEW.repository_id);
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid attachment upload reservation'; END IF;
  IF EXISTS(SELECT 1 FROM golf_attachment_upload_operations WHERE user_id=NEW.user_id AND forge_url=NEW.forge_url AND operation_id=NEW.operation_id) THEN RETURN NEW; END IF;
  IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=NEW.forge_url AND (repository_id=NEW.repository_id OR source_repository_id=NEW.repository_id) AND phase IN ('RESERVED','DISPATCH_UNKNOWN')) THEN RAISE EXCEPTION 'Attachment upload or lifecycle unresolved' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','updated_at','result']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','updated_at','result']) OR NOT(OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') OR NEW.phase<>'SUCCEEDED' AND NEW.result<>OLD.result THEN RAISE EXCEPTION 'Attachment upload original/outcome immutable'; END IF;
  NEW.updated_at=greatest(clock_timestamp(),OLD.updated_at);
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_attachment_upload_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO golf_attachment_upload_events(operation_id,phase) VALUES(NEW.id,NEW.phase);RETURN NEW;
END; $$;
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_attachment_upload;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_attachment_upload(f,r)+(SELECT count(*) FROM golf_attachment_upload_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
ALTER FUNCTION golf_repository_lifecycle_blocked(text,bigint) RENAME TO golf_repository_lifecycle_blocked_before_attachment_upload;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_blocked(f text,r bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_blocked_before_attachment_upload(f,r) OR EXISTS(SELECT 1 FROM golf_attachment_upload_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
CREATE TRIGGER golf_attachment_upload_guard BEFORE INSERT OR UPDATE ON golf_attachment_upload_operations FOR EACH ROW EXECUTE FUNCTION golf_attachment_upload_guard();
CREATE TRIGGER golf_attachment_upload_event AFTER INSERT OR UPDATE ON golf_attachment_upload_operations FOR EACH ROW EXECUTE FUNCTION golf_attachment_upload_event();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained forge outcomes require qualified offline recovery'; END $$;
-- +goose StatementEnd

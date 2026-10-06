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
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained forge outcomes require qualified offline recovery'; END $$;
-- +goose StatementEnd

-- +goose Up
-- Existing v1 rows retain zero/blank source metadata and original fingerprints.
ALTER TABLE golf_standard_pull_merges
 ADD COLUMN source_repository_id bigint NOT NULL DEFAULT 0,
 ADD COLUMN source_owner_id bigint NOT NULL DEFAULT 0,
 ADD COLUMN source_repository_owner text NOT NULL DEFAULT '',
 ADD COLUMN source_repository_name text NOT NULL DEFAULT '',
 ADD CONSTRAINT golf_standard_pull_merge_source_bound CHECK (
  source_repository_id=0 AND source_owner_id=0 AND source_repository_owner='' AND source_repository_name='' OR
  source_repository_id>0 AND source_owner_id>0 AND length(source_repository_owner) BETWEEN 1 AND 100 AND length(source_repository_name) BETWEEN 1 AND 100
 );
CREATE INDEX golf_standard_pull_merge_source_active ON golf_standard_pull_merges(forge_url,source_repository_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
-- Existing to_jsonb immutable guard automatically includes every new field.
-- +goose StatementBegin
CREATE FUNCTION golf_standard_pull_merge_fork_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r bigint; BEGIN
 FOR r IN SELECT DISTINCT id FROM unnest(ARRAY[NEW.repository_id,NEW.source_repository_id]) AS id WHERE id>0 ORDER BY id LOOP
  PERFORM golf_repository_lifecycle_lock(NEW.forge_url,r,false);
 END LOOP;
 IF TG_OP='INSERT' AND NEW.source_repository_id>0 AND golf_repository_lifecycle_blocked(NEW.forge_url,NEW.source_repository_id) THEN RAISE EXCEPTION 'Source lifecycle unresolved' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_standard_pull_merge_fork_guard BEFORE INSERT OR UPDATE ON golf_standard_pull_merges FOR EACH ROW EXECUTE FUNCTION golf_standard_pull_merge_fork_guard();
-- Count original unresolved source rows too; same-repository v2 counted once.
-- +goose StatementBegin
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_fork_merge;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_fork_merge(f,r)+(SELECT count(*) FROM golf_standard_pull_merges WHERE forge_url=f AND source_repository_id=r AND source_repository_id<>repository_id AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained source-bound merge outcomes require qualified offline recovery; no automatic downgrade'; END $$;
-- +goose StatementEnd

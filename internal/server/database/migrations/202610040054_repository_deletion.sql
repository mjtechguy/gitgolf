-- +goose Up
-- Owner deletion shares retained lifecycle reservations and never masquerades as an archive transition.
ALTER TABLE golf_repository_lifecycle_operations ADD COLUMN action text NOT NULL DEFAULT 'archive_state' CHECK(action IN ('archive_state','delete'));
ALTER TABLE golf_repository_lifecycle_operations ADD COLUMN owner_is_organization boolean NOT NULL DEFAULT false;
-- +goose StatementBegin
DO $$
DECLARE constraint_name text; matched integer;
BEGIN
 SELECT count(*),min(conname) INTO matched,constraint_name FROM pg_constraint
 WHERE conrelid='golf_repository_lifecycle_operations'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%from_archived <> to_archived%';
 IF matched<>1 THEN RAISE EXCEPTION 'Expected original lifecycle success predicate'; END IF;
 EXECUTE format('ALTER TABLE golf_repository_lifecycle_operations DROP CONSTRAINT %I',constraint_name);
END $$;
-- +goose StatementEnd
ALTER TABLE golf_repository_lifecycle_operations ADD CONSTRAINT golf_repository_lifecycle_action_state CHECK(
 (action='delete' AND from_archived=to_archived) OR
 (action='archive_state' AND (phase<>'SUCCEEDED' OR from_archived<>to_archived))
);
-- +goose StatementBegin
ALTER FUNCTION golf_repository_lifecycle_blocked(text,bigint) RENAME TO golf_repository_lifecycle_blocked_before_deletion;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_blocked(f text,r bigint) RETURNS boolean LANGUAGE sql AS $$
 SELECT golf_repository_lifecycle_blocked_before_deletion(f,r) OR EXISTS(
 SELECT 1 FROM golf_repository_lifecycle_operations WHERE forge_url=f AND repository_id=r AND action='delete' AND phase='SUCCEEDED');
$$;
CREATE FUNCTION golf_repository_deletion_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM golf_repository_lifecycle_operations WHERE user_id=NEW.user_id AND idempotency_key=NEW.idempotency_key) THEN RETURN NEW; END IF;
 PERFORM golf_repository_lifecycle_lock(NEW.forge_url,NEW.repository_id,true);
 IF EXISTS(SELECT 1 FROM golf_repository_lifecycle_operations WHERE forge_url=NEW.forge_url AND repository_id=NEW.repository_id AND action='delete' AND phase='SUCCEEDED') THEN
  RAISE EXCEPTION 'Deleted original repository identity is retained' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_repository_deletion_admission BEFORE INSERT ON golf_repository_lifecycle_operations FOR EACH ROW EXECUTE FUNCTION golf_repository_deletion_admission();
-- Existing identity guard freezes all added fields. Existing phase event, unknown exclusion,
-- access/invitation/rules/Git admission and active-family wrappers remain installed.
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Deletion history and original-ID fences require qualified offline recovery; no downgrade'; END $$;
-- +goose StatementEnd

-- +goose Up
ALTER TABLE golf_issue_mutations ADD COLUMN pull_request boolean NOT NULL DEFAULT false;
ALTER TABLE golf_issue_mutations ADD CHECK (NOT pull_request OR kind='CREATE_COMMENT');
-- +goose StatementBegin
CREATE FUNCTION golf_discussion_type_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.pull_request IS DISTINCT FROM OLD.pull_request THEN RAISE EXCEPTION 'Discussion type is immutable'; END IF;
 RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER golf_discussion_type_immutable BEFORE UPDATE ON golf_issue_mutations FOR EACH ROW EXECUTE FUNCTION golf_discussion_type_guard();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_issue_mutations WHERE pull_request) THEN RAISE EXCEPTION 'PR discussion history prevents downgrade'; END IF;
END $$;
-- +goose StatementEnd
DROP TRIGGER golf_discussion_type_immutable ON golf_issue_mutations;
DROP FUNCTION golf_discussion_type_guard();
ALTER TABLE golf_issue_mutations DROP COLUMN pull_request;

-- +goose Up
ALTER TABLE golf_discussion_resource_operations ADD COLUMN reaction_comment boolean NOT NULL DEFAULT false;
ALTER TABLE golf_discussion_resource_operations ADD CONSTRAINT golf_discussion_resource_reaction_comment CHECK(NOT reaction_comment OR kind IN ('ADD_REACTION','REMOVE_REACTION'));
-- Reuse the retained discussion-resource journal and lifecycle fence for own engagement.
ALTER TABLE golf_discussion_resource_operations DROP CONSTRAINT golf_discussion_resource_operations_kind_check;
ALTER TABLE golf_discussion_resource_operations ADD CONSTRAINT golf_discussion_resource_operations_kind_check CHECK(kind IN ('CREATE_LABEL','UPDATE_LABEL','DELETE_LABEL','CREATE_MILESTONE','UPDATE_MILESTONE','DELETE_MILESTONE','UPDATE_COMMENT','DELETE_COMMENT','ADD_REACTION','REMOVE_REACTION','SUBSCRIBE','UNSUBSCRIBE'));
-- Locate the existing table-level identity check by its definition, not its generated ordinal.
-- +goose StatementBegin
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='golf_discussion_resource_operations'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%comment_author_id%' AND pg_get_constraintdef(oid) LIKE '%UPDATE_COMMENT%' LOOP
  EXECUTE format('ALTER TABLE golf_discussion_resource_operations DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
-- +goose StatementEnd
ALTER TABLE golf_discussion_resource_operations ADD CONSTRAINT golf_discussion_resource_engagement_identity CHECK(
 (kind IN ('UPDATE_COMMENT','DELETE_COMMENT') AND issue_id>0 AND issue_number>0 AND comment_author_id>0) OR
 (kind IN ('ADD_REACTION','REMOVE_REACTION') AND issue_id>0 AND issue_number>0 AND resource_id>0 AND (reaction_comment OR resource_id=issue_id) AND comment_author_id=0) OR
 (kind IN ('SUBSCRIBE','UNSUBSCRIBE') AND issue_id>0 AND issue_number>0 AND resource_id=issue_id AND comment_author_id=0) OR
 (kind NOT IN ('UPDATE_COMMENT','DELETE_COMMENT','ADD_REACTION','REMOVE_REACTION','SUBSCRIBE','UNSUBSCRIBE') AND issue_id=0 AND issue_number=0 AND NOT pull_request AND comment_author_id=0));
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained engagement outcomes require qualified offline recovery; no automatic downgrade'; END $$;
-- +goose StatementEnd

-- +goose Up
ALTER TABLE golf_discussion_resource_operations DROP CONSTRAINT golf_discussion_resource_operations_kind_check;
ALTER TABLE golf_discussion_resource_operations ADD CONSTRAINT golf_discussion_resource_operations_kind_check CHECK(kind IN ('CREATE_LABEL','UPDATE_LABEL','DELETE_LABEL','CREATE_MILESTONE','UPDATE_MILESTONE','DELETE_MILESTONE','UPDATE_COMMENT','DELETE_COMMENT','ADD_REACTION','REMOVE_REACTION','SUBSCRIBE','UNSUBSCRIBE','MARK_NOTIFICATION_READ'));
ALTER TABLE golf_discussion_resource_operations DROP CONSTRAINT golf_discussion_resource_engagement_identity;
ALTER TABLE golf_discussion_resource_operations ADD CONSTRAINT golf_discussion_resource_engagement_identity CHECK(
 (kind IN ('UPDATE_COMMENT','DELETE_COMMENT') AND issue_id>0 AND issue_number>0 AND comment_author_id>0) OR
 (kind IN ('ADD_REACTION','REMOVE_REACTION') AND issue_id>0 AND issue_number>0 AND resource_id>0 AND (reaction_comment OR resource_id=issue_id) AND comment_author_id=0) OR
 (kind IN ('SUBSCRIBE','UNSUBSCRIBE') AND issue_id>0 AND issue_number>0 AND resource_id=issue_id AND comment_author_id=0) OR
 (kind='MARK_NOTIFICATION_READ' AND issue_id>0 AND issue_number>0 AND resource_id>0 AND comment_author_id=0 AND NOT reaction_comment) OR
 (kind NOT IN ('UPDATE_COMMENT','DELETE_COMMENT','ADD_REACTION','REMOVE_REACTION','SUBSCRIBE','UNSUBSCRIBE','MARK_NOTIFICATION_READ') AND issue_id=0 AND issue_number=0 AND NOT pull_request AND comment_author_id=0));
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained notification outcomes require qualified offline recovery; no automatic downgrade'; END $$;
-- +goose StatementEnd

-- +goose Up
-- Extend the existing metadata-only journal without changing old input digests.
ALTER TABLE golf_issue_mutations
 DROP CONSTRAINT golf_issue_mutations_kind_check,
 DROP CONSTRAINT golf_issue_mutations_check1,
 DROP CONSTRAINT golf_issue_mutations_check2,
 DROP CONSTRAINT golf_issue_mutations_check3;
ALTER TABLE golf_issue_mutations
 ADD CONSTRAINT golf_issue_mutations_kind_check CHECK (kind IN ('CREATE_ISSUE','CREATE_COMMENT','UPDATE_ISSUE')),
 ADD CONSTRAINT golf_issue_mutations_receipt_target CHECK (state<>'SUCCEEDED' OR (observed_number=issue_number AND observed_result_id=CASE WHEN kind='CREATE_COMMENT' THEN comment_id ELSE issue_id END)),
 ADD CONSTRAINT golf_issue_mutations_target CHECK ((kind IN ('CREATE_COMMENT','UPDATE_ISSUE') AND issue_id>0 AND issue_number>0) OR (kind='CREATE_ISSUE' AND ((state='SUCCEEDED' AND issue_id>0 AND issue_number>0) OR (state<>'SUCCEEDED' AND issue_id=0 AND issue_number=0)))),
 ADD CONSTRAINT golf_issue_mutations_shape CHECK ((state='SUCCEEDED' AND failure_code='' AND (kind IN ('CREATE_ISSUE','UPDATE_ISSUE') AND comment_id=0 OR kind='CREATE_COMMENT' AND comment_id>0)) OR
 (state='OUTCOME_UNKNOWN' AND failure_code='' AND comment_id=0) OR
 (state='REJECTED' AND comment_id=0 AND observed_result_id=0 AND failure_code IN ('target_changed','revision_changed','unchanged','preflight_unavailable','provider_http_400','provider_http_401','provider_http_403','provider_http_404','provider_http_409','provider_http_412','provider_http_422','provider_http_423')));
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION golf_issue_mutation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'OUTCOME_UNKNOWN' OR NEW.state NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','REJECTED')
 OR (NEW.state='SUCCEEDED' AND OLD.observed_result_id=0)
 OR NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
 OR NEW.actor_forge_user_id IS DISTINCT FROM OLD.actor_forge_user_id
 OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
 OR NEW.payload_fingerprint IS DISTINCT FROM OLD.payload_fingerprint
 OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.repository_id IS DISTINCT FROM OLD.repository_id
 OR NEW.repository_owner IS DISTINCT FROM OLD.repository_owner OR NEW.repository_name IS DISTINCT FROM OLD.repository_name
 OR NEW.created_at IS DISTINCT FROM OLD.created_at
 OR (OLD.observed_result_id>0 AND (NEW.observed_result_id IS DISTINCT FROM OLD.observed_result_id OR NEW.observed_number IS DISTINCT FROM OLD.observed_number))
 OR (NEW.state='OUTCOME_UNKNOWN' AND (OLD.observed_result_id<>0 OR NEW.observed_result_id<=0 OR NEW.issue_id IS DISTINCT FROM OLD.issue_id OR NEW.issue_number IS DISTINCT FROM OLD.issue_number OR NEW.comment_id IS DISTINCT FROM OLD.comment_id OR NEW.failure_code IS DISTINCT FROM OLD.failure_code))
 OR (OLD.kind IN ('CREATE_COMMENT','UPDATE_ISSUE') AND (NEW.issue_id IS DISTINCT FROM OLD.issue_id OR NEW.issue_number IS DISTINCT FROM OLD.issue_number)) THEN
 RAISE EXCEPTION 'Golf issue mutation identity and terminal observations are immutable';
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd

-- +goose Down
-- Never silently discard update deduplication/history.
-- +goose StatementBegin
DO $$ BEGIN
 RAISE EXCEPTION 'Issue update journal downgrade requires explicit offline recovery; native effects cannot be undone';
END $$;
-- +goose StatementEnd

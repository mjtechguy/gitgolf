-- +goose Up
CREATE TABLE golf_pull_review_mutations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 actor_forge_user_id bigint NOT NULL CHECK(actor_forge_user_id>0),
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 payload_fingerprint bytea NOT NULL CHECK(octet_length(payload_fingerprint)=32),
 body_fingerprint bytea NOT NULL CHECK(octet_length(body_fingerprint)=32),
 repository_id bigint NOT NULL CHECK(repository_id>0),
 repository_owner text NOT NULL,
 repository_name text NOT NULL,
 pull_request_id bigint NOT NULL CHECK(pull_request_id>0),
 number bigint NOT NULL CHECK(number BETWEEN 1 AND 2147483647),
 expected_revision text NOT NULL CHECK(expected_revision ~ '^[a-f0-9]{64}$'),
 base_commit_id text NOT NULL CHECK(base_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 head_commit_id text NOT NULL CHECK(head_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 review_state text NOT NULL CHECK(review_state IN ('COMMENT','APPROVED','REQUEST_CHANGES')),
 state text NOT NULL DEFAULT 'OUTCOME_UNKNOWN' CHECK(state IN ('OUTCOME_UNKNOWN','SUCCEEDED','REJECTED')),
 observed_review_id bigint NOT NULL DEFAULT 0 CHECK(observed_review_id>=0),
 failure_code text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,idempotency_key),
 CHECK(length(base_commit_id)=length(head_commit_id)),
 CHECK((state='OUTCOME_UNKNOWN' AND failure_code='') OR (state='SUCCEEDED' AND observed_review_id>0 AND failure_code='') OR
 (state='REJECTED' AND observed_review_id=0 AND failure_code IN ('target_changed','revision_changed','pending_review','review_unavailable','preflight_unavailable','provider_http_400','provider_http_401','provider_http_403','provider_http_404','provider_http_409','provider_http_412','provider_http_422','provider_http_423')))
);
-- +goose StatementBegin
CREATE FUNCTION golf_pull_review_mutation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'OUTCOME_UNKNOWN'
 OR (to_jsonb(NEW)-ARRAY['state','observed_review_id','failure_code','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','observed_review_id','failure_code','updated_at'])
 OR (OLD.observed_review_id>0 AND NEW.observed_review_id IS DISTINCT FROM OLD.observed_review_id)
 OR (NEW.state='SUCCEEDED' AND OLD.observed_review_id=0)
 OR (NEW.state='OUTCOME_UNKNOWN' AND (OLD.observed_review_id<>0 OR NEW.observed_review_id<=0)) THEN
 RAISE EXCEPTION 'Golf review mutation identity and terminal observations are immutable';
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_pull_review_mutation_immutable BEFORE UPDATE ON golf_pull_review_mutations FOR EACH ROW EXECUTE FUNCTION golf_pull_review_mutation_guard();
CREATE TRIGGER golf_pull_review_mutation_no_delete BEFORE DELETE OR TRUNCATE ON golf_pull_review_mutations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TABLE golf_pull_review_mutation_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 mutation_id bigint NOT NULL REFERENCES golf_pull_review_mutations(id) ON DELETE RESTRICT,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 phase text NOT NULL CHECK(phase IN ('RESERVED','RECEIPT','COMPLETED')),
 state text NOT NULL CHECK(state IN ('OUTCOME_UNKNOWN','SUCCEEDED','REJECTED')),
 observed_review_id bigint NOT NULL DEFAULT 0 CHECK(observed_review_id>=0),
 failure_code text NOT NULL DEFAULT '',
 UNIQUE(mutation_id,phase),
 CHECK((phase='RESERVED' AND state='OUTCOME_UNKNOWN' AND observed_review_id=0 AND failure_code='') OR
 (phase='RECEIPT' AND state='OUTCOME_UNKNOWN' AND observed_review_id>0 AND failure_code='') OR
 (phase='COMPLETED' AND (state='SUCCEEDED' AND observed_review_id>0 AND failure_code='' OR state='REJECTED' AND observed_review_id=0 AND failure_code<>'')))
);
CREATE TRIGGER golf_pull_review_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_pull_review_mutation_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 RAISE EXCEPTION 'Review journal downgrade requires explicit offline recovery; native review publication cannot be undone';
END $$;
-- +goose StatementEnd

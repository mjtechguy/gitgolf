-- +goose Up
-- Two concrete native-address writes, not a generic job/outbox. Exact request
-- text is represented only by its digest; no title/body or provider snapshot.
CREATE TABLE golf_issue_mutations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
    actor_forge_user_id bigint NOT NULL CHECK (actor_forge_user_id > 0),
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    payload_fingerprint bytea NOT NULL CHECK (octet_length(payload_fingerprint) = 32),
    kind text NOT NULL CHECK (kind IN ('CREATE_ISSUE','CREATE_COMMENT')),
    repository_id bigint NOT NULL CHECK (repository_id > 0),
    repository_owner text NOT NULL,
    repository_name text NOT NULL,
    issue_id bigint NOT NULL CHECK (issue_id >= 0),
    issue_number bigint NOT NULL CHECK (issue_number BETWEEN 0 AND 2147483647),
    comment_id bigint NOT NULL DEFAULT 0 CHECK (comment_id >= 0),
    observed_result_id bigint NOT NULL DEFAULT 0 CHECK (observed_result_id >= 0),
    observed_number bigint NOT NULL DEFAULT 0 CHECK (observed_number BETWEEN 0 AND 2147483647),
    state text NOT NULL CHECK (state IN ('OUTCOME_UNKNOWN','SUCCEEDED','REJECTED')),
    failure_code text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (user_id,idempotency_key),
    CHECK ((observed_result_id=0 AND observed_number=0) OR (observed_result_id>0 AND observed_number>0)),
    CHECK (state<>'SUCCEEDED' OR (observed_number=issue_number AND observed_result_id=CASE WHEN kind='CREATE_ISSUE' THEN issue_id ELSE comment_id END)),
    CHECK ((kind='CREATE_COMMENT' AND issue_id>0 AND issue_number>0) OR
           (kind='CREATE_ISSUE' AND ((state='SUCCEEDED' AND issue_id>0 AND issue_number>0) OR (state<>'SUCCEEDED' AND issue_id=0 AND issue_number=0)))),
    CHECK ((state='SUCCEEDED' AND failure_code='' AND (kind='CREATE_ISSUE' AND comment_id=0 OR kind='CREATE_COMMENT' AND comment_id>0)) OR
           (state='OUTCOME_UNKNOWN' AND failure_code='' AND comment_id=0) OR
           (state='REJECTED' AND comment_id=0 AND observed_result_id=0 AND failure_code IN ('target_changed','preflight_unavailable','provider_http_400','provider_http_401','provider_http_403','provider_http_404','provider_http_409','provider_http_422','provider_http_423')))
);

-- One provisional receipt and one UNKNOWN -> terminal observation are permitted. A SQL owner can
-- change these guards; this is not external or cryptographic tamper evidence.
-- +goose StatementBegin
CREATE FUNCTION golf_issue_mutation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state <> 'OUTCOME_UNKNOWN' OR NEW.state NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','REJECTED')
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
       OR (OLD.kind='CREATE_COMMENT' AND (NEW.issue_id IS DISTINCT FROM OLD.issue_id OR NEW.issue_number IS DISTINCT FROM OLD.issue_number)) THEN
        RAISE EXCEPTION 'Golf issue mutation identity and terminal observations are immutable';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER golf_issue_mutation_immutable BEFORE UPDATE ON golf_issue_mutations
FOR EACH ROW EXECUTE FUNCTION golf_issue_mutation_guard();

CREATE TABLE golf_issue_mutation_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mutation_id bigint NOT NULL REFERENCES golf_issue_mutations(id) ON DELETE RESTRICT,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    phase text NOT NULL CHECK (phase IN ('RESERVED','RECEIPT','COMPLETED')),
    state text NOT NULL CHECK (state IN ('OUTCOME_UNKNOWN','SUCCEEDED','REJECTED')),
    observed_result_id bigint NOT NULL DEFAULT 0 CHECK (observed_result_id>=0),
    observed_number bigint NOT NULL DEFAULT 0 CHECK (observed_number BETWEEN 0 AND 2147483647),
    UNIQUE (mutation_id,phase),
    CHECK ((observed_result_id=0 AND observed_number=0) OR (observed_result_id>0 AND observed_number>0)),
    CHECK ((phase='RESERVED' AND state='OUTCOME_UNKNOWN' AND observed_result_id=0) OR
           (phase='RECEIPT' AND state='OUTCOME_UNKNOWN' AND observed_result_id>0) OR
           (phase='COMPLETED' AND state IN ('SUCCEEDED','REJECTED')))
);
CREATE TRIGGER golf_issue_mutation_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_issue_mutation_events
FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

-- +goose Down
-- Explicit downgrade loses deduplication/history, never undoes native writes.
DROP TABLE golf_issue_mutation_events;
DROP TABLE golf_issue_mutations;
DROP FUNCTION golf_issue_mutation_guard();

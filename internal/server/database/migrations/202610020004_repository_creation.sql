-- +goose Up
-- Own-account create intent only. A reserved key never authorizes another
-- dispatch, even if the provider outcome is unknown after a crash or timeout.
CREATE TABLE golf_repository_creations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    payload_fingerprint bytea NOT NULL CHECK (octet_length(payload_fingerprint) = 32),
    requested_name text NOT NULL,
    private boolean NOT NULL,
    state text NOT NULL CHECK (state IN ('OUTCOME_UNKNOWN', 'SUCCEEDED', 'REJECTED')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    repository_id bigint,
    repository_full_name text,
    failure_code text NOT NULL DEFAULT '',
    UNIQUE (user_id, idempotency_key),
    CHECK (
      (state = 'OUTCOME_UNKNOWN' AND repository_id IS NULL AND repository_full_name IS NULL AND failure_code = '') OR
      (state = 'SUCCEEDED' AND repository_id > 0 AND repository_id IS NOT NULL AND repository_full_name IS NOT NULL AND failure_code = '') OR
      (state = 'REJECTED' AND repository_id IS NULL AND repository_full_name IS NULL AND failure_code IN ('provider_http_400','provider_http_401','provider_http_403','provider_http_404','provider_http_409','provider_http_422'))
    )
);

-- Independent of account session history; no credential, provider body or full
-- request description is stored. Owners can alter SQL guards; not tamper-proof.
CREATE TABLE golf_repository_creation_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    creation_id bigint NOT NULL REFERENCES golf_repository_creations(id) ON DELETE RESTRICT,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    state text NOT NULL CHECK (state IN ('OUTCOME_UNKNOWN', 'SUCCEEDED', 'REJECTED')),
    UNIQUE (creation_id, state)
);
CREATE TRIGGER golf_repository_creation_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_creation_events
FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

-- +goose Down
-- Explicit downgrade loses deduplication/history; it does not undo native repos.
DROP TABLE golf_repository_creation_events;
DROP TABLE golf_repository_creations;

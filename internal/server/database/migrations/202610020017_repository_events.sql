-- +goose Up
-- Operator configuration holds signing secrets. The database retains only the
-- immutable native resource binding and compact authenticated event projection.
CREATE TABLE golf_repository_event_connections (
    id uuid PRIMARY KEY,
    forge_url text NOT NULL,
    repository_id bigint NOT NULL CHECK (repository_id > 0),
    owner_id bigint NOT NULL CHECK (owner_id > 0),
    repository text NOT NULL CHECK (octet_length(repository) BETWEEN 3 AND 201),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER golf_repository_event_connections_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
ON golf_repository_event_connections FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

CREATE TABLE golf_repository_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    connection_id uuid NOT NULL REFERENCES golf_repository_event_connections(id) ON DELETE RESTRICT,
    delivery_id uuid NOT NULL,
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    payload_bytes bigint NOT NULL CHECK (payload_bytes BETWEEN 1 AND 1048576),
    event_type text NOT NULL CHECK (event_type = 'push'),
    ref text NOT NULL CHECK (octet_length(ref) BETWEEN 1 AND 1024),
    before_commit_id text NOT NULL CHECK (before_commit_id ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
    after_commit_id text NOT NULL CHECK (after_commit_id ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND length(after_commit_id) = length(before_commit_id)),
    sender_id bigint NOT NULL CHECK (sender_id > 0),
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    state text NOT NULL DEFAULT 'RECORDED' CHECK (state = 'RECORDED'),
    execution_state text NOT NULL DEFAULT 'UNAVAILABLE' CHECK (execution_state = 'UNAVAILABLE'),
    UNIQUE(connection_id,delivery_id)
);
CREATE INDEX golf_repository_events_recent ON golf_repository_events(connection_id,id DESC);
CREATE TRIGGER golf_repository_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
ON golf_repository_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM golf_repository_event_connections) OR EXISTS (SELECT 1 FROM golf_repository_events) THEN
        RAISE EXCEPTION 'Repository event bindings/history exist; preserve them before explicit downgrade';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE golf_repository_events;
DROP TABLE golf_repository_event_connections;

-- +goose Up
-- Recovery operations are independent of user/session history. The database
-- operator is not a Golf user and invalidation must not invent user logouts.
CREATE TABLE golf_recovery_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    backup_id text NOT NULL CHECK (backup_id ~ '^[a-f0-9]{32}$'),
    operation_id text NOT NULL UNIQUE CHECK (operation_id ~ '^[A-Za-z0-9_-]{32}$'),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor text NOT NULL DEFAULT current_user,
    sessions_count bigint NOT NULL CHECK (sessions_count >= 0),
    oauth_attempts_count bigint NOT NULL CHECK (oauth_attempts_count >= 0)
);
CREATE INDEX golf_recovery_events_backup_id ON golf_recovery_events (backup_id);
CREATE TRIGGER golf_recovery_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_recovery_events
FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

-- +goose Down
-- An explicit downgrade removes recovery history; no automatic downgrade runs.
DROP TABLE golf_recovery_events;

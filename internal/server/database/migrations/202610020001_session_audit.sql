-- +goose Up
-- Successful session lifecycle only. Existing sessions acquire no invented history.
-- Keep events independent of session rows so revocation/logout preserve history.
CREATE TABLE golf_audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    action text NOT NULL CHECK (action IN ('SIGN_IN', 'SIGN_OUT', 'SESSION_REVOKED', 'OTHER_SESSIONS_REVOKED', 'SESSION_REPLACED')),
    actor_session_id bigint NOT NULL CHECK (actor_session_id > 0),
    target_session_id bigint CHECK (target_session_id > 0),
    credential_kind text NOT NULL CHECK (credential_kind IN ('pat', 'oauth')),
    revoked_count bigint NOT NULL CHECK (revoked_count >= 0),
    operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{32}$'),
    expires_at timestamptz,
    CHECK (
      (action = 'SIGN_IN' AND target_session_id = actor_session_id AND target_session_id IS NOT NULL AND revoked_count = 0 AND expires_at IS NOT NULL) OR
      (action IN ('SIGN_OUT', 'SESSION_REPLACED') AND target_session_id = actor_session_id AND target_session_id IS NOT NULL AND revoked_count = 1 AND expires_at IS NULL) OR
      (action = 'SESSION_REVOKED' AND target_session_id IS NOT NULL AND revoked_count = 1 AND expires_at IS NULL) OR
      (action = 'OTHER_SESSIONS_REVOKED' AND target_session_id IS NULL AND expires_at IS NULL)
    )
);
CREATE INDEX golf_audit_events_user_id ON golf_audit_events (user_id, id DESC);

-- Application-level append-only guard. A privileged owner can alter/drop this
-- guard; it is not cryptographic tamper evidence or an external durable archive.
-- +goose StatementBegin
CREATE FUNCTION golf_audit_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Golf audit events are append-only';
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER golf_audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

-- +goose Down
DROP TABLE golf_audit_events;
DROP FUNCTION golf_audit_reject_mutation();

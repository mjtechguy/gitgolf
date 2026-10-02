-- +goose Up
-- A credential delegates to an existing session; it contains no provider token.
-- The logical source reference intentionally survives deletion of that session.
CREATE TABLE golf_api_credentials (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    label text NOT NULL CHECK (octet_length(label) BETWEEN 1 AND 64),
    source_session_id bigint NOT NULL CHECK (source_session_id > 0),
    source_token_hash bytea NOT NULL CHECK (octet_length(source_token_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at > created_at)
);
CREATE INDEX golf_api_credentials_owner ON golf_api_credentials (user_id, id DESC);

-- Only the first explicit revocation can change a credential. In particular,
-- neither a recreated session nor an edited label can retarget its authority.
-- +goose StatementBegin
CREATE FUNCTION golf_api_credential_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.label IS DISTINCT FROM OLD.label
       OR NEW.source_session_id IS DISTINCT FROM OLD.source_session_id
       OR NEW.source_token_hash IS DISTINCT FROM OLD.source_token_hash
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'Golf API credential metadata is immutable';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER golf_api_credential_immutable BEFORE UPDATE ON golf_api_credentials
FOR EACH ROW EXECUTE FUNCTION golf_api_credential_guard();

CREATE TABLE golf_api_credential_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    credential_id bigint NOT NULL REFERENCES golf_api_credentials(id) ON DELETE RESTRICT,
    actor_session_id bigint NOT NULL CHECK (actor_session_id > 0),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    action text NOT NULL CHECK (action IN ('CREATED', 'REVOKED')),
    operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{32}$'),
    UNIQUE (credential_id, action)
);
CREATE TRIGGER golf_api_credential_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_api_credential_events
FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

-- +goose Down
-- Explicit downgrade discards credential history; it does not restore sessions.
DROP TABLE golf_api_credential_events;
DROP TABLE golf_api_credentials;
DROP FUNCTION golf_api_credential_guard();

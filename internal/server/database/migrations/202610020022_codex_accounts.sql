-- +goose Up
CREATE TABLE golf_codex_connections (
 id uuid PRIMARY KEY,
 user_id bigint NOT NULL UNIQUE REFERENCES golf_users(id) ON DELETE RESTRICT,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 state text NOT NULL CHECK(state IN ('UNCONFIGURED','AWAITING_AUTH','CONNECTED','REAUTH_REQUIRED')),
 auth_method text NOT NULL DEFAULT '',
 email text NOT NULL DEFAULT '', plan_type text NOT NULL DEFAULT '',
 checked_at timestamptz,
 login_id text NOT NULL DEFAULT '', verification_url text NOT NULL DEFAULT '', user_code text NOT NULL DEFAULT '', login_expires_at timestamptz,
 reason_code text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE golf_codex_auth (
 connection_id uuid PRIMARY KEY REFERENCES golf_codex_connections(id) ON DELETE CASCADE,
 encrypted_credential bytea NOT NULL CHECK(octet_length(encrypted_credential) BETWEEN 28 AND 65564),
 credential_binding bytea NOT NULL CHECK(octet_length(credential_binding)=32),
 credential_key_id text NOT NULL CHECK(credential_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
);
CREATE INDEX golf_codex_auth_key ON golf_codex_auth(credential_key_id,connection_id);
CREATE TRIGGER golf_codex_auth_active_key BEFORE INSERT OR UPDATE OF encrypted_credential,credential_key_id ON golf_codex_auth FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
-- Binding identifies the personal connection; only ciphertext/key may rotate.
-- +goose StatementBegin
CREATE FUNCTION golf_codex_auth_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.connection_id<>OLD.connection_id OR NEW.credential_binding<>OLD.credential_binding THEN RAISE EXCEPTION 'Codex credential binding is immutable'; END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_codex_auth_binding_immutable BEFORE UPDATE ON golf_codex_auth FOR EACH ROW EXECUTE FUNCTION golf_codex_auth_binding_immutable();
ALTER TABLE golf_audit_events DROP CONSTRAINT golf_audit_events_action_check;
ALTER TABLE golf_audit_events DROP CONSTRAINT golf_audit_events_check;
ALTER TABLE golf_audit_events ADD CONSTRAINT golf_audit_events_action_check CHECK(action IN ('SIGN_IN','SIGN_OUT','SESSION_REVOKED','OTHER_SESSIONS_REVOKED','SESSION_REPLACED','CODEX_LOGIN_STARTED','CODEX_LOGIN_COMPLETED','CODEX_LOGIN_CANCELED','CODEX_CONNECTION_REFRESHED','CODEX_CONNECTION_DISCONNECTED'));
ALTER TABLE golf_audit_events ADD CONSTRAINT golf_audit_events_check CHECK(
 (action='SIGN_IN' AND target_session_id=actor_session_id AND target_session_id IS NOT NULL AND revoked_count=0 AND expires_at IS NOT NULL) OR
 (action IN ('SIGN_OUT','SESSION_REPLACED') AND target_session_id=actor_session_id AND target_session_id IS NOT NULL AND revoked_count=1 AND expires_at IS NULL) OR
 (action='SESSION_REVOKED' AND target_session_id IS NOT NULL AND revoked_count=1 AND expires_at IS NULL) OR
 (action='OTHER_SESSIONS_REVOKED' AND target_session_id IS NULL AND expires_at IS NULL) OR
 (action IN ('CODEX_LOGIN_STARTED','CODEX_LOGIN_COMPLETED','CODEX_LOGIN_CANCELED','CODEX_CONNECTION_REFRESHED','CODEX_CONNECTION_DISCONNECTED') AND target_session_id IS NULL AND revoked_count=0 AND expires_at IS NULL));
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN IF EXISTS(SELECT 1 FROM golf_codex_connections) THEN RAISE EXCEPTION 'Preserve Codex connections before downgrade'; END IF; END $$;
-- +goose StatementEnd
-- +goose StatementBegin
DO $$ BEGIN IF EXISTS(SELECT 1 FROM golf_audit_events WHERE action LIKE 'CODEX_%') THEN RAISE EXCEPTION 'Preserve Codex audit history before downgrade'; END IF; END $$;
-- +goose StatementEnd
ALTER TABLE golf_audit_events DROP CONSTRAINT golf_audit_events_action_check;
ALTER TABLE golf_audit_events DROP CONSTRAINT golf_audit_events_check;
ALTER TABLE golf_audit_events ADD CONSTRAINT golf_audit_events_action_check CHECK(action IN ('SIGN_IN','SIGN_OUT','SESSION_REVOKED','OTHER_SESSIONS_REVOKED','SESSION_REPLACED'));
ALTER TABLE golf_audit_events ADD CONSTRAINT golf_audit_events_check CHECK(
 (action='SIGN_IN' AND target_session_id=actor_session_id AND target_session_id IS NOT NULL AND revoked_count=0 AND expires_at IS NOT NULL) OR
 (action IN ('SIGN_OUT','SESSION_REPLACED') AND target_session_id=actor_session_id AND target_session_id IS NOT NULL AND revoked_count=1 AND expires_at IS NULL) OR
 (action='SESSION_REVOKED' AND target_session_id IS NOT NULL AND revoked_count=1 AND expires_at IS NULL) OR
 (action='OTHER_SESSIONS_REVOKED' AND target_session_id IS NULL AND expires_at IS NULL));
DROP TABLE golf_codex_auth;
DROP FUNCTION golf_codex_auth_binding_immutable();
DROP TABLE golf_codex_connections;

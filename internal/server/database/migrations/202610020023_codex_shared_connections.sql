-- +goose Up
ALTER TABLE golf_codex_connections ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE golf_codex_connections ADD COLUMN scope text NOT NULL DEFAULT 'PERSONAL' CHECK(scope IN ('PERSONAL','INSTANCE'));
ALTER TABLE golf_codex_connections ADD COLUMN name text NOT NULL DEFAULT 'Personal Codex' CHECK(char_length(name) BETWEEN 1 AND 100);
ALTER TABLE golf_codex_connections ADD COLUMN forge_url text;
UPDATE golf_codex_connections c SET forge_url=u.forge_url FROM golf_users u WHERE u.id=c.user_id;
ALTER TABLE golf_codex_connections ALTER COLUMN forge_url SET NOT NULL;
ALTER TABLE golf_codex_connections ADD CONSTRAINT golf_codex_scope_owner CHECK((scope='PERSONAL' AND user_id IS NOT NULL) OR (scope='INSTANCE' AND user_id IS NULL));
-- +goose StatementBegin
CREATE FUNCTION golf_codex_connection_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id<>OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.scope<>OLD.scope OR NEW.forge_url<>OLD.forge_url OR NEW.created_at<>OLD.created_at OR NEW.version<OLD.version THEN RAISE EXCEPTION 'Codex connection identity is immutable'; END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_codex_connection_identity_immutable BEFORE UPDATE ON golf_codex_connections FOR EACH ROW EXECUTE FUNCTION golf_codex_connection_identity_immutable();
CREATE INDEX golf_codex_shared_inventory ON golf_codex_connections(forge_url,scope,created_at,id);
CREATE TABLE golf_codex_connection_access (
 connection_id uuid NOT NULL REFERENCES golf_codex_connections(id) ON DELETE CASCADE,
 user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 PRIMARY KEY(connection_id,user_id)
);
ALTER TABLE golf_audit_events ADD COLUMN resource_id uuid CHECK(resource_id IS NULL OR action LIKE 'CODEX_%');
-- Shared grants are Golf identities, never provider credentials or task proof.
-- Audit events use the actual admin actor, not a synthetic service user.
ALTER TABLE golf_audit_events DROP CONSTRAINT golf_audit_events_action_check;
ALTER TABLE golf_audit_events DROP CONSTRAINT golf_audit_events_check;
ALTER TABLE golf_audit_events ADD CONSTRAINT golf_audit_events_action_check CHECK(action IN ('SIGN_IN','SIGN_OUT','SESSION_REVOKED','OTHER_SESSIONS_REVOKED','SESSION_REPLACED','CODEX_LOGIN_STARTED','CODEX_LOGIN_COMPLETED','CODEX_LOGIN_CANCELED','CODEX_CONNECTION_REFRESHED','CODEX_CONNECTION_DISCONNECTED','CODEX_CONNECTION_CREATED','CODEX_ACCESS_CHANGED'));
ALTER TABLE golf_audit_events ADD CONSTRAINT golf_audit_events_check CHECK(
 (action='SIGN_IN' AND target_session_id=actor_session_id AND target_session_id IS NOT NULL AND revoked_count=0 AND expires_at IS NOT NULL) OR
 (action IN ('SIGN_OUT','SESSION_REPLACED') AND target_session_id=actor_session_id AND target_session_id IS NOT NULL AND revoked_count=1 AND expires_at IS NULL) OR
 (action='SESSION_REVOKED' AND target_session_id IS NOT NULL AND revoked_count=1 AND expires_at IS NULL) OR
 (action='OTHER_SESSIONS_REVOKED' AND target_session_id IS NULL AND expires_at IS NULL) OR
 (action IN ('CODEX_LOGIN_STARTED','CODEX_LOGIN_COMPLETED','CODEX_LOGIN_CANCELED','CODEX_CONNECTION_REFRESHED','CODEX_CONNECTION_DISCONNECTED','CODEX_CONNECTION_CREATED','CODEX_ACCESS_CHANGED') AND target_session_id IS NULL AND revoked_count=0 AND expires_at IS NULL));
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN IF EXISTS(SELECT 1 FROM golf_codex_connections WHERE scope='INSTANCE') OR EXISTS(SELECT 1 FROM golf_audit_events WHERE action IN ('CODEX_CONNECTION_CREATED','CODEX_ACCESS_CHANGED')) THEN RAISE EXCEPTION 'Preserve shared Codex accounts/audit before downgrade'; END IF; END $$;
-- +goose StatementEnd
ALTER TABLE golf_audit_events DROP COLUMN resource_id;
DROP TRIGGER golf_codex_connection_identity_immutable ON golf_codex_connections;
DROP FUNCTION golf_codex_connection_identity_immutable();
DROP TABLE golf_codex_connection_access;
DROP INDEX golf_codex_shared_inventory;
ALTER TABLE golf_codex_connections DROP CONSTRAINT golf_codex_scope_owner;
ALTER TABLE golf_codex_connections DROP COLUMN scope,DROP COLUMN name,DROP COLUMN forge_url;
ALTER TABLE golf_codex_connections ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE golf_audit_events DROP CONSTRAINT golf_audit_events_action_check;
ALTER TABLE golf_audit_events DROP CONSTRAINT golf_audit_events_check;
ALTER TABLE golf_audit_events ADD CONSTRAINT golf_audit_events_action_check CHECK(action IN ('SIGN_IN','SIGN_OUT','SESSION_REVOKED','OTHER_SESSIONS_REVOKED','SESSION_REPLACED','CODEX_LOGIN_STARTED','CODEX_LOGIN_COMPLETED','CODEX_LOGIN_CANCELED','CODEX_CONNECTION_REFRESHED','CODEX_CONNECTION_DISCONNECTED'));
ALTER TABLE golf_audit_events ADD CONSTRAINT golf_audit_events_check CHECK(
 (action='SIGN_IN' AND target_session_id=actor_session_id AND target_session_id IS NOT NULL AND revoked_count=0 AND expires_at IS NOT NULL) OR
 (action IN ('SIGN_OUT','SESSION_REPLACED') AND target_session_id=actor_session_id AND target_session_id IS NOT NULL AND revoked_count=1 AND expires_at IS NULL) OR
 (action='SESSION_REVOKED' AND target_session_id IS NOT NULL AND revoked_count=1 AND expires_at IS NULL) OR
 (action='OTHER_SESSIONS_REVOKED' AND target_session_id IS NULL AND expires_at IS NULL) OR
 (action IN ('CODEX_LOGIN_STARTED','CODEX_LOGIN_COMPLETED','CODEX_LOGIN_CANCELED','CODEX_CONNECTION_REFRESHED','CODEX_CONNECTION_DISCONNECTED') AND target_session_id IS NULL AND revoked_count=0 AND expires_at IS NULL));

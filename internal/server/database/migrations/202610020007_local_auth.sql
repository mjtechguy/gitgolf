-- +goose Up
CREATE TABLE golf_local_accounts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL UNIQUE REFERENCES golf_users(id) ON DELETE RESTRICT,
    username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    password_hash text NOT NULL,
    encrypted_forge_token bytea NOT NULL,
    credential_binding bytea NOT NULL UNIQUE CHECK (octet_length(credential_binding) = 32),
    credential_key_id text NOT NULL CHECK (credential_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
    credential_version bigint NOT NULL DEFAULT 1 CHECK (credential_version > 0),
    is_instance_admin boolean NOT NULL DEFAULT false,
    disabled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, user_id)
);
CREATE INDEX golf_local_accounts_key ON golf_local_accounts(credential_key_id,id);
CREATE TRIGGER golf_local_account_active_key BEFORE INSERT OR UPDATE OF encrypted_forge_token, credential_key_id ON golf_local_accounts
FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
-- Identity mapping, the AEAD binding and the explicitly enrolled role cannot
-- be changed through reset/enable or ordinary credential-key rotation.
-- +goose StatementBegin
CREATE FUNCTION golf_local_account_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.username <> OLD.username OR
       NEW.credential_binding <> OLD.credential_binding OR NEW.is_instance_admin <> OLD.is_instance_admin OR
       NEW.created_at <> OLD.created_at OR NEW.credential_version < OLD.credential_version THEN
        RAISE EXCEPTION 'Local account identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER golf_local_account_immutable BEFORE UPDATE ON golf_local_accounts
FOR EACH ROW EXECUTE FUNCTION golf_local_account_immutable();

ALTER TABLE golf_sessions ADD COLUMN local_account_id bigint;
ALTER TABLE golf_sessions ADD COLUMN local_credential_version bigint;
ALTER TABLE golf_sessions ADD CONSTRAINT golf_session_local_account
FOREIGN KEY (local_account_id,user_id) REFERENCES golf_local_accounts(id,user_id) ON DELETE RESTRICT;
ALTER TABLE golf_sessions DROP CONSTRAINT golf_sessions_credential_kind_check;
ALTER TABLE golf_sessions ADD CONSTRAINT golf_sessions_credential_kind_check CHECK (credential_kind IN ('pat','oauth','local'));
ALTER TABLE golf_sessions ADD CONSTRAINT golf_session_local_binding CHECK (
    (credential_kind = 'local' AND local_account_id IS NOT NULL AND local_credential_version IS NOT NULL AND local_credential_version > 0) OR
    (credential_kind <> 'local' AND local_account_id IS NULL AND local_credential_version IS NULL)
);
CREATE INDEX golf_sessions_local_account ON golf_sessions(local_account_id);
ALTER TABLE golf_audit_events DROP CONSTRAINT golf_audit_events_credential_kind_check;
ALTER TABLE golf_audit_events ADD CONSTRAINT golf_audit_events_credential_kind_check CHECK (credential_kind IN ('pat','oauth','local'));
-- +goose StatementBegin
CREATE FUNCTION golf_local_session_current() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.local_account_id IS NOT NULL THEN
        PERFORM 1 FROM golf_local_accounts WHERE id = NEW.local_account_id AND user_id = NEW.user_id
            AND credential_version = NEW.local_credential_version AND disabled_at IS NULL FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Local session authority is no longer current'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER golf_local_session_current BEFORE INSERT OR UPDATE OF local_account_id,local_credential_version,credential_kind ON golf_sessions
FOR EACH ROW EXECUTE FUNCTION golf_local_session_current();

CREATE TABLE golf_local_account_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES golf_local_accounts(id) ON DELETE RESTRICT,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor text NOT NULL DEFAULT current_user,
    operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{32}$'),
    action text NOT NULL CHECK (action IN ('CREATED','PASSWORD_RESET','DISABLED','ENABLED','RECOVERY_DISABLED')),
    credential_version bigint NOT NULL CHECK (credential_version > 0),
    sessions_revoked bigint NOT NULL CHECK (sessions_revoked >= 0)
);
CREATE TRIGGER golf_local_account_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_local_account_events
FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

-- Fixed-size buckets avoid attacker-controlled username/IP rows. Bucket zero
-- is the global ceiling; 1..1024 are username hash buckets with possible collisions.
CREATE TABLE golf_local_login_limits (
    bucket smallint PRIMARY KEY CHECK (bucket BETWEEN 0 AND 1024),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    resets_at timestamptz NOT NULL DEFAULT 'epoch'
);
INSERT INTO golf_local_login_limits(bucket) SELECT generate_series(0,1024);
ALTER TABLE golf_crypto_events ADD COLUMN local_accounts_count bigint NOT NULL DEFAULT 0 CHECK (local_accounts_count >= 0);
ALTER TABLE golf_recovery_events ADD COLUMN local_accounts_disabled_count bigint NOT NULL DEFAULT 0 CHECK (local_accounts_disabled_count >= 0);

-- +goose Down
-- Never silently discard durable local credentials or their operation history.
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM golf_local_accounts) THEN
        RAISE EXCEPTION 'Local accounts exist; preserve them before an explicit downgrade';
    END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE golf_recovery_events DROP COLUMN local_accounts_disabled_count;
ALTER TABLE golf_crypto_events DROP COLUMN local_accounts_count;
DROP TABLE golf_local_login_limits;
DROP TABLE golf_local_account_events;
DROP TRIGGER golf_local_session_current ON golf_sessions;
DROP FUNCTION golf_local_session_current();
ALTER TABLE golf_sessions DROP CONSTRAINT golf_session_local_binding;
ALTER TABLE golf_sessions DROP COLUMN local_credential_version;
ALTER TABLE golf_sessions DROP COLUMN local_account_id;
ALTER TABLE golf_sessions DROP CONSTRAINT golf_sessions_credential_kind_check;
ALTER TABLE golf_sessions ADD CONSTRAINT golf_sessions_credential_kind_check CHECK (credential_kind IN ('pat','oauth'));
ALTER TABLE golf_audit_events DROP CONSTRAINT golf_audit_events_credential_kind_check;
ALTER TABLE golf_audit_events ADD CONSTRAINT golf_audit_events_credential_kind_check CHECK (credential_kind IN ('pat','oauth'));
DROP TABLE golf_local_accounts;
DROP FUNCTION golf_local_account_immutable();

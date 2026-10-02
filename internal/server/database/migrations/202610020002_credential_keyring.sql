-- +goose Up
-- Preserve every existing ciphertext byte; labels identify its exact decryptor.
ALTER TABLE golf_sessions ADD COLUMN credential_key_id text NOT NULL DEFAULT 'legacy'
CHECK (credential_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
ALTER TABLE golf_oauth_attempts ADD COLUMN credential_key_id text NOT NULL DEFAULT 'legacy'
CHECK (credential_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
CREATE INDEX golf_sessions_credential_key ON golf_sessions (credential_key_id, session_id);
CREATE INDEX golf_oauth_attempts_credential_key ON golf_oauth_attempts (credential_key_id, state_hash);

-- Fingerprints bind labels permanently; they are not decryption key material.
CREATE TABLE golf_encryption_keys (
    key_id text PRIMARY KEY CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor text NOT NULL DEFAULT current_user
);
CREATE TRIGGER golf_key_label_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_encryption_keys
FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

CREATE TABLE golf_encryption_policy (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    active_key_id text NOT NULL CHECK (active_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
);
INSERT INTO golf_encryption_policy (active_key_id) VALUES ('legacy');

-- A shared policy row lock linearizes credential writes with activation. It
-- does not make in-flight external OAuth exchanges reversible: drain writers.
-- +goose StatementBegin
CREATE FUNCTION golf_credential_active_key() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_id text;
BEGIN
    SELECT active_key_id INTO active_id FROM golf_encryption_policy WHERE singleton FOR SHARE;
    IF active_id IS NULL OR NEW.credential_key_id <> active_id THEN
        RAISE EXCEPTION 'Credential encryption key does not match the active policy';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER golf_session_active_key BEFORE INSERT OR UPDATE OF encrypted_token, credential_key_id ON golf_sessions
FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
CREATE TRIGGER golf_oauth_attempt_active_key BEFORE INSERT OR UPDATE OF encrypted_verifier, credential_key_id ON golf_oauth_attempts
FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();

CREATE TABLE golf_crypto_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor text NOT NULL DEFAULT current_user,
    operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{32}$'),
    action text NOT NULL CHECK (action IN ('ACTIVE_KEY_CHANGED', 'CREDENTIAL_BATCH_REENCRYPTED', 'RETIREMENT_CHECKED')),
    key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
    sessions_count bigint NOT NULL CHECK (sessions_count >= 0),
    oauth_attempts_count bigint NOT NULL CHECK (oauth_attempts_count >= 0)
);
CREATE TRIGGER golf_crypto_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_crypto_events
FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

-- +goose Down
-- Downgrade cannot interpret nonlegacy ciphertext. Refuse instead of erasing it.
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM golf_sessions WHERE credential_key_id <> 'legacy') OR
       EXISTS (SELECT 1 FROM golf_oauth_attempts WHERE credential_key_id <> 'legacy') OR
       EXISTS (SELECT 1 FROM golf_encryption_policy WHERE active_key_id <> 'legacy') THEN
        RAISE EXCEPTION 'Rotate credentials and active policy to legacy before downgrade';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE golf_crypto_events;
DROP TRIGGER golf_session_active_key ON golf_sessions;
DROP TRIGGER golf_oauth_attempt_active_key ON golf_oauth_attempts;
DROP FUNCTION golf_credential_active_key();
DROP TABLE golf_encryption_policy;
DROP TABLE golf_encryption_keys;
DROP INDEX golf_sessions_credential_key;
DROP INDEX golf_oauth_attempts_credential_key;
ALTER TABLE golf_sessions DROP COLUMN credential_key_id;
ALTER TABLE golf_oauth_attempts DROP COLUMN credential_key_id;

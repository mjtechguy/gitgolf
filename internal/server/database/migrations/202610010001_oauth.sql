-- +goose Up
ALTER TABLE golf_sessions ADD COLUMN credential_kind text NOT NULL DEFAULT 'pat'
    CHECK (credential_kind IN ('pat', 'oauth'));
CREATE TABLE golf_oauth_attempts (
    state_hash bytea PRIMARY KEY,
    binding_hash bytea NOT NULL,
    encrypted_verifier bytea NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX golf_oauth_attempts_expiry ON golf_oauth_attempts (expires_at);

-- +goose Down
DROP TABLE golf_oauth_attempts;
-- OAuth envelopes must never be interpreted as PATs after a downgrade.
DELETE FROM golf_sessions WHERE credential_kind = 'oauth';
ALTER TABLE golf_sessions DROP COLUMN credential_kind;

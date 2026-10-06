-- +goose Up
-- Reuse the existing encrypted-content/key-rotation boundary; only metadata and
-- one-way high-entropy recovery digests live in the account tables.
ALTER TABLE golf_notification_contents DROP CONSTRAINT golf_notification_contents_kind_check;
ALTER TABLE golf_notification_contents ADD CONSTRAINT golf_notification_contents_kind_check CHECK(kind IN ('transport','contact','subscription','mail','mfa'));
CREATE TABLE golf_local_mfa (
 account_id bigint PRIMARY KEY REFERENCES golf_local_accounts(id),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), enabled boolean NOT NULL DEFAULT false,
 active_content_id uuid REFERENCES golf_notification_contents(id),
 pending_content_id uuid REFERENCES golf_notification_contents(id),pending_expires_at timestamptz,
 last_counter bigint NOT NULL DEFAULT -1 CHECK(last_counter>=-1),
 CHECK(enabled=(active_content_id IS NOT NULL)),
 CHECK((pending_content_id IS NULL)=(pending_expires_at IS NULL))
);
CREATE TABLE golf_mfa_recovery_codes (
 account_id bigint NOT NULL REFERENCES golf_local_mfa(account_id),version bigint NOT NULL,
 code_hash bytea NOT NULL CHECK(octet_length(code_hash)=32),used_at timestamptz,
 PRIMARY KEY(account_id,version,code_hash)
);
CREATE TABLE golf_mfa_login_challenges (
 token_hash bytea PRIMARY KEY CHECK(octet_length(token_hash)=32),
 account_id bigint NOT NULL REFERENCES golf_local_accounts(id),user_id bigint NOT NULL REFERENCES golf_users(id),
 credential_version bigint NOT NULL,mfa_version bigint NOT NULL,
 expires_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX golf_mfa_login_challenge_expiry ON golf_mfa_login_challenges(account_id,expires_at);
CREATE TABLE golf_mfa_attempts (account_id bigint PRIMARY KEY REFERENCES golf_local_accounts(id),window_start timestamptz NOT NULL,attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 10));
CREATE TABLE golf_mfa_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,account_id bigint NOT NULL REFERENCES golf_local_accounts(id),
 user_id bigint NOT NULL REFERENCES golf_users(id),action text NOT NULL CHECK(action IN ('setup_started','enabled','disabled','recovery_regenerated','recovery_used')),
 version bigint NOT NULL CHECK(version>0),operation_id text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER golf_mfa_events_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_mfa_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Local MFA credentials and audit require coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd

-- +goose Up
-- A verified notification mailbox is not password-recovery consent.
CREATE TABLE golf_password_recovery_enrollments (
 user_id bigint PRIMARY KEY REFERENCES golf_users(id),
 local_account_id bigint NOT NULL REFERENCES golf_local_accounts(id),
 native_user_id bigint NOT NULL CHECK(native_user_id>0),
 credential_version bigint NOT NULL CHECK(credential_version>0),
 contact_version bigint NOT NULL CHECK(contact_version>=0),
 version bigint NOT NULL CHECK(version>0),enabled boolean NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(NOT enabled OR contact_version>0)
);
CREATE TABLE golf_password_recovery_enrollment_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id),local_account_id bigint NOT NULL REFERENCES golf_local_accounts(id),
 native_user_id bigint NOT NULL CHECK(native_user_id>0),credential_version bigint NOT NULL CHECK(credential_version>0),
 contact_version bigint NOT NULL CHECK(contact_version>=0),version bigint NOT NULL CHECK(version>0),enabled boolean NOT NULL,
 actor_session_id bigint NOT NULL CHECK(actor_session_id>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,version)
);
CREATE TRIGGER golf_password_recovery_enrollment_events_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_password_recovery_enrollment_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Preserve explicit recovery consent and audit before coordinated downgrade'; END $$;
-- +goose StatementEnd

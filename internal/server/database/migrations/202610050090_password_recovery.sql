-- +goose Up
ALTER TABLE golf_email_challenges ADD COLUMN purpose text NOT NULL DEFAULT 'verification' CHECK(purpose IN ('verification','password_recovery'));
ALTER TABLE golf_email_challenges ADD COLUMN password_recovery_enrollment_version bigint;
ALTER TABLE golf_email_challenges ADD CONSTRAINT golf_email_challenge_purpose_binding CHECK((purpose='verification' AND password_recovery_enrollment_version IS NULL) OR (purpose='password_recovery' AND password_recovery_enrollment_version IS NOT NULL AND password_recovery_enrollment_version>0));
CREATE TABLE golf_password_recovery_limits (
 bucket smallint PRIMARY KEY CHECK(bucket BETWEEN 0 AND 1024),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 121),
 resets_at timestamptz NOT NULL DEFAULT 'epoch'
);
INSERT INTO golf_password_recovery_limits(bucket) SELECT generate_series(0,1024);
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Recovery challenges require deliberate quarantine, not downgrade'; END $$;
-- +goose StatementEnd

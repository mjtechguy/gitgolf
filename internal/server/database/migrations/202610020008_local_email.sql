-- +goose Up
-- Operator-enrolled login alias; never inferred from native profile emails.
ALTER TABLE golf_local_accounts ADD COLUMN email text UNIQUE CHECK (
    email IS NULL OR (email = lower(email) AND octet_length(email) <= 254 AND
    email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$')
);
ALTER TABLE golf_local_account_events DROP CONSTRAINT golf_local_account_events_action_check;
ALTER TABLE golf_local_account_events ADD CONSTRAINT golf_local_account_events_action_check
CHECK (action IN ('CREATED','PASSWORD_RESET','DISABLED','ENABLED','RECOVERY_DISABLED','EMAIL_CHANGED'));

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM golf_local_accounts WHERE email IS NOT NULL) OR
       EXISTS (SELECT 1 FROM golf_local_account_events WHERE action = 'EMAIL_CHANGED') THEN
        RAISE EXCEPTION 'Local email identities exist; preserve them before an explicit downgrade';
    END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE golf_local_account_events DROP CONSTRAINT golf_local_account_events_action_check;
ALTER TABLE golf_local_account_events ADD CONSTRAINT golf_local_account_events_action_check
CHECK (action IN ('CREATED','PASSWORD_RESET','DISABLED','ENABLED','RECOVERY_DISABLED'));
ALTER TABLE golf_local_accounts DROP COLUMN email;

-- +goose Up
ALTER TABLE golf_local_account_events ADD COLUMN actor_user_id bigint REFERENCES golf_users(id) ON DELETE RESTRICT;
ALTER TABLE golf_local_account_events ADD COLUMN actor_session_id bigint CHECK (actor_session_id > 0);
ALTER TABLE golf_local_account_events DROP CONSTRAINT golf_local_account_events_action_check;
ALTER TABLE golf_local_account_events ADD CONSTRAINT golf_local_account_events_action_check
CHECK (action IN ('CREATED','PASSWORD_RESET','DISABLED','ENABLED','RECOVERY_DISABLED','EMAIL_CHANGED','ADMIN_DISABLED'));
ALTER TABLE golf_local_account_events ADD CONSTRAINT golf_local_account_events_admin_actor
CHECK ((action = 'ADMIN_DISABLED' AND actor_user_id IS NOT NULL AND actor_session_id IS NOT NULL) OR
       (action <> 'ADMIN_DISABLED' AND actor_user_id IS NULL AND actor_session_id IS NULL));

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM golf_local_account_events WHERE action = 'ADMIN_DISABLED') THEN
        RAISE EXCEPTION 'Administrator account events exist; preserve them before an explicit downgrade';
    END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE golf_local_account_events DROP CONSTRAINT golf_local_account_events_admin_actor;
ALTER TABLE golf_local_account_events DROP CONSTRAINT golf_local_account_events_action_check;
ALTER TABLE golf_local_account_events ADD CONSTRAINT golf_local_account_events_action_check
CHECK (action IN ('CREATED','PASSWORD_RESET','DISABLED','ENABLED','RECOVERY_DISABLED','EMAIL_CHANGED'));
ALTER TABLE golf_local_account_events DROP COLUMN actor_session_id;
ALTER TABLE golf_local_account_events DROP COLUMN actor_user_id;

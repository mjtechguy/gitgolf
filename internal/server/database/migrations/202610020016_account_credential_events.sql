-- +goose Up
ALTER TABLE golf_local_account_events DROP CONSTRAINT golf_local_account_events_admin_actor;
ALTER TABLE golf_local_account_events DROP CONSTRAINT golf_local_account_events_action_check;
ALTER TABLE golf_local_account_events ADD CONSTRAINT golf_local_account_events_action_check
CHECK (action IN ('CREATED','PASSWORD_RESET','DISABLED','ENABLED','RECOVERY_DISABLED','EMAIL_CHANGED','ADMIN_DISABLED',
    'SELF_PASSWORD_CHANGED','SELF_EMAIL_CHANGED','ADMIN_CREATED','ADMIN_PASSWORD_RESET','ADMIN_ENABLED'));
ALTER TABLE golf_local_account_events ADD CONSTRAINT golf_local_account_events_admin_actor
CHECK ((action IN ('ADMIN_DISABLED','SELF_PASSWORD_CHANGED','SELF_EMAIL_CHANGED','ADMIN_CREATED','ADMIN_PASSWORD_RESET','ADMIN_ENABLED')
        AND actor_user_id IS NOT NULL AND actor_session_id IS NOT NULL) OR
       (action IN ('CREATED','PASSWORD_RESET','DISABLED','ENABLED','RECOVERY_DISABLED','EMAIL_CHANGED')
        AND actor_user_id IS NULL AND actor_session_id IS NULL));

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM golf_local_account_events WHERE action IN
        ('SELF_PASSWORD_CHANGED','SELF_EMAIL_CHANGED','ADMIN_CREATED','ADMIN_PASSWORD_RESET','ADMIN_ENABLED')) THEN
        RAISE EXCEPTION 'Credential change audit events exist; preserve them before explicit downgrade';
    END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE golf_local_account_events DROP CONSTRAINT golf_local_account_events_admin_actor;
ALTER TABLE golf_local_account_events DROP CONSTRAINT golf_local_account_events_action_check;
ALTER TABLE golf_local_account_events ADD CONSTRAINT golf_local_account_events_action_check
CHECK (action IN ('CREATED','PASSWORD_RESET','DISABLED','ENABLED','RECOVERY_DISABLED','EMAIL_CHANGED','ADMIN_DISABLED'));
ALTER TABLE golf_local_account_events ADD CONSTRAINT golf_local_account_events_admin_actor
CHECK ((action = 'ADMIN_DISABLED' AND actor_user_id IS NOT NULL AND actor_session_id IS NOT NULL) OR
       (action <> 'ADMIN_DISABLED' AND actor_user_id IS NULL AND actor_session_id IS NULL));

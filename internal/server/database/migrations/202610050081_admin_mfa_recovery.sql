-- +goose Up
ALTER TABLE golf_mfa_events DROP CONSTRAINT golf_mfa_events_action_check;
ALTER TABLE golf_mfa_events ADD CONSTRAINT golf_mfa_events_action_check CHECK(action IN ('setup_started','enabled','disabled','recovery_regenerated','recovery_used','admin_reset','operator_reset'));
ALTER TABLE golf_mfa_events ADD COLUMN actor_user_id bigint REFERENCES golf_users(id),ADD COLUMN actor_session_id bigint,ADD COLUMN reason text NOT NULL DEFAULT '',ADD COLUMN actor_kind text NOT NULL DEFAULT 'user' CHECK(actor_kind IN ('user','operator'));
ALTER TABLE golf_mfa_events ADD CONSTRAINT golf_mfa_admin_actor CHECK(
 (action='admin_reset' AND actor_kind='user' AND actor_user_id IS NOT NULL AND actor_user_id<>user_id AND actor_session_id IS NOT NULL AND actor_session_id>0 AND length(reason) BETWEEN 1 AND 512 AND length(operation_id)>0)
 OR (action='operator_reset' AND actor_kind='operator' AND actor_user_id IS NULL AND actor_session_id IS NULL AND length(reason) BETWEEN 1 AND 512 AND length(operation_id)>0)
 OR (action NOT IN ('admin_reset','operator_reset') AND actor_kind='user' AND actor_user_id IS NULL AND actor_session_id IS NULL AND reason=''));

ALTER TABLE golf_local_account_events DROP CONSTRAINT golf_local_account_events_action_check;
ALTER TABLE golf_local_account_events ADD CONSTRAINT golf_local_account_events_action_check CHECK(action IN ('CREATED','PASSWORD_RESET','DISABLED','ENABLED','RECOVERY_DISABLED','EMAIL_CHANGED','ADMIN_DISABLED','SELF_PASSWORD_CHANGED','SELF_EMAIL_CHANGED','ADMIN_CREATED','ADMIN_PASSWORD_RESET','ADMIN_ENABLED','ADMIN_MFA_RESET','OPERATOR_MFA_RESET'));
ALTER TABLE golf_local_account_events DROP CONSTRAINT golf_local_account_events_admin_actor;
ALTER TABLE golf_local_account_events ADD CONSTRAINT golf_local_account_events_admin_actor CHECK((action IN ('ADMIN_DISABLED','SELF_PASSWORD_CHANGED','SELF_EMAIL_CHANGED','ADMIN_CREATED','ADMIN_PASSWORD_RESET','ADMIN_ENABLED','ADMIN_MFA_RESET') AND actor_user_id IS NOT NULL AND actor_session_id IS NOT NULL) OR (action IN ('CREATED','PASSWORD_RESET','DISABLED','ENABLED','RECOVERY_DISABLED','EMAIL_CHANGED','OPERATOR_MFA_RESET') AND actor_user_id IS NULL AND actor_session_id IS NULL));
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Audited MFA recovery requires coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd

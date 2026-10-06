-- +goose Up
ALTER TABLE golf_recovery_events ADD COLUMN quarantine_counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(quarantine_counts)='object');
ALTER TABLE golf_mfa_events DROP CONSTRAINT golf_mfa_events_action_check;
ALTER TABLE golf_mfa_events ADD CONSTRAINT golf_mfa_events_action_check CHECK(action IN ('setup_started','enabled','disabled','recovery_regenerated','recovery_used','admin_reset','operator_reset','restore_reset'));
ALTER TABLE golf_mfa_events DROP CONSTRAINT golf_mfa_admin_actor;
ALTER TABLE golf_mfa_events ADD CONSTRAINT golf_mfa_admin_actor CHECK(
 (action='admin_reset' AND actor_kind='user' AND actor_user_id IS NOT NULL AND actor_user_id<>user_id AND actor_session_id IS NOT NULL AND actor_session_id>0 AND length(reason) BETWEEN 1 AND 512 AND length(operation_id)>0)
 OR (action IN ('operator_reset','restore_reset') AND actor_kind='operator' AND actor_user_id IS NULL AND actor_session_id IS NULL AND length(reason) BETWEEN 1 AND 512 AND length(operation_id)>0)
 OR (action NOT IN ('admin_reset','operator_reset','restore_reset') AND actor_kind='user' AND actor_user_id IS NULL AND actor_session_id IS NULL AND reason=''));
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Preserve recovery authority quarantine and MFA audit before downgrade'; END $$;
-- +goose StatementEnd

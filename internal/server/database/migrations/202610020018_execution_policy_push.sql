-- +goose Up
-- Existing scopes and prior policy events did not authorize push execution.
-- Both defaults remain deny; enabling manual dispatch grants no automatic work.
ALTER TABLE golf_execution_policies ADD COLUMN push_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE golf_execution_policy_events ADD COLUMN push_allowed boolean NOT NULL DEFAULT false;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM golf_execution_policies WHERE push_allowed)
       OR EXISTS (SELECT 1 FROM golf_execution_policy_events WHERE push_allowed) THEN
        RAISE EXCEPTION 'Push execution policy/history exists; preserve it before explicit downgrade';
    END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE golf_execution_policy_events DROP COLUMN push_allowed;
ALTER TABLE golf_execution_policies DROP COLUMN push_allowed;

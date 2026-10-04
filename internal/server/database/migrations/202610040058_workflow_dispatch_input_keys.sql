-- +goose Up
ALTER TABLE golf_crypto_events ADD COLUMN workflow_dispatch_inputs_count bigint NOT NULL DEFAULT 0 CHECK(workflow_dispatch_inputs_count>=0);

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained workflow input key audit requires coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd

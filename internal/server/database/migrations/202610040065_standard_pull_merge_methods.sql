-- +goose Up
-- Preserve all historical original-key fingerprints and outcomes as merge.
ALTER TABLE golf_standard_pull_merges
 ADD COLUMN method text NOT NULL DEFAULT 'merge' CHECK(method IN ('merge','squash'));
-- Existing to_jsonb immutable identity guard includes method automatically.
-- No rewrite of fingerprints, outcomes, locks or historical receipt contracts.
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained merge methods require qualified offline recovery; no automatic downgrade'; END $$;
-- +goose StatementEnd

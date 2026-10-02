-- +goose Up
CREATE TABLE golf_runner_presence (
 forge_url text NOT NULL,
 runner_id text NOT NULL CHECK(runner_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
 last_seen timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(forge_url,runner_id)
);
-- +goose Down
DROP TABLE golf_runner_presence;

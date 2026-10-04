-- +goose Up
CREATE TABLE golf_runner_controls (
 forge_url text NOT NULL,
 runner_id text NOT NULL CHECK(runner_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
 state text NOT NULL CHECK(state IN ('active','draining','revoked')),
 version bigint NOT NULL CHECK(version > 0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(forge_url,runner_id)
);
CREATE TABLE golf_runner_control_audit (
 forge_url text NOT NULL, runner_id text NOT NULL, version bigint NOT NULL,
 actor_user_id bigint NOT NULL, previous_state text NOT NULL, state text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(forge_url,runner_id,version),
 FOREIGN KEY(forge_url,runner_id) REFERENCES golf_runner_controls(forge_url,runner_id)
);
-- +goose StatementBegin
CREATE FUNCTION golf_runner_control_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' OR OLD.state = 'revoked' OR NEW.forge_url != OLD.forge_url OR NEW.runner_id != OLD.runner_id OR NEW.version != OLD.version + 1 OR NEW.state = OLD.state OR (NEW.state = 'active' AND OLD.state != 'draining') THEN
  RAISE EXCEPTION 'invalid runner control transition';
 END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER golf_runner_control_transition BEFORE UPDATE OR DELETE ON golf_runner_controls FOR EACH ROW EXECUTE FUNCTION golf_runner_control_transition();
-- +goose Down
DROP TABLE golf_runner_control_audit;
DROP TABLE golf_runner_controls;
DROP FUNCTION golf_runner_control_transition();

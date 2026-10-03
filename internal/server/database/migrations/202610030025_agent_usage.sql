-- +goose Up
ALTER TABLE golf_codex_connections DROP CONSTRAINT golf_codex_connections_provider_check;
ALTER TABLE golf_codex_connections ADD CONSTRAINT golf_codex_connections_provider_check CHECK(provider IN ('openai','anthropic','opencode','opencode-go'));
CREATE TABLE golf_agent_usage_settings (
 forge_url text NOT NULL, scope text NOT NULL CHECK(scope IN ('personal','instance','organization','repository')),
 scope_id text NOT NULL, owner_id bigint NOT NULL, revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(forge_url,scope,scope_id)
);
CREATE TABLE golf_agent_usage_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, forge_url text NOT NULL, scope text NOT NULL, scope_id text NOT NULL,
 revision bigint NOT NULL, actor_user_id bigint NOT NULL REFERENCES golf_users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE golf_agent_model_catalogs (
 connection_id uuid PRIMARY KEY REFERENCES golf_codex_connections(id) ON DELETE CASCADE,
 connection_version bigint NOT NULL, models jsonb NOT NULL CHECK(jsonb_typeof(models)='array'), checked_at timestamptz NOT NULL DEFAULT now()
);
-- +goose Down
DROP TABLE golf_agent_model_catalogs,golf_agent_usage_events,golf_agent_usage_settings;
-- +goose StatementBegin
DO $$ BEGIN IF EXISTS(SELECT 1 FROM golf_codex_connections WHERE provider='opencode-go') THEN RAISE EXCEPTION 'Preserve Go connections before downgrade'; END IF; END $$;
-- +goose StatementEnd
ALTER TABLE golf_codex_connections DROP CONSTRAINT golf_codex_connections_provider_check;
ALTER TABLE golf_codex_connections ADD CONSTRAINT golf_codex_connections_provider_check CHECK(provider IN ('openai','anthropic','opencode'));

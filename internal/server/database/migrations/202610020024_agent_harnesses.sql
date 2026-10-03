-- +goose Up
-- Preserve existing Codex identity and encrypted credential bindings.
ALTER TABLE golf_codex_connections ADD COLUMN harness text NOT NULL DEFAULT 'codex' CHECK(harness IN ('codex','claude-code','opencode'));
ALTER TABLE golf_codex_connections ADD COLUMN provider text NOT NULL DEFAULT 'openai' CHECK(provider IN ('openai','anthropic','opencode'));
ALTER TABLE golf_codex_connections ADD CONSTRAINT golf_agent_provider CHECK((harness='codex' AND provider='openai') OR (harness='claude-code' AND provider='anthropic') OR harness='opencode');
ALTER TABLE golf_codex_connections DROP CONSTRAINT golf_codex_connections_user_id_key;
ALTER TABLE golf_codex_connections ADD CONSTRAINT golf_agent_personal_unique UNIQUE(user_id,harness,provider);
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION golf_codex_connection_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id<>OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.scope<>OLD.scope OR NEW.forge_url<>OLD.forge_url OR NEW.created_at<>OLD.created_at OR NEW.version<OLD.version OR NEW.harness<>OLD.harness OR NEW.provider<>OLD.provider THEN RAISE EXCEPTION 'Agent connection identity is immutable'; END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN IF EXISTS(SELECT 1 FROM golf_codex_connections WHERE harness<>'codex' OR provider<>'openai') THEN RAISE EXCEPTION 'Preserve additional agent connections before downgrade'; END IF; END $$;
CREATE OR REPLACE FUNCTION golf_codex_connection_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id<>OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.scope<>OLD.scope OR NEW.forge_url<>OLD.forge_url OR NEW.created_at<>OLD.created_at OR NEW.version<OLD.version THEN RAISE EXCEPTION 'Codex connection identity is immutable'; END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
ALTER TABLE golf_codex_connections DROP CONSTRAINT golf_agent_personal_unique;
ALTER TABLE golf_codex_connections ADD CONSTRAINT golf_codex_connections_user_id_key UNIQUE(user_id);
ALTER TABLE golf_codex_connections DROP COLUMN harness,DROP COLUMN provider;

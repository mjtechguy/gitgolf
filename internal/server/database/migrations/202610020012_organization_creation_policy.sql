-- +goose Up
CREATE TABLE golf_organization_creation_policies (
 forge_url text PRIMARY KEY,
 mode text NOT NULL CHECK(mode IN ('administrators_only','selected_users','all_users')),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 revocation_epoch bigint NOT NULL DEFAULT 0 CHECK(revocation_epoch>=0)
);
CREATE TABLE golf_organization_creation_selections (
 forge_url text NOT NULL REFERENCES golf_organization_creation_policies(forge_url) ON DELETE RESTRICT,
 user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 PRIMARY KEY(forge_url,user_id)
);
CREATE TABLE golf_organization_creation_policy_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 forge_url text NOT NULL REFERENCES golf_organization_creation_policies(forge_url) ON DELETE RESTRICT,
 revision bigint NOT NULL CHECK(revision>0),revocation_epoch bigint NOT NULL CHECK(revocation_epoch>0),
 actor_user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 actor_session_id bigint NOT NULL CHECK(actor_session_id>0),
 mode text NOT NULL CHECK(mode IN ('administrators_only','selected_users','all_users')),
 selected_user_count integer NOT NULL CHECK(selected_user_count>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(forge_url,revision)
);
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_organization_creation_policy_events) THEN RAISE EXCEPTION 'Organization creation policy audit exists; preserve before explicit downgrade'; END IF;
END $$;
-- +goose StatementEnd
DROP TABLE golf_organization_creation_policy_events;
DROP TABLE golf_organization_creation_selections;
DROP TABLE golf_organization_creation_policies;

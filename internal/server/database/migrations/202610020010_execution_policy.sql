-- +goose Up
CREATE TABLE golf_execution_policies (
 forge_url text NOT NULL,
 scope text NOT NULL CHECK(scope IN ('instance','organization','repository')),
 scope_id text NOT NULL CHECK(scope_id = 'instance' OR scope_id ~ '^[1-9][0-9]{0,18}$'),
 owner_id bigint NOT NULL CHECK(owner_id >= 0),
 mode text NOT NULL CHECK(mode IN ('disabled','all','selected')),
 manual_dispatch_enabled boolean NOT NULL DEFAULT false,
 allow_all_workflows boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision >= 0),
 revocation_epoch bigint NOT NULL DEFAULT 0 CHECK(revocation_epoch >= 0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(forge_url,scope,scope_id),
 CHECK((scope='instance' AND scope_id='instance' AND owner_id=0) OR (scope<>'instance' AND scope_id<>'instance' AND owner_id>0)),
 CHECK(scope<>'repository' OR mode<>'selected')
);
CREATE TABLE golf_execution_policy_repositories (
 forge_url text NOT NULL,scope text NOT NULL,scope_id text NOT NULL,
 repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),
 PRIMARY KEY(forge_url,scope,scope_id,repository_id),
 FOREIGN KEY(forge_url,scope,scope_id) REFERENCES golf_execution_policies(forge_url,scope,scope_id) ON DELETE RESTRICT
);
CREATE TABLE golf_execution_policy_workflows (
 forge_url text NOT NULL,scope text NOT NULL,scope_id text NOT NULL,
 workflow_path text NOT NULL CHECK(octet_length(workflow_path)<=255),
 PRIMARY KEY(forge_url,scope,scope_id,workflow_path),
 FOREIGN KEY(forge_url,scope,scope_id) REFERENCES golf_execution_policies(forge_url,scope,scope_id) ON DELETE RESTRICT
);
CREATE TABLE golf_execution_policy_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 forge_url text NOT NULL,scope text NOT NULL,scope_id text NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),revocation_epoch bigint NOT NULL CHECK(revocation_epoch>0),
 actor_user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 actor_session_id bigint NOT NULL CHECK(actor_session_id>0),
 action text NOT NULL CHECK(action='UPDATED'),
 mode text NOT NULL CHECK(mode IN ('disabled','all','selected')),
 manual_dispatch_enabled boolean NOT NULL,allow_all_workflows boolean NOT NULL,
 selected_repository_count integer NOT NULL CHECK(selected_repository_count>=0),
 workflow_count integer NOT NULL CHECK(workflow_count>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(forge_url,scope,scope_id) REFERENCES golf_execution_policies(forge_url,scope,scope_id) ON DELETE RESTRICT,
 UNIQUE(forge_url,scope,scope_id,revision)
);
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_execution_policy_events) THEN RAISE EXCEPTION 'Execution policy history exists; preserve it before explicit downgrade'; END IF;
END $$;
-- +goose StatementEnd
DROP TABLE golf_execution_policy_events;
DROP TABLE golf_execution_policy_workflows;
DROP TABLE golf_execution_policy_repositories;
DROP TABLE golf_execution_policies;

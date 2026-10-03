-- +goose Up
CREATE TABLE golf_agent_tasks (
 id uuid PRIMARY KEY,
 forge_url text NOT NULL,
 repository_id bigint NOT NULL CHECK(repository_id>0),
 owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL,
 repository_name text NOT NULL,
 user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 native_user_id bigint NOT NULL CHECK(native_user_id>0),
 session_hash bytea NOT NULL CHECK(octet_length(session_hash)=32),
 connection_id uuid NOT NULL REFERENCES golf_codex_connections(id) ON DELETE RESTRICT,
 connection_version bigint NOT NULL,
 commit_id text NOT NULL CHECK(commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 source_archive bytea NOT NULL CHECK(octet_length(source_archive)<=16777216),
 config jsonb NOT NULL,
 policy_fingerprint text NOT NULL,
 idempotency_key uuid NOT NULL,
 input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','cancelled','timed_out','budget_exceeded','lost')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 worker_id text NOT NULL DEFAULT '',
 attempt_id text NOT NULL DEFAULT '',
 lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 started_at timestamptz,
 finished_at timestamptz,
 summary text NOT NULL DEFAULT '' CHECK(octet_length(summary)<=65536),
 patch text NOT NULL DEFAULT '' CHECK(octet_length(patch)<=65536),
 reason text NOT NULL DEFAULT '',
 tokens bigint NOT NULL DEFAULT 0 CHECK(tokens>=0),
 UNIQUE(forge_url,user_id,idempotency_key)
);
CREATE INDEX golf_agent_tasks_queue ON golf_agent_tasks(forge_url,state,created_at,id);
CREATE INDEX golf_agent_tasks_account ON golf_agent_tasks(connection_id,state);
CREATE TABLE golf_agent_worker_presence (
 forge_url text NOT NULL,
 worker_id text NOT NULL,
 image text NOT NULL,
 last_seen timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(forge_url,worker_id)
);
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_agent_tasks) THEN RAISE EXCEPTION 'Preserve managed task history before downgrade'; END IF;
END $$;
-- +goose StatementEnd
DROP TABLE golf_agent_worker_presence;
DROP TABLE golf_agent_tasks;

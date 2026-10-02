-- +goose Up
CREATE TABLE golf_workflow_runs (
 id uuid PRIMARY KEY,
 forge_url text NOT NULL,
 repository_id bigint NOT NULL CHECK(repository_id>0),
 owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL,
 repository_name text NOT NULL,
 organization_owned boolean NOT NULL,
 user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 session_hash bytea NOT NULL CHECK(octet_length(session_hash)=32),
 commit_id text NOT NULL CHECK(commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 workflow_path text NOT NULL CHECK(octet_length(workflow_path)<=255),
 blob_id text NOT NULL CHECK(blob_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 format integer NOT NULL CHECK(format IN (1,2)),
 plan jsonb NOT NULL,
 source_archive bytea NOT NULL CHECK(octet_length(source_archive)<=16777216),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 policy_epochs jsonb NOT NULL,
 idempotency_key uuid NOT NULL,
 input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','cancelled','timed_out','lost')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 started_at timestamptz,
 finished_at timestamptz,
 exit_code integer,
 reason text NOT NULL DEFAULT '',
 runner_id text NOT NULL DEFAULT '',
 attempt_id text NOT NULL DEFAULT '' CHECK(attempt_id='' OR attempt_id ~ '^[a-f0-9]{32}$'),
 lease_token_hash bytea CHECK(lease_token_hash IS NULL OR octet_length(lease_token_hash)=32),
 lease_expires_at timestamptz,
 cancel_requested boolean NOT NULL DEFAULT false,
 logs_truncated boolean NOT NULL DEFAULT false,
 log_bytes bigint NOT NULL DEFAULT 0 CHECK(log_bytes>=0 AND log_bytes<=1048576),
 log_sequence bigint NOT NULL DEFAULT 0 CHECK(log_sequence>=0),
 UNIQUE(forge_url,user_id,idempotency_key)
);
CREATE INDEX golf_workflow_runs_queue ON golf_workflow_runs(forge_url,state,created_at);
CREATE INDEX golf_workflow_runs_repository ON golf_workflow_runs(forge_url,repository_id,created_at DESC,id DESC);
CREATE TABLE golf_workflow_run_logs (
 run_id uuid NOT NULL REFERENCES golf_workflow_runs(id) ON DELETE RESTRICT,
 sequence bigint NOT NULL CHECK(sequence>0),
 text text NOT NULL CHECK(octet_length(text)<=16384),
 PRIMARY KEY(run_id,sequence)
);
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_workflow_runs) THEN RAISE EXCEPTION 'Workflow history exists; preserve it before explicit downgrade'; END IF;
END $$;
-- +goose StatementEnd
DROP TABLE golf_workflow_run_logs;
DROP TABLE golf_workflow_runs;

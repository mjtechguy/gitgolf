-- +goose Up
CREATE TABLE golf_reviewers (
 id uuid PRIMARY KEY,
 forge_url text NOT NULL,
 repository_id bigint NOT NULL,
 owner_id bigint NOT NULL,
 repository_owner text NOT NULL,
 repository_name text NOT NULL,
 sponsor_user_id bigint NOT NULL REFERENCES golf_users(id),
 sponsor_native_id bigint NOT NULL,
 local_account_id bigint NOT NULL REFERENCES golf_local_accounts(id),
 local_version bigint NOT NULL,
 publisher_id bigint NOT NULL,
 config jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL,
 UNIQUE(forge_url,repository_id)
);
CREATE TABLE golf_reviewer_runs (
 id uuid PRIMARY KEY,
 reviewer_id uuid NOT NULL REFERENCES golf_reviewers(id),
 reviewer_revision bigint NOT NULL,
 pull_number bigint NOT NULL,
 base_commit text NOT NULL,
 head_commit text NOT NULL,
 trigger text NOT NULL,
 intent text NOT NULL,
 task_id uuid UNIQUE REFERENCES golf_agent_tasks(id),
 state text NOT NULL DEFAULT 'queued',
 reason text NOT NULL DEFAULT '',
 diff text NOT NULL CHECK(octet_length(diff)<=262144),
 findings jsonb NOT NULL DEFAULT '{}'::jsonb,
 review_id bigint,
 publisher_id bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(reviewer_id,pull_number,base_commit,head_commit,intent)
);
CREATE INDEX golf_reviewer_runs_pending ON golf_reviewer_runs(state,created_at);
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
IF EXISTS(SELECT 1 FROM golf_reviewer_runs) OR EXISTS(SELECT 1 FROM golf_reviewers) THEN
 RAISE EXCEPTION 'Reviewer history prevents downgrade';
END IF;
END $$;
-- +goose StatementEnd
DROP TABLE golf_reviewer_runs;
DROP TABLE golf_reviewers;

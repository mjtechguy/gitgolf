-- +goose Up
-- Immutable native instruction receipt. Bodies remain in the existing private
-- task request; this authority journal stores only identity and a digest.
CREATE TABLE golf_reviewer_comment_commands (
 run_id uuid PRIMARY KEY REFERENCES golf_reviewer_runs(id),
 comment_id bigint NOT NULL CHECK(comment_id>0),
 author_native_id bigint NOT NULL CHECK(author_native_id>0),
 body_sha256 bytea NOT NULL CHECK(octet_length(body_sha256)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER golf_reviewer_comment_commands_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_reviewer_comment_commands FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Agent comment history requires a separately qualified recovery procedure'; END $$;
-- +goose StatementEnd

-- +goose Up
CREATE TABLE golf_user_access (
 user_id bigint PRIMARY KEY REFERENCES golf_users(id) ON DELETE RESTRICT,
 version bigint NOT NULL CHECK(version>0),
 suspended boolean NOT NULL,
 reason text NOT NULL CHECK(octet_length(reason) BETWEEN 1 AND 1024),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE golf_user_access_operations (
 operation_id uuid PRIMARY KEY,
 actor_user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 actor_session_id bigint NOT NULL,
 user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 native_user_id bigint NOT NULL CHECK(native_user_id>0),
 input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32),
 version bigint NOT NULL CHECK(version>0),
 suspended boolean NOT NULL,
 reason text NOT NULL CHECK(octet_length(reason) BETWEEN 1 AND 1024),
 changed_at timestamptz NOT NULL,
 sessions_revoked bigint NOT NULL CHECK(sessions_revoked>=0),
 automation_grants_revoked bigint NOT NULL CHECK(automation_grants_revoked>=0),
 UNIQUE(user_id,version)
);
CREATE TRIGGER golf_user_access_operations_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_user_access_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_user_access_operations) THEN RAISE EXCEPTION 'Preserve Golf user access history before downgrade'; END IF;
END $$;
-- +goose StatementEnd
DROP TABLE golf_user_access_operations;
DROP TABLE golf_user_access;

-- +goose Up
-- Public session handles are identifiers, never authentication credentials.
-- Adding the identity column assigns existing PAT/OAuth rows a handle without
-- changing their cookie hashes, encrypted credentials or absolute expiry.
ALTER TABLE golf_sessions ADD COLUMN session_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL UNIQUE;
CREATE INDEX golf_sessions_user_created ON golf_sessions (user_id, created_at DESC, session_id DESC);

-- +goose Down
DROP INDEX golf_sessions_user_created;
ALTER TABLE golf_sessions DROP COLUMN session_id;

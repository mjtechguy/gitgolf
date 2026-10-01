-- +goose Up
CREATE TABLE golf_users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    forge_url text NOT NULL,
    forge_user_id bigint NOT NULL,
    login text NOT NULL,
    full_name text NOT NULL DEFAULT '',
    avatar_url text NOT NULL DEFAULT '',
    UNIQUE (forge_url, forge_user_id)
);
CREATE TABLE golf_sessions (
    token_hash bytea PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE CASCADE,
    encrypted_token bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX golf_sessions_expiry ON golf_sessions (expires_at);

-- +goose Down
DROP TABLE golf_sessions;
DROP TABLE golf_users;

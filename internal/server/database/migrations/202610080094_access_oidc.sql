-- +goose Up
CREATE TABLE golf_access_oidc_codes (
 token_hash bytea PRIMARY KEY CHECK(octet_length(token_hash)=32),
 session_hash bytea NOT NULL CHECK(octet_length(session_hash)=32),
 native_actor_id bigint NOT NULL CHECK(native_actor_id>0),
 configuration_hash text NOT NULL CHECK(configuration_hash ~ '^[a-f0-9]{64}$'),
 challenge text NOT NULL CHECK(length(challenge)=43),
 nonce text NOT NULL CHECK(length(nonce)<=512),
 expires_at timestamptz NOT NULL
);
CREATE INDEX golf_access_oidc_code_expiry ON golf_access_oidc_codes(expires_at);
-- +goose Down
DROP TABLE golf_access_oidc_codes;

-- +goose Up
-- Separate immutable grant keeps every existing API credential read-only.
CREATE TABLE golf_api_write_grants (
  credential_id bigint PRIMARY KEY REFERENCES golf_api_credentials(id) ON DELETE RESTRICT,
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  repository_owner text NOT NULL CHECK (octet_length(repository_owner) BETWEEN 1 AND 100),
  repository_name text NOT NULL CHECK (octet_length(repository_name) BETWEEN 1 AND 100),
  scopes text NOT NULL CHECK (scopes IN ('issues:write','pulls:write','issues:write,pulls:write'))
);
CREATE TRIGGER golf_api_write_grants_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_api_write_grants
FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
DROP TABLE golf_api_write_grants;

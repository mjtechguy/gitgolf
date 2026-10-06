-- +goose Up
-- Existing immutable grants and read-only tokens retain their original permissions.
ALTER TABLE golf_api_write_grants DROP CONSTRAINT golf_api_write_grants_scopes_check;
ALTER TABLE golf_api_write_grants ADD CONSTRAINT golf_api_write_grants_scopes_check
 CHECK (scopes ~ '^(actions:read,)?(agents:read,)?(issues:write,)?(pulls:write,)?source:write$'
 OR scopes ~ '^(actions:read,)?(agents:read,)?(issues:write,)?pulls:write$'
 OR scopes ~ '^(actions:read,)?(agents:read,)?issues:write$'
 OR scopes ~ '^(actions:read,)?agents:read$'
 OR scopes = 'actions:read');
-- Application admission also requires unique sorted scopes; immutable rows cannot expand.
-- +goose Down
-- Refuse removal while credentials may rely on the new reviewed permissions.
SELECT 1 / 0;

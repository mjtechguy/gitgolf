-- +goose Up
CREATE TABLE golf_cloudflare_resource_operations (
 id uuid PRIMARY KEY, forge_url text NOT NULL,
 user_id bigint NOT NULL REFERENCES golf_users(id), native_actor_id bigint NOT NULL CHECK(native_actor_id>0),
 repository_id bigint NOT NULL CHECK(repository_id>0), owner_id bigint NOT NULL CHECK(owner_id>0),
 environment_id uuid NOT NULL, environment_version bigint NOT NULL CHECK(environment_version>0),
 connection_id uuid NOT NULL, connection_version bigint NOT NULL CHECK(connection_version>0),
 input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32), receipt bytea NOT NULL CHECK(octet_length(receipt) BETWEEN 1 AND 16384),
 state text NOT NULL CHECK(state IN ('PREFLIGHT','PROVISIONING','READY','REFUSED','UNKNOWN','REMOVING','REMOVED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(forge_url,environment_id,environment_version) REFERENCES golf_repository_environment_versions(forge_url,environment_id,version),
 FOREIGN KEY(connection_id,connection_version) REFERENCES golf_infrastructure_connection_versions(profile_id,version)
);
-- Unknown operations retain the allocation fence. A retry never allocates a
-- replacement pair until the original exact resources have been removed.
CREATE UNIQUE INDEX golf_cloudflare_resource_environment ON golf_cloudflare_resource_operations(forge_url,environment_id) WHERE state NOT IN ('REFUSED','REMOVED');
CREATE TABLE golf_cloudflare_resource_events (
 operation_id uuid NOT NULL REFERENCES golf_cloudflare_resource_operations(id),
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 state text NOT NULL, receipt bytea NOT NULL CHECK(octet_length(receipt) BETWEEN 1 AND 16384),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER golf_cloudflare_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_cloudflare_resource_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_cloudflare_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR NEW.id<>OLD.id OR NEW.forge_url<>OLD.forge_url OR NEW.user_id<>OLD.user_id OR NEW.native_actor_id<>OLD.native_actor_id OR NEW.repository_id<>OLD.repository_id OR NEW.owner_id<>OLD.owner_id OR NEW.environment_id<>OLD.environment_id OR NEW.environment_version<>OLD.environment_version OR NEW.connection_id<>OLD.connection_id OR NEW.connection_version<>OLD.connection_version OR NEW.input_hash<>OLD.input_hash OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'Cloudflare resource ownership is immutable';
 END IF;
 IF OLD.state IN ('REMOVED','REFUSED') THEN RAISE EXCEPTION 'Cloudflare resource operation is terminal'; END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_cloudflare_operation_immutable BEFORE UPDATE OR DELETE ON golf_cloudflare_resource_operations FOR EACH ROW EXECUTE FUNCTION golf_cloudflare_operation_immutable();
CREATE TRIGGER golf_cloudflare_operations_no_truncate BEFORE TRUNCATE ON golf_cloudflare_resource_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_cloudflare_resource_operations) THEN RAISE EXCEPTION 'Preserve Cloudflare resource ownership and operation history before downgrade'; END IF;
END; $$;
-- +goose StatementEnd
DROP TABLE golf_cloudflare_resource_events;
DROP TABLE golf_cloudflare_resource_operations;
DROP FUNCTION golf_cloudflare_operation_immutable();

-- +goose Up
-- Metadata-only, private original intents. Native direct roles are not inferred.
CREATE TABLE golf_repository_access_operations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id),forge_url text NOT NULL,
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
 repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL,repository_name text NOT NULL,actor_id bigint NOT NULL CHECK(actor_id>0),
 recipient_id bigint NOT NULL CHECK(recipient_id>0),recipient_login text NOT NULL,
 access_revision text NOT NULL CHECK(access_revision ~ '^[a-f0-9]{64}$'),
 recipient_revision text NOT NULL CHECK(recipient_revision ~ '^[a-f0-9]{64}$'),
 requested_permission text NOT NULL CHECK(requested_permission IN ('','read','write','admin')),
 remove boolean NOT NULL,CHECK(remove=(requested_permission='')),
 generation bigint NOT NULL CHECK(generation>0),input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 observed_permission text NOT NULL DEFAULT '' CHECK(observed_permission IN ('','none','read','write','admin','owner')),
 observed_direct boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,idempotency_key),UNIQUE(forge_url,repository_id,recipient_id,generation),
 CHECK(actor_id<>recipient_id AND owner_id<>recipient_id),
 CHECK((phase='REJECTED')=(failure_code='preflight_refused')),
 CHECK((phase='SUCCEEDED')=(observed_permission<>'')),
 CHECK(phase<>'SUCCEEDED' OR observed_direct<>remove)
);
CREATE UNIQUE INDEX golf_repository_access_unresolved ON golf_repository_access_operations(forge_url,repository_id,recipient_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_repository_access_generations (
 forge_url text NOT NULL,repository_id bigint NOT NULL CHECK(repository_id>0),recipient_id bigint NOT NULL CHECK(recipient_id>0),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 direct_operation_id bigint REFERENCES golf_repository_access_operations(id),
 invitation_operation_id bigint REFERENCES golf_repository_invitation_operations(id),
 PRIMARY KEY(forge_url,repository_id,recipient_id),CHECK(NOT(direct_operation_id IS NOT NULL AND invitation_operation_id IS NOT NULL))
);
CREATE TABLE golf_repository_access_operation_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,operation_id bigint NOT NULL REFERENCES golf_repository_access_operations(id),
 phase text NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(operation_id,phase)
);
CREATE TRIGGER golf_repository_access_operations_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_access_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_repository_access_generations_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_access_generations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_repository_access_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_access_operation_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_repository_access_lock(f text,r bigint,u bigint) RETURNS void LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtextextended(f||'/repository-access/'||r::text||'/'||u::text,0)); $$;
CREATE FUNCTION golf_repository_access_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM golf_repository_lifecycle_lock(NEW.forge_url,NEW.repository_id,false);
 PERFORM golf_repository_access_lock(NEW.forge_url,NEW.repository_id,NEW.recipient_id);
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) OR golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) THEN RAISE EXCEPTION 'Access reservation unavailable' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','observed_permission','observed_direct','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','observed_permission','observed_direct','updated_at']) OR
   NOT(OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') THEN RAISE EXCEPTION 'Access intent immutable'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_repository_access_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d golf_repository_access_operations;i golf_repository_invitation_operations;v golf_repository_invitations;
BEGIN
 PERFORM golf_repository_lifecycle_lock(NEW.forge_url,NEW.repository_id,false);
 PERFORM golf_repository_access_lock(NEW.forge_url,NEW.repository_id,NEW.recipient_id);
 IF TG_OP='INSERT' THEN
  IF NEW.generation<>0 OR NEW.direct_operation_id IS NOT NULL OR NEW.invitation_operation_id IS NOT NULL THEN RAISE EXCEPTION 'Access slot must start empty'; END IF;
 ELSE
  IF (NEW.forge_url,NEW.repository_id,NEW.recipient_id) IS DISTINCT FROM (OLD.forge_url,OLD.repository_id,OLD.recipient_id) OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1 THEN RAISE EXCEPTION 'Access slot identity/generation immutable'; END IF;
  IF OLD.direct_operation_id IS NOT NULL THEN SELECT * INTO d FROM golf_repository_access_operations WHERE id=OLD.direct_operation_id; IF d.phase IN ('RESERVED','DISPATCH_UNKNOWN') THEN RAISE EXCEPTION 'Original access intent unresolved' USING ERRCODE='55000'; END IF; END IF;
  IF OLD.invitation_operation_id IS NOT NULL THEN SELECT * INTO i FROM golf_repository_invitation_operations WHERE id=OLD.invitation_operation_id; IF i.phase IN ('RESERVED','DISPATCH_UNKNOWN') THEN RAISE EXCEPTION 'Original invitation grant unresolved' USING ERRCODE='55000'; END IF; END IF;
  IF NEW.direct_operation_id IS NOT NULL THEN
   SELECT * INTO d FROM golf_repository_access_operations WHERE id=NEW.direct_operation_id;
   IF d.id IS NULL OR d.forge_url<>NEW.forge_url OR d.repository_id<>NEW.repository_id OR d.recipient_id<>NEW.recipient_id OR d.generation<>NEW.generation OR d.phase<>'RESERVED' OR NEW.generation<>OLD.generation+1 THEN RAISE EXCEPTION 'Access slot does not bind reservation'; END IF;
  ELSIF NEW.invitation_operation_id IS NOT NULL THEN
   SELECT * INTO i FROM golf_repository_invitation_operations WHERE id=NEW.invitation_operation_id;SELECT * INTO v FROM golf_repository_invitations WHERE id=i.invitation_id;
   IF i.id IS NULL OR v.forge_url<>NEW.forge_url OR v.repository_id<>NEW.repository_id OR v.recipient_native_id<>NEW.recipient_id OR i.phase<>'RESERVED' OR i.decision<>'ACCEPT' OR NEW.generation<>OLD.generation+1 THEN RAISE EXCEPTION 'Access slot does not bind invitation'; END IF;
  ELSIF NEW.generation<>OLD.generation THEN RAISE EXCEPTION 'Access generation has no original intent'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_repository_access_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO golf_repository_access_operation_events(operation_id,phase) VALUES(NEW.id,NEW.phase);RETURN NEW;END; $$;
CREATE TRIGGER golf_repository_access_operation_guard BEFORE INSERT OR UPDATE ON golf_repository_access_operations FOR EACH ROW EXECUTE FUNCTION golf_repository_access_operation_guard();
CREATE TRIGGER golf_repository_access_generation_guard BEFORE INSERT OR UPDATE ON golf_repository_access_generations FOR EACH ROW EXECUTE FUNCTION golf_repository_access_generation_guard();
CREATE TRIGGER golf_repository_access_event AFTER INSERT OR UPDATE ON golf_repository_access_operations FOR EACH ROW EXECUTE FUNCTION golf_repository_access_event();
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_access;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_access(f,r)+(SELECT count(*) FROM golf_repository_access_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
-- +goose Down
DO $$ BEGIN IF EXISTS(SELECT 1 FROM golf_repository_access_generations) THEN RAISE EXCEPTION 'Preserve retained access generations/intents before downgrade'; END IF; END $$;
DROP FUNCTION golf_repository_lifecycle_active(text,bigint);
ALTER FUNCTION golf_repository_lifecycle_active_before_access(text,bigint) RENAME TO golf_repository_lifecycle_active;
DROP TABLE golf_repository_access_operation_events,golf_repository_access_generations,golf_repository_access_operations;
DROP FUNCTION golf_repository_access_lock(text,bigint,bigint),golf_repository_access_operation_guard(),golf_repository_access_generation_guard(),golf_repository_access_event();

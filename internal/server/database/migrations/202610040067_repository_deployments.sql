-- +goose Up
-- Static bytes remain in their original retained artifact store. No worker grant.
CREATE TABLE golf_repository_deployments (
 id uuid PRIMARY KEY, forge_url text NOT NULL, repository_id bigint NOT NULL CHECK(repository_id>0), owner_id bigint NOT NULL CHECK(owner_id>0),
 user_id bigint NOT NULL REFERENCES golf_users(id), native_actor_id bigint NOT NULL CHECK(native_actor_id>0), session_hash bytea NOT NULL CHECK(octet_length(session_hash)=32),
 run_id uuid NOT NULL REFERENCES golf_workflow_runs(id), attempt_id text NOT NULL, archive_sha256 text NOT NULL CHECK(archive_sha256 ~ '^[a-f0-9]{64}$'),
 environment_id uuid NOT NULL, environment_version bigint NOT NULL CHECK(environment_version>0), input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32),
 receipt bytea NOT NULL CHECK(octet_length(receipt) BETWEEN 1 AND 65536),
 state text NOT NULL CHECK(state IN ('REQUESTED','WAITING','READY','REVOKED','EXPIRED')), version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz,
 FOREIGN KEY(forge_url,environment_id,environment_version) REFERENCES golf_repository_environment_versions(forge_url,environment_id,version),
 CHECK(updated_at>=created_at),
 CHECK((state IN ('REQUESTED','WAITING') AND expires_at IS NULL) OR (state IN ('READY','EXPIRED') AND expires_at IS NOT NULL AND expires_at>created_at) OR state='REVOKED')
);
CREATE INDEX golf_deployment_inventory ON golf_repository_deployments(forge_url,repository_id,owner_id,created_at DESC,id);
CREATE TABLE golf_deployment_reviews (
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 deployment_id uuid NOT NULL REFERENCES golf_repository_deployments(id), user_id bigint NOT NULL REFERENCES golf_users(id), operation_id uuid NOT NULL,
 native_actor_id bigint NOT NULL CHECK(native_actor_id>0), session_hash bytea NOT NULL CHECK(octet_length(session_hash)=32), approved boolean NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(user_id,operation_id)
);
CREATE INDEX golf_deployment_latest_review ON golf_deployment_reviews(deployment_id,native_actor_id,sequence DESC);
CREATE TABLE golf_deployment_events (
 deployment_id uuid NOT NULL REFERENCES golf_repository_deployments(id), version bigint NOT NULL, state text NOT NULL,
 actor_id bigint REFERENCES golf_users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(deployment_id,version)
);
CREATE TABLE golf_preview_credentials (
 token_hash bytea PRIMARY KEY CHECK(octet_length(token_hash)=32), deployment_id uuid NOT NULL REFERENCES golf_repository_deployments(id),
 user_id bigint NOT NULL REFERENCES golf_users(id), native_actor_id bigint NOT NULL CHECK(native_actor_id>0), parent_session_hash bytea NOT NULL CHECK(octet_length(parent_session_hash)=32),
 kind text NOT NULL CHECK(kind IN ('launch','viewer')), expires_at timestamptz NOT NULL
);
CREATE INDEX golf_preview_expiry ON golf_preview_credentials(expires_at);
CREATE TRIGGER golf_deployment_reviews_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_deployment_reviews FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_deployment_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_deployment_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_deployments_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_deployments FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_deployment_lock(f text,r bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_repository_lifecycle_lock(f,r,false);
 PERFORM golf_repository_environment_lock(f,r);
END; $$;
CREATE FUNCTION golf_deployment_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_deployment_lock(NEW.forge_url,NEW.repository_id);
 IF TG_OP='INSERT' THEN
  IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) OR NEW.state<>'REQUESTED' OR NEW.version<>1 THEN RAISE EXCEPTION 'Deployment admission unavailable' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.native_actor_id) OR NOT EXISTS(SELECT 1 FROM golf_workflow_artifacts a JOIN golf_workflow_runs r ON r.id=a.run_id WHERE a.run_id=NEW.run_id AND a.attempt_id=NEW.attempt_id AND a.archive_sha256=NEW.archive_sha256 AND a.forge_url=NEW.forge_url AND a.repository_id=NEW.repository_id AND a.owner_id=NEW.owner_id AND r.state='succeeded') THEN RAISE EXCEPTION 'Deployment artifact or actor mismatch'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','version','updated_at','expires_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','updated_at','expires_at']) OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at OR OLD.state IN ('REVOKED','EXPIRED') OR (OLD.state='READY' AND NEW.state NOT IN ('REVOKED','EXPIRED')) THEN RAISE EXCEPTION 'Deployment identity or terminal state immutable'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_deployment_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d golf_repository_deployments;
BEGIN
 SELECT * INTO d FROM golf_repository_deployments WHERE id=NEW.deployment_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing deployment'; END IF;
 PERFORM golf_deployment_lock(d.forge_url,d.repository_id);
 SELECT * INTO d FROM golf_repository_deployments WHERE id=NEW.deployment_id;
 IF d.state IN ('REVOKED','EXPIRED') OR NEW.native_actor_id=d.native_actor_id OR NOT EXISTS(SELECT 1 FROM golf_sessions s JOIN golf_users u ON u.id=s.user_id WHERE s.token_hash=NEW.session_hash AND s.user_id=NEW.user_id AND u.forge_url=d.forge_url AND u.forge_user_id=NEW.native_actor_id AND s.expires_at>=NEW.expires_at AND s.expires_at>clock_timestamp() AND (s.local_account_id IS NULL OR EXISTS(SELECT 1 FROM golf_local_accounts a WHERE a.id=s.local_account_id AND a.user_id=s.user_id AND a.credential_version=s.local_credential_version AND a.disabled_at IS NULL))) THEN RAISE EXCEPTION 'Review authority mismatch'; END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_deployment_event_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM golf_deployment_events WHERE deployment_id=NEW.id AND version=NEW.version AND state=NEW.state) THEN RAISE EXCEPTION 'Deployment event missing'; END IF; RETURN NULL;
END; $$;
CREATE FUNCTION golf_deployment_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d golf_repository_deployments;
BEGIN
 SELECT * INTO STRICT d FROM golf_repository_deployments WHERE id=NEW.deployment_id;
 -- Only a committed invalidation: private receipts and reviewer decisions stay
 -- behind current-authorized deployment reads, never in the live payload.
 PERFORM golf_append_repository_activity(d.forge_url,d.repository_id,0,'actions');
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_deployment_event_activity AFTER INSERT ON golf_deployment_events FOR EACH ROW EXECUTE FUNCTION golf_deployment_activity();
CREATE TRIGGER golf_deployment_review_activity AFTER INSERT ON golf_deployment_reviews FOR EACH ROW EXECUTE FUNCTION golf_deployment_activity();
CREATE TRIGGER golf_deployment_review_guard BEFORE INSERT ON golf_deployment_reviews FOR EACH ROW EXECUTE FUNCTION golf_deployment_review_guard();
CREATE TRIGGER golf_deployment_guard BEFORE INSERT OR UPDATE ON golf_repository_deployments FOR EACH ROW EXECUTE FUNCTION golf_deployment_guard();
CREATE CONSTRAINT TRIGGER golf_deployment_event_complete AFTER INSERT OR UPDATE ON golf_repository_deployments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION golf_deployment_event_complete();
-- Active previews fence Golf archive/transfer/deletion. Terminal revocation remains possible.
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_deployments;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_deployments(f,r)+(SELECT count(*) FROM golf_repository_deployments WHERE forge_url=f AND repository_id=r AND state IN ('REQUESTED','WAITING','READY') AND (expires_at IS NULL OR expires_at>clock_timestamp())); $$;
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained deployments require qualified offline recovery'; END $$;
-- +goose StatementEnd

-- +goose Up
ALTER TABLE golf_workflow_runs ALTER COLUMN session_hash DROP NOT NULL;
ALTER TABLE golf_workflow_runs ADD COLUMN origin text NOT NULL DEFAULT 'manual';
ALTER TABLE golf_workflow_runs ADD COLUMN automation_grant_id uuid REFERENCES golf_automation_grants(id) ON DELETE RESTRICT;
ALTER TABLE golf_workflow_runs ADD COLUMN automation_grant_revision bigint;
ALTER TABLE golf_workflow_runs ADD COLUMN automation_grant_epoch bigint;
ALTER TABLE golf_workflow_runs ADD COLUMN automation_credential_version bigint;
ALTER TABLE golf_workflow_runs ADD COLUMN repository_event_id bigint REFERENCES golf_repository_events(id) ON DELETE RESTRICT;
ALTER TABLE golf_workflow_runs ADD COLUMN event_ref text NOT NULL DEFAULT '';
ALTER TABLE golf_workflow_runs ADD CONSTRAINT golf_workflow_runs_origin_check CHECK (
 (origin='manual' AND session_hash IS NOT NULL AND automation_grant_id IS NULL AND automation_grant_revision IS NULL AND automation_grant_epoch IS NULL AND automation_credential_version IS NULL AND repository_event_id IS NULL AND event_ref='') OR
 (origin='push' AND session_hash IS NULL AND automation_grant_id IS NOT NULL AND automation_grant_revision IS NOT NULL AND automation_grant_revision>0 AND automation_grant_epoch IS NOT NULL AND automation_grant_epoch>0 AND automation_credential_version IS NOT NULL AND automation_credential_version>0 AND repository_event_id IS NOT NULL AND event_ref LIKE 'refs/heads/%')
);
ALTER TABLE golf_workflow_runs DROP CONSTRAINT golf_workflow_runs_forge_url_user_id_idempotency_key_key;
ALTER TABLE golf_workflow_runs ADD UNIQUE(forge_url,user_id,origin,idempotency_key);
-- An updated grant cannot replay an already admitted event/path.
CREATE UNIQUE INDEX golf_workflow_runs_event_grant_path ON golf_workflow_runs(repository_event_id,automation_grant_id,workflow_path) WHERE origin='push';
-- +goose StatementBegin
CREATE FUNCTION golf_workflow_run_origin_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.origin,NEW.automation_grant_id,NEW.automation_grant_revision,NEW.automation_grant_epoch,NEW.automation_credential_version,NEW.repository_event_id,NEW.event_ref,NEW.session_hash,NEW.user_id,NEW.forge_url,NEW.repository_id,NEW.owner_id,NEW.repository_owner,NEW.repository_name,NEW.organization_owned,NEW.commit_id,NEW.workflow_path)
   IS DISTINCT FROM ROW(OLD.origin,OLD.automation_grant_id,OLD.automation_grant_revision,OLD.automation_grant_epoch,OLD.automation_credential_version,OLD.repository_event_id,OLD.event_ref,OLD.session_hash,OLD.user_id,OLD.forge_url,OLD.repository_id,OLD.owner_id,OLD.repository_owner,OLD.repository_name,OLD.organization_owned,OLD.commit_id,OLD.workflow_path) THEN
   RAISE EXCEPTION 'Workflow authority origin is immutable';
  END IF;
 ELSIF NEW.origin='push' AND NOT EXISTS (
  SELECT 1 FROM golf_automation_grants g JOIN golf_automation_credentials c ON c.grant_id=g.id
   JOIN golf_repository_events e ON e.id=NEW.repository_event_id
   JOIN golf_repository_event_connections b ON b.id=e.connection_id
  WHERE g.id=NEW.automation_grant_id AND g.enabled AND g.expires_at>clock_timestamp()
   AND g.revision=NEW.automation_grant_revision AND g.revocation_epoch=NEW.automation_grant_epoch AND c.version=NEW.automation_credential_version
   AND g.forge_url=NEW.forge_url AND g.repository_id=NEW.repository_id AND g.owner_id=NEW.owner_id
   AND g.repository_owner=NEW.repository_owner AND g.repository_name=NEW.repository_name AND g.organization_owned=NEW.organization_owned
   AND g.sponsor_user_id=NEW.user_id AND b.forge_url=g.forge_url AND b.repository_id=g.repository_id AND b.owner_id=g.owner_id
   AND b.repository=g.repository_owner||'/'||g.repository_name AND e.received_at>=g.created_at
   AND e.ref=NEW.event_ref AND e.after_commit_id=NEW.commit_id AND NEW.commit_id !~ '^0+$'
   AND g.branches ? substr(NEW.event_ref,12) AND g.workflow_paths ? NEW.workflow_path
 ) THEN
  RAISE EXCEPTION 'Workflow automation origin does not match grant and event';
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_workflow_run_origin_binding BEFORE INSERT OR UPDATE ON golf_workflow_runs FOR EACH ROW EXECUTE FUNCTION golf_workflow_run_origin_binding();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_workflow_runs WHERE origin='push') THEN RAISE EXCEPTION 'Preserve automatic workflow history before downgrade'; END IF;
END $$;
-- +goose StatementEnd
DROP TRIGGER golf_workflow_run_origin_binding ON golf_workflow_runs;
DROP FUNCTION golf_workflow_run_origin_binding();
DROP INDEX golf_workflow_runs_event_grant_path;
ALTER TABLE golf_workflow_runs DROP CONSTRAINT golf_workflow_runs_forge_url_user_id_origin_idempotency_key_key;
ALTER TABLE golf_workflow_runs ADD UNIQUE(forge_url,user_id,idempotency_key);
ALTER TABLE golf_workflow_runs DROP CONSTRAINT golf_workflow_runs_origin_check;
ALTER TABLE golf_workflow_runs DROP COLUMN origin, DROP COLUMN automation_grant_id, DROP COLUMN automation_grant_revision, DROP COLUMN automation_grant_epoch, DROP COLUMN automation_credential_version, DROP COLUMN repository_event_id, DROP COLUMN event_ref;
ALTER TABLE golf_workflow_runs ALTER COLUMN session_hash SET NOT NULL;

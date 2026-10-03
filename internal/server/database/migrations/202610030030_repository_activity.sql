-- +goose Up
-- Private invalidations only. Payloads, prompts, tokens and native log text are
-- read through their existing authority-checked APIs, never copied here.
CREATE TABLE golf_repository_activity (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 forge_url text NOT NULL,
 repository_id bigint NOT NULL CHECK(repository_id>0),
 recipient_user_id bigint NOT NULL DEFAULT 0 CHECK(recipient_user_id>=0),
 topic text NOT NULL CHECK(topic IN ('source','issues','pulls','actions','agents')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX golf_repository_activity_scope ON golf_repository_activity(forge_url,repository_id,id);
-- +goose StatementBegin
CREATE FUNCTION golf_append_repository_activity(forge text,repo bigint,recipient bigint,topic text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 -- Identity sequences alone are not commit ordered. Acquire the repository's
 -- transaction lock BEFORE assigning an ID; a second same-repo writer cannot
 -- commit a later cursor ahead of an earlier uncommitted change.
 PERFORM pg_advisory_xact_lock(hashtextextended('golf-live:'||forge||':'||repo::text,0));
 INSERT INTO golf_repository_activity(forge_url,repository_id,recipient_user_id,topic) VALUES(forge,repo,recipient,topic);
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION golf_record_repository_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding record;
BEGIN
 IF TG_TABLE_NAME='golf_workflow_runs' THEN
  IF TG_OP='INSERT' OR NEW.version IS DISTINCT FROM OLD.version OR NEW.log_sequence IS DISTINCT FROM OLD.log_sequence THEN
   PERFORM golf_append_repository_activity(NEW.forge_url,NEW.repository_id,0,'actions');
  END IF;
 ELSIF TG_TABLE_NAME='golf_agent_tasks' THEN
  IF TG_OP='INSERT' OR NEW.version IS DISTINCT FROM OLD.version THEN
   PERFORM golf_append_repository_activity(NEW.forge_url,NEW.repository_id,NEW.user_id,'agents');
  END IF;
 ELSIF TG_TABLE_NAME='golf_repository_events' THEN
  SELECT forge_url,repository_id INTO binding FROM golf_repository_event_connections WHERE id=NEW.connection_id;
  PERFORM golf_append_repository_activity(binding.forge_url,binding.repository_id,0,'source');
 ELSIF TG_TABLE_NAME='golf_issue_mutations' THEN
  IF TG_OP='UPDATE' AND NEW.state IS DISTINCT FROM OLD.state AND NEW.state='SUCCEEDED' THEN
   SELECT forge_url INTO binding FROM golf_users WHERE id=NEW.user_id;
   PERFORM golf_append_repository_activity(binding.forge_url,NEW.repository_id,0,CASE WHEN NEW.pull_request THEN 'pulls' ELSE 'issues' END);
  END IF;
 ELSIF TG_TABLE_NAME='golf_reviewer_runs' THEN
  IF TG_OP='INSERT' OR NEW.state IS DISTINCT FROM OLD.state OR NEW.review_id IS DISTINCT FROM OLD.review_id THEN
   SELECT forge_url,repository_id INTO binding FROM golf_reviewers WHERE id=NEW.reviewer_id;
   PERFORM golf_append_repository_activity(binding.forge_url,binding.repository_id,0,'pulls');
  END IF;
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_workflow_activity AFTER INSERT OR UPDATE ON golf_workflow_runs FOR EACH ROW EXECUTE FUNCTION golf_record_repository_activity();
CREATE TRIGGER golf_agent_activity AFTER INSERT OR UPDATE ON golf_agent_tasks FOR EACH ROW EXECUTE FUNCTION golf_record_repository_activity();
CREATE TRIGGER golf_source_activity AFTER INSERT ON golf_repository_events FOR EACH ROW EXECUTE FUNCTION golf_record_repository_activity();
CREATE TRIGGER golf_issue_activity AFTER UPDATE ON golf_issue_mutations FOR EACH ROW EXECUTE FUNCTION golf_record_repository_activity();
CREATE TRIGGER golf_review_activity AFTER INSERT OR UPDATE ON golf_reviewer_runs FOR EACH ROW EXECUTE FUNCTION golf_record_repository_activity();
CREATE TRIGGER golf_repository_activity_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_activity FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN IF EXISTS(SELECT 1 FROM golf_repository_activity) THEN RAISE EXCEPTION 'Preserve repository activity before explicit downgrade'; END IF; END $$;
-- +goose StatementEnd
DROP TRIGGER golf_workflow_activity ON golf_workflow_runs;
DROP TRIGGER golf_agent_activity ON golf_agent_tasks;
DROP TRIGGER golf_source_activity ON golf_repository_events;
DROP TRIGGER golf_issue_activity ON golf_issue_mutations;
DROP TRIGGER golf_review_activity ON golf_reviewer_runs;
DROP FUNCTION golf_record_repository_activity();
DROP FUNCTION golf_append_repository_activity(text,bigint,bigint,text);
DROP TABLE golf_repository_activity;

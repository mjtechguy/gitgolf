-- +goose Up
ALTER TABLE golf_workflow_runs ADD COLUMN engine_catalog text NOT NULL DEFAULT 'golf.workflow.shell.v1';
ALTER TABLE golf_workflow_runs ADD CONSTRAINT golf_workflow_engine_catalog CHECK
 (engine_catalog IN ('golf.workflow.shell.v1','golf.workflow.act.v0.2.89.linux.v1'));
CREATE TABLE golf_workflow_job_inventory (
 run_id uuid NOT NULL REFERENCES golf_workflow_runs(id) ON DELETE RESTRICT,
 instance_id text NOT NULL CHECK(instance_id ~ '^[a-f0-9]{32}$'),
 job_id text NOT NULL CHECK(job_id ~ '^[A-Za-z_][A-Za-z0-9_-]{0,63}$'),
 name text NOT NULL CHECK(octet_length(name) BETWEEN 1 AND 255),
 image_digest text NOT NULL,
 matrix jsonb NOT NULL CHECK(jsonb_typeof(matrix)='array' AND jsonb_array_length(matrix)<=8),
 needs jsonb NOT NULL CHECK(jsonb_typeof(needs)='array' AND jsonb_array_length(needs)<=8),
 steps jsonb NOT NULL CHECK(jsonb_typeof(steps)='array' AND jsonb_array_length(steps) BETWEEN 1 AND 32),
 PRIMARY KEY(run_id,instance_id)
);
CREATE TABLE golf_workflow_graph_events (
 run_id uuid NOT NULL REFERENCES golf_workflow_runs(id) ON DELETE RESTRICT,
 attempt_id text NOT NULL CHECK(attempt_id ~ '^[a-f0-9]{32}$'),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 512),
 instance_id text NOT NULL,
 step_id text NOT NULL DEFAULT '',
 kind text NOT NULL CHECK(kind IN ('job_started','job_finished','step_started','step_finished','complete')),
 state text NOT NULL DEFAULT '' CHECK(state IN ('','success','failure','skipped')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,sequence)
);
ALTER TABLE golf_workflow_run_logs ADD COLUMN job_instance_id text NOT NULL DEFAULT '';
ALTER TABLE golf_workflow_run_logs ADD COLUMN engine_step_id text NOT NULL DEFAULT '';
CREATE INDEX golf_workflow_graph_logs ON golf_workflow_run_logs(run_id,job_instance_id,engine_step_id,sequence);
-- +goose StatementBegin
CREATE FUNCTION golf_workflow_initialize_graph() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
 IF NEW.engine_catalog='golf.workflow.act.v0.2.89.linux.v1' THEN
  IF jsonb_typeof(NEW.plan#>'{Actions,jobs}') IS DISTINCT FROM 'array' OR
     jsonb_array_length(NEW.plan#>'{Actions,jobs}') NOT BETWEEN 1 AND 12 OR
     NEW.plan#>>'{Actions,archiveSha256}' IS DISTINCT FROM NEW.source_sha256 THEN
   RAISE EXCEPTION 'Invalid Actions graph admission';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.plan#>'{Actions,jobs}') LOOP
   INSERT INTO golf_workflow_job_inventory(run_id,instance_id,job_id,name,image_digest,matrix,needs,steps)
   VALUES(NEW.id,item->>'instanceId',item->>'jobId',item->>'name',item->>'image',
    coalesce(nullif(item->'matrix','null'::jsonb),'[]'::jsonb),
    coalesce(nullif(item->'needs','null'::jsonb),'[]'::jsonb),item->'steps');
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_workflow_guard_graph_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.engine_catalog:=coalesce(NEW.plan#>>'{Actions,catalog}','golf.workflow.shell.v1'); RETURN NEW; END IF;
 IF NEW.engine_catalog IS DISTINCT FROM OLD.engine_catalog THEN RAISE EXCEPTION 'Actions catalog is immutable'; END IF;
 IF OLD.engine_catalog='golf.workflow.act.v0.2.89.linux.v1' AND
 (NEW.plan IS DISTINCT FROM OLD.plan OR NEW.commit_id IS DISTINCT FROM OLD.commit_id OR
 NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256 OR NEW.blob_id IS DISTINCT FROM OLD.blob_id OR
 NEW.workflow_path IS DISTINCT FROM OLD.workflow_path OR NEW.repository_id IS DISTINCT FROM OLD.repository_id OR
 NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.forge_url IS DISTINCT FROM OLD.forge_url OR
 NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.origin IS DISTINCT FROM OLD.origin OR
 NEW.event_ref IS DISTINCT FROM OLD.event_ref) THEN RAISE EXCEPTION 'Actions graph binding is immutable'; END IF;
 IF NEW.plan->'Actions' IS DISTINCT FROM OLD.plan->'Actions' THEN RAISE EXCEPTION 'Actions engine identity is immutable'; END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER golf_workflow_graph_inventory AFTER INSERT ON golf_workflow_runs FOR EACH ROW EXECUTE FUNCTION golf_workflow_initialize_graph();
CREATE TRIGGER golf_workflow_graph_binding BEFORE INSERT OR UPDATE ON golf_workflow_runs FOR EACH ROW EXECUTE FUNCTION golf_workflow_guard_graph_binding();
CREATE TRIGGER golf_workflow_job_inventory_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_workflow_job_inventory FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_workflow_graph_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_workflow_graph_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN IF EXISTS(SELECT 1 FROM golf_workflow_job_inventory) OR EXISTS(SELECT 1 FROM golf_workflow_graph_events) THEN RAISE EXCEPTION 'Retain Actions graph evidence before downgrade'; END IF; END $$;
-- +goose StatementEnd
DROP TRIGGER golf_workflow_graph_binding ON golf_workflow_runs;
DROP TRIGGER golf_workflow_graph_inventory ON golf_workflow_runs;
DROP FUNCTION golf_workflow_guard_graph_binding();
DROP FUNCTION golf_workflow_initialize_graph();
DROP TABLE golf_workflow_graph_events;
DROP TABLE golf_workflow_job_inventory;
DROP INDEX golf_workflow_graph_logs;
ALTER TABLE golf_workflow_run_logs DROP COLUMN job_instance_id, DROP COLUMN engine_step_id;
ALTER TABLE golf_workflow_runs DROP COLUMN engine_catalog;

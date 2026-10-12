-- +goose Up
ALTER TABLE golf_workflow_runs DROP CONSTRAINT golf_workflow_engine_catalog;
ALTER TABLE golf_workflow_runs ADD CONSTRAINT golf_workflow_engine_catalog CHECK(engine_catalog IN ('golf.workflow.shell.v1','golf.workflow.act.v0.2.89.linux.v1','golf.workflow.act.v0.2.89.linux.v2','golf.workflow.act.v0.2.89.linux.agents088.v1','golf.workflow.act.v0.2.89.linux.remote-node24.v1'));
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION golf_workflow_initialize_graph() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
 IF NEW.engine_catalog IN ('golf.workflow.act.v0.2.89.linux.v1','golf.workflow.act.v0.2.89.linux.v2','golf.workflow.act.v0.2.89.linux.agents088.v1','golf.workflow.act.v0.2.89.linux.remote-node24.v1') THEN
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
CREATE OR REPLACE FUNCTION golf_workflow_guard_graph_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.engine_catalog:=coalesce(NEW.plan#>>'{Actions,catalog}','golf.workflow.shell.v1'); RETURN NEW; END IF;
 IF NEW.engine_catalog IS DISTINCT FROM OLD.engine_catalog THEN RAISE EXCEPTION 'Actions catalog is immutable'; END IF;
 IF OLD.engine_catalog IN ('golf.workflow.act.v0.2.89.linux.v1','golf.workflow.act.v0.2.89.linux.v2','golf.workflow.act.v0.2.89.linux.agents088.v1','golf.workflow.act.v0.2.89.linux.remote-node24.v1') AND
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
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Preserve immutable remote Actions runs; downgrade requires qualified recovery'; END $$;
-- +goose StatementEnd

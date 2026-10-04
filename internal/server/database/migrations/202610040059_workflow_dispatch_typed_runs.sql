-- +goose Up
ALTER TABLE golf_workflow_runs ADD COLUMN input_contract text NOT NULL DEFAULT '',
 ADD COLUMN input_schema_sha256 text NOT NULL DEFAULT '',
 ADD COLUMN submitted_inputs_sha256 text NOT NULL DEFAULT '',
 ADD COLUMN effective_inputs_sha256 text NOT NULL DEFAULT '';
ALTER TABLE golf_workflow_runs DROP CONSTRAINT golf_workflow_engine_catalog;
ALTER TABLE golf_workflow_runs ADD CONSTRAINT golf_workflow_engine_catalog CHECK
 (engine_catalog IN ('golf.workflow.shell.v1','golf.workflow.act.v0.2.89.linux.v1','golf.workflow.act.v0.2.89.linux.v2'));
ALTER TABLE golf_workflow_runs ADD CONSTRAINT golf_workflow_typed_inputs_all_or_none CHECK
 ((input_contract='' AND input_schema_sha256='' AND submitted_inputs_sha256='' AND effective_inputs_sha256='' AND engine_catalog<>'golf.workflow.act.v0.2.89.linux.v2') OR
  (input_contract='golf.workflow.dispatch.inputs.v1' AND input_schema_sha256 ~ '^[a-f0-9]{64}$' AND submitted_inputs_sha256 ~ '^[a-f0-9]{64}$' AND effective_inputs_sha256 ~ '^[a-f0-9]{64}$' AND origin='manual' AND engine_catalog='golf.workflow.act.v0.2.89.linux.v2' AND format=1));
-- No legacy run backfill/adoption. A prior unsupported encrypted row must not be
-- silently bound to newly manufactured run metadata.
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_workflow_dispatch_inputs) THEN RAISE EXCEPTION 'Existing workflow inputs require coordinated typed-run recovery; no legacy adoption'; END IF;
END $$;
CREATE OR REPLACE FUNCTION golf_workflow_initialize_graph() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
 IF NEW.engine_catalog IN ('golf.workflow.act.v0.2.89.linux.v1','golf.workflow.act.v0.2.89.linux.v2') THEN
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
 IF OLD.engine_catalog IN ('golf.workflow.act.v0.2.89.linux.v1','golf.workflow.act.v0.2.89.linux.v2') AND
 (NEW.plan IS DISTINCT FROM OLD.plan OR NEW.commit_id IS DISTINCT FROM OLD.commit_id OR
 NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256 OR NEW.blob_id IS DISTINCT FROM OLD.blob_id OR
 NEW.workflow_path IS DISTINCT FROM OLD.workflow_path OR NEW.repository_id IS DISTINCT FROM OLD.repository_id OR
 NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.forge_url IS DISTINCT FROM OLD.forge_url OR
 NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.origin IS DISTINCT FROM OLD.origin OR
 NEW.event_ref IS DISTINCT FROM OLD.event_ref) THEN RAISE EXCEPTION 'Actions graph binding is immutable'; END IF;
 IF NEW.plan->'Actions' IS DISTINCT FROM OLD.plan->'Actions' THEN RAISE EXCEPTION 'Actions engine identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION golf_workflow_dispatch_input_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'encrypted_content'-'credential_key_id') IS DISTINCT FROM (to_jsonb(OLD)-'encrypted_content'-'credential_key_id') THEN RAISE EXCEPTION 'Immutable workflow dispatch input identity'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM golf_workflow_runs r WHERE r.id=NEW.run_id AND r.origin='manual' AND r.forge_url=NEW.forge_url AND r.user_id=NEW.user_id AND r.repository_id=NEW.repository_id AND r.owner_id=NEW.owner_id AND r.idempotency_key=NEW.idempotency_key AND r.commit_id=NEW.commit_id AND r.workflow_path=NEW.workflow_path AND r.blob_id=NEW.blob_id AND r.source_sha256=NEW.source_sha256 AND r.input_contract='golf.workflow.dispatch.inputs.v1' AND r.engine_catalog='golf.workflow.act.v0.2.89.linux.v2' AND r.input_schema_sha256=NEW.schema_sha256 AND r.submitted_inputs_sha256=NEW.submitted_sha256 AND r.effective_inputs_sha256=NEW.effective_sha256) OR
   NOT EXISTS(SELECT 1 FROM golf_users u WHERE u.id=NEW.user_id AND u.forge_url=NEW.forge_url AND u.forge_user_id=NEW.native_actor_id) THEN RAISE EXCEPTION 'Workflow dispatch input run or actor binding invalid'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION golf_workflow_typed_input_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.input_contract,NEW.input_schema_sha256,NEW.submitted_inputs_sha256,NEW.effective_inputs_sha256) IS DISTINCT FROM ROW(OLD.input_contract,OLD.input_schema_sha256,OLD.submitted_inputs_sha256,OLD.effective_inputs_sha256) THEN RAISE EXCEPTION 'Immutable workflow input metadata'; END IF;
 IF NEW.input_contract<>'' AND (NEW.plan#>>'{Actions,manualInputsContract}' IS DISTINCT FROM NEW.input_contract OR NEW.plan#>>'{Actions,manualInputsSchemaSha256}' IS DISTINCT FROM NEW.input_schema_sha256) THEN RAISE EXCEPTION 'Typed workflow plan binding invalid'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_workflow_typed_input_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.input_contract<>'' AND NOT EXISTS(SELECT 1 FROM golf_workflow_dispatch_inputs c WHERE c.run_id=NEW.id AND c.contract_version=1 AND c.forge_url=NEW.forge_url AND c.user_id=NEW.user_id AND c.repository_id=NEW.repository_id AND c.owner_id=NEW.owner_id AND c.idempotency_key=NEW.idempotency_key AND c.commit_id=NEW.commit_id AND c.workflow_path=NEW.workflow_path AND c.blob_id=NEW.blob_id AND c.source_sha256=NEW.source_sha256 AND c.schema_sha256=NEW.input_schema_sha256 AND c.submitted_sha256=NEW.submitted_inputs_sha256 AND c.effective_sha256=NEW.effective_inputs_sha256) THEN RAISE EXCEPTION 'Typed workflow requires exact encrypted input content'; END IF;
 RETURN NULL;
END $$;
-- +goose StatementEnd
CREATE TRIGGER golf_workflow_typed_input_guard BEFORE INSERT OR UPDATE ON golf_workflow_runs FOR EACH ROW EXECUTE FUNCTION golf_workflow_typed_input_guard();
CREATE CONSTRAINT TRIGGER golf_workflow_typed_input_complete AFTER INSERT OR UPDATE ON golf_workflow_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION golf_workflow_typed_input_complete();

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained typed workflows require coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd

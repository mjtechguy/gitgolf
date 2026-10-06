-- +goose Up
ALTER TABLE golf_agent_worker_presence ADD COLUMN acp_image text NOT NULL DEFAULT '';
ALTER TABLE golf_agent_worker_presence ADD COLUMN acp_version text NOT NULL DEFAULT '';
ALTER TABLE golf_agent_worker_presence ADD COLUMN acp_file_tools boolean NOT NULL DEFAULT false;
CREATE TABLE golf_agent_controls (
 task_id uuid NOT NULL,
 attempt_id text NOT NULL,
 image text NOT NULL CHECK(image ~ '^sha256:[a-f0-9]{64}$'),
 native_version text NOT NULL,
 file_tools_qualified boolean NOT NULL DEFAULT false,
 native_session text NOT NULL DEFAULT '',
 resume boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'initializing' CHECK(state IN ('initializing','active','idle','permission','dispatching','cancelling','closing','closed')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 screened_sequence bigint NOT NULL DEFAULT 0 CHECK(screened_sequence BETWEEN 0 AND 513),
 permission_id text NOT NULL DEFAULT '',
 tool_id text NOT NULL DEFAULT '',
 allow_once_options jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(allow_once_options)='array'),
 PRIMARY KEY(task_id,attempt_id),
 FOREIGN KEY(task_id,attempt_id) REFERENCES golf_agent_conversations(task_id,attempt_id)
);
CREATE TABLE golf_agent_commands (
 task_id uuid NOT NULL,
 attempt_id text NOT NULL,
 request_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('reply','cancel_turn','resume','permission','finish')),
 input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32),
 content_id uuid NOT NULL UNIQUE REFERENCES golf_agent_conversation_contents(id),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','claimed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(task_id,attempt_id,request_id),
 FOREIGN KEY(task_id,attempt_id) REFERENCES golf_agent_controls(task_id,attempt_id)
);
CREATE UNIQUE INDEX golf_agent_one_pending_command ON golf_agent_commands(task_id,attempt_id) WHERE state='queued';
CREATE TABLE golf_agent_native_sends (
 task_id uuid NOT NULL,
 attempt_id text NOT NULL,
 input_id text NOT NULL CHECK(octet_length(input_id) BETWEEN 1 AND 256),
 kind text NOT NULL CHECK(kind IN ('prompt','reply','cancel','resume','permission')),
 input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(task_id,attempt_id,input_id),
 FOREIGN KEY(task_id,attempt_id) REFERENCES golf_agent_controls(task_id,attempt_id)
);
-- +goose StatementBegin
CREATE FUNCTION golf_agent_command_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.task_id,NEW.attempt_id,NEW.request_id,NEW.kind,NEW.input_hash,NEW.content_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.task_id,OLD.attempt_id,OLD.request_id,OLD.kind,OLD.input_hash,OLD.content_id,OLD.created_at) OR OLD.state<>'queued' OR NEW.state<>'claimed' THEN
  RAISE EXCEPTION 'Original agent command is immutable and cannot be replayed';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_agent_control_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.task_id,NEW.attempt_id,NEW.image,NEW.native_version,NEW.file_tools_qualified) IS DISTINCT FROM ROW(OLD.task_id,OLD.attempt_id,OLD.image,OLD.native_version,OLD.file_tools_qualified) OR (OLD.native_session<>'' AND NEW.native_session<>OLD.native_session) OR OLD.state='closed' OR NEW.revision<>OLD.revision+1 OR NEW.screened_sequence<OLD.screened_sequence THEN
  RAISE EXCEPTION 'Agent sandbox identity and closure are immutable';
 END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER golf_agent_command_claim BEFORE UPDATE ON golf_agent_commands FOR EACH ROW EXECUTE FUNCTION golf_agent_command_claim_guard();
CREATE TRIGGER golf_agent_control_identity BEFORE UPDATE ON golf_agent_controls FOR EACH ROW EXECUTE FUNCTION golf_agent_control_identity_guard();
CREATE TRIGGER golf_agent_commands_retained BEFORE DELETE OR TRUNCATE ON golf_agent_commands FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_agent_controls_retained BEFORE DELETE OR TRUNCATE ON golf_agent_controls FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_agent_native_sends_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_agent_native_sends FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TABLE golf_workflow_agent_children (
 run_id uuid NOT NULL REFERENCES golf_workflow_runs(id),
 parent_attempt text NOT NULL CHECK(parent_attempt ~ '^[a-f0-9]{32}$'),
 instance_id text NOT NULL CHECK(instance_id ~ '^[a-f0-9]{32}$'),
 step_id text NOT NULL,
 task_id uuid NOT NULL UNIQUE REFERENCES golf_agent_tasks(id),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,parent_attempt,instance_id,step_id)
);
CREATE TRIGGER golf_workflow_agent_children_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_workflow_agent_children FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
ALTER TABLE golf_agent_task_events DROP CONSTRAINT golf_agent_task_events_kind_check;
ALTER TABLE golf_agent_task_events ADD CONSTRAINT golf_agent_task_events_kind_check CHECK(kind IN ('prompt','user_message','thread_started','turn_started','tool_started','tool_completed','approval_declined','assistant_message','plan_updated','usage_updated','turn_completed'));
ALTER TABLE golf_workflow_runs DROP CONSTRAINT golf_workflow_engine_catalog;
ALTER TABLE golf_workflow_runs ADD CONSTRAINT golf_workflow_engine_catalog CHECK(engine_catalog IN ('golf.workflow.shell.v1','golf.workflow.act.v0.2.89.linux.v1','golf.workflow.act.v0.2.89.linux.v2','golf.workflow.act.v0.2.89.linux.agents088.v1'));
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION golf_workflow_initialize_graph() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
 IF NEW.engine_catalog IN ('golf.workflow.act.v0.2.89.linux.v1','golf.workflow.act.v0.2.89.linux.v2','golf.workflow.act.v0.2.89.linux.agents088.v1') THEN
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
 IF OLD.engine_catalog IN ('golf.workflow.act.v0.2.89.linux.v1','golf.workflow.act.v0.2.89.linux.v2','golf.workflow.act.v0.2.89.linux.agents088.v1') AND
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
DO $$ BEGIN RAISE EXCEPTION 'Preserve original managed commands and conversations; downgrade requires qualified recovery'; END $$;
-- +goose StatementEnd

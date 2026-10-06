package server

import (
	"archive/tar"
	"bytes"
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestWorkflowAgent088OriginalParentAndChildAuthorityPostgres(t *testing.T) {
	f := newConversationFixture(t)
	s := f.x.f.server
	ctx, _ := controlContext(t, f)
	f.x.f.enable(t)
	s.config.AgentImage = "sha256:" + strings.Repeat("b", 64)
	s.config.ReviewImage = "sha256:" + strings.Repeat("d", 64)
	s.config.ActionsEngineCatalog = runner.ActionsAgentCatalog
	f.r.ID = uuid.NewString()
	if _, e := s.db.Exec(`INSERT INTO golf_codex_connections(id,user_id,forge_url,harness,provider,auth_method,state,name) VALUES($1,$2,$3,'opencode','opencode-go','apiKey','CONNECTED','Workflow native account')`, f.r.ID, f.t.UserID, s.config.GiteaURL); e != nil {
		t.Fatal(e)
	}
	if _, e := s.db.Exec(`INSERT INTO golf_agent_model_catalogs(connection_id,connection_version,models) VALUES($1,1,'[{"id":"opencode-go/model","name":"Native model","reasoning":[]}]')`, f.r.ID); e != nil {
		t.Fatal(e)
	}
	config, _ := json.Marshal(map[string]any{"enabled": true, "connection_id": f.r.ID, "model_id": "opencode-go/model", "allow_all_models": true, "triggers": []string{"manual"}, "timeout_seconds": 60, "token_budget": 1000, "spend_limit_cents": 0, "max_concurrent": 1})
	for _, v := range []struct {
		scope, id string
		owner     int64
	}{{"instance", "instance", 0}, {"repository", "11", 42}, {"personal", strconv.FormatInt(f.t.UserID, 10), f.t.UserID}} {
		if _, e := s.db.Exec(`INSERT INTO golf_agent_usage_settings(forge_url,scope,scope_id,owner_id,config,revision) VALUES($1,$2,$3,$4,$5,1)`, s.config.GiteaURL, v.scope, v.id, v.owner, config); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := s.db.Exec(`INSERT INTO golf_agent_worker_presence(forge_url,worker_id,image,acp_image,acp_version) VALUES($1,'worker',$2,$3,$4)`, s.config.GiteaURL, s.config.AgentImage, s.config.ReviewImage, runner.ManagedACPVersion); e != nil {
		t.Fatal(e)
	}
	workflow := []byte("on: workflow_dispatch\njobs:\n  check:\n    runs-on: linux\n    steps:\n      - id: advice\n        uses: golf/agent@v1\n        with: {prompt: Inspect the original source}\n")
	source := workflowRunTar(t, []*tar.Header{{Name: runWorkflowPath, Typeflag: tar.TypeReg, Mode: 0644}}, [][]byte{workflow})
	sha := sourceArchiveHash(source)
	job := strings.Repeat("f", 32)
	graph := runner.ActionPlan{Catalog: runner.ActionsAgentCatalog, EngineCommit: runner.ActionsEngineCommit, WorkflowPath: runWorkflowPath, WorkflowBlobID: workflowTestBlob(workflow), ArchiveSHA256: sha, Jobs: []runner.ActionJob{{InstanceID: job, JobID: "check", Name: "Check", Image: s.runnerImages["linux"], Steps: []runner.ActionStep{{ID: "advice", Name: "Agent advice", AgentPrompt: "Inspect the original source"}}}}}
	plan, _ := json.Marshal(workflowExecutionPlan{Actions: &graph})
	runID := uuid.NewString()
	attempt := strings.Repeat("e", 32)
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	policy, e := s.readEffectiveExecutionPolicy(ctx, tx, 11, 42, false, runWorkflowPath)
	if e != nil {
		t.Fatal(e)
	}
	epochs, _ := json.Marshal(policy.Epochs)
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	_, e = s.db.Exec(`INSERT INTO golf_workflow_runs(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,user_id,session_hash,commit_id,workflow_path,blob_id,format,plan,source_archive,source_sha256,policy_epochs,idempotency_key,input_hash) VALUES($1,$2,11,42,'alice','example',false,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13)`, runID, s.config.GiteaURL, f.t.UserID, f.t.Hash, f.t.Commit, runWorkflowPath, workflowTestBlob(workflow), plan, source, sha, epochs, uuid.NewString(), bytes.Repeat([]byte{9}, 32))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.db.Exec(`UPDATE golf_workflow_runs SET state='running',runner_id='fixture',attempt_id=$2,lease_token_hash=$3,lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, runID, attempt, bytes.Repeat([]byte{7}, 32)); e != nil {
		t.Fatal(e)
	}
	run, e := s.loadWorkflowRun(ctx, runID)
	if e != nil {
		t.Fatal(e)
	}
	tx, e = s.db.BeginTx(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, event := range []actionEvent{{1, job, "", "job_started", ""}, {2, job, "advice", "step_started", ""}} {
		if e = recordActionEvent(ctx, tx, run, event); e != nil {
			t.Fatal(e)
		}
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	original, e := s.prepareWorkflowAgent(ctx, run, job, "advice")
	if e != nil {
		t.Fatal(e)
	}
	admit := func(a *workflowAgentAdmission) (string, string, error) {
		tx, e := s.db.BeginTx(ctx, nil)
		if e != nil {
			return "", "", e
		}
		defer tx.Rollback()
		if e = s.runnerPolicyFence(ctx, tx, run); e != nil {
			return "", "", e
		}
		if e = s.runnerResourceFence(ctx, tx, run); e != nil {
			return "", "", e
		}
		state, id, e := s.admitWorkflowAgent(ctx, tx, run, a)
		if e == nil {
			e = tx.Commit()
		}
		return state, id, e
	}
	state, child, e := admit(original)
	if e != nil || state != "queued" {
		t.Fatal("original parent did not admit private child", e)
	}
	repeated, e := s.prepareWorkflowAgent(ctx, run, job, "advice")
	if e != nil {
		t.Fatal(e)
	}
	_, same, e := admit(repeated)
	if e != nil || same != child {
		t.Fatal("workflow child replayed instead of inspecting original intent", e)
	}
	task, e := s.taskRecord(ctx, child)
	if e != nil || !bytes.Equal(task.Source, source) || task.Commit != run.CommitID || !bytes.Equal(task.Hash, run.SessionHash) {
		t.Fatal("child adopted a different source/initiator", e)
	}
	actor, e := s.taskActor(ctx, task)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.codexGuard(ctx, actor, func(tx *sql.Tx, _ int64) error { return s.agentAttemptFence(ctx, tx, actor, repeated.Account, task) }); e != nil {
		t.Fatal("current original parent+agent fence refused", e)
	}
	copy := task
	copy.Commit = strings.Repeat("a", 39) + "b"
	if s.workflowAgentAuthority(ctx, copy) == nil {
		t.Fatal("different source commit adopted parent authority")
	}
	if _, e = s.db.Exec(`UPDATE golf_workflow_agent_children SET step_id='other' WHERE task_id=$1`, child); e == nil {
		t.Fatal("parent step binding changed")
	}
	if _, e = s.db.Exec(`UPDATE golf_workflow_runs SET source_sha256=$2 WHERE id=$1`, runID, strings.Repeat("b", 64)); e == nil {
		t.Fatal("original graph source changed")
	}
	if _, e := s.prepareWorkflowAgent(ctx, run, strings.Repeat("a", 32), "advice"); e == nil {
		t.Fatal("foreign native job instance admitted child")
	}
	if _, e = s.db.Exec(`UPDATE golf_codex_connections SET state='UNCONFIGURED',version=version+1 WHERE id=$1`, f.r.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.prepareWorkflowAgent(ctx, run, job, "advice"); e == nil {
		t.Fatal("ordinary Actions authorization widened revoked agent account")
	}
	if _, e = s.db.Exec(`UPDATE golf_workflow_runs SET cancel_requested=true WHERE id=$1`, runID); e != nil {
		t.Fatal(e)
	}
	if s.workflowAgentAuthority(ctx, task) == nil {
		t.Fatal("parent cancellation did not stop child authority")
	}
}

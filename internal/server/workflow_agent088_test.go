package server

import (
	"archive/tar"
	"bytes"
	"connectrpc.com/connect"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestWorkflowAgent088OriginalParentAndChildAuthorityPostgres(t *testing.T) {
	workflowAgent088AuthorityFixture(t, "")
}

func TestWorkflowAgent088PoolEditWhileWaitingForWorkerPostgres(t *testing.T) {
	workflowAgent088AuthorityFixture(t, "pool")
}

func TestWorkflowAgent088RefusesBrokerBindingBeforeApproverLocksPostgres(t *testing.T) {
	workflowAgent088AuthorityFixture(t, "broker")
}

func workflowAgent088AuthorityFixture(t *testing.T, mode string) {
	t.Helper()
	poolRace := mode == "pool"
	f := newConversationFixture(t)
	s := f.x.f.server
	ctx, _ := controlContext(t, f)
	f.x.f.enable(t)
	s.config.AgentImage = "sha256:" + strings.Repeat("b", 64)
	s.config.ReviewImage = "sha256:" + strings.Repeat("d", 64)
	s.config.ActionsEngineCatalog = runner.ActionsAgentCatalog
	f.r.ID = uuid.NewString()
	if _, e := s.db.Exec(`INSERT INTO golf_codex_connections(id,user_id,forge_url,harness,provider,auth_method,state,name) VALUES($1,$2,$3,'opencode','opencode-go','apiKey','CONNECTED','Workflow native account')`, f.r.ID, f.t.UserID, s.config.ForgeURL); e != nil {
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
		if _, e := s.db.Exec(`INSERT INTO golf_agent_usage_settings(forge_url,scope,scope_id,owner_id,config,revision) VALUES($1,$2,$3,$4,$5,1)`, s.config.ForgeURL, v.scope, v.id, v.owner, config); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := s.db.Exec(`INSERT INTO golf_agent_worker_presence(forge_url,worker_id,image,acp_image,acp_version) VALUES($1,'worker',$2,$3,$4)`, s.config.ForgeURL, s.config.AgentImage, s.config.ReviewImage, runner.ManagedACPVersion); e != nil {
		t.Fatal(e)
	}
	poolID := uuid.NewString()
	if poolRace {
		if _, e := s.db.Exec(`INSERT INTO golf_runner_pools(forge_url,id,name,runtime,state,max_parallel_attempts,repository_assignment_enabled,version,actor_user_id) VALUES($1,$2,'Agent fixture','local-docker','active',1,true,1,$3)`, s.config.ForgeURL, poolID, f.t.UserID); e != nil {
			t.Fatal(e)
		}
		if _, e := s.db.Exec(`INSERT INTO golf_repository_runner_placements(forge_url,repository_id,owner_id,version,pool_id,selected_pool_version,actor_user_id) VALUES($1,11,42,1,$2,1,$3)`, s.config.ForgeURL, poolID, f.t.UserID); e != nil {
			t.Fatal(e)
		}
		if _, e := s.db.Exec(`INSERT INTO golf_runner_pool_workers(forge_url,runner_id,pool_id) VALUES($1,'fixture',$2)`, s.config.ForgeURL, poolID); e != nil {
			t.Fatal(e)
		}
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
	_, e = s.db.Exec(`INSERT INTO golf_workflow_runs(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,user_id,session_hash,commit_id,workflow_path,blob_id,format,plan,source_archive,source_sha256,policy_epochs,idempotency_key,input_hash) VALUES($1,$2,11,42,'alice','example',false,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13)`, runID, s.config.ForgeURL, f.t.UserID, f.t.Hash, f.t.Commit, runWorkflowPath, workflowTestBlob(workflow), plan, source, sha, epochs, uuid.NewString(), bytes.Repeat([]byte{9}, 32))
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
	if mode == "broker" {
		binding := uuid.NewString()
		if _, e = s.db.Exec(`INSERT INTO golf_execution_value_brokers(forge_url,repository_id,owner_id) VALUES($1,11,42)`, run.ForgeURL); e != nil {
			t.Fatal(e)
		}
		if _, e = s.db.Exec(`INSERT INTO golf_execution_bindings(id,forge_url,repository_id,owner_id,version) VALUES($1,$2,11,42,1)`, binding, run.ForgeURL); e != nil {
			t.Fatal(e)
		}
		// Deliberately attach retained broker metadata to this new catalog. It
		// must be rejected before any approver lock, even if other source checks
		// would later refuse the mismatched catalog.
		if _, e = s.db.Exec(`INSERT INTO golf_execution_binding_versions(id,version,workflow_path,commit_id,blob_id,source_sha256,engine_catalog,event,event_ref,value_refs,approver_user_id,approver_native_id,approval_session_hash,expires_at) VALUES($1,1,$2,$3,$4,$5,$6,'manual','', $7,$8,42,$9,clock_timestamp()+interval '1 hour')`, binding, run.WorkflowPath, run.CommitID, run.BlobID, run.SourceSHA256, runner.ActionsCatalog, `[{"id":"00000000-0000-4000-8000-000000000088","version":"1"}]`, run.UserID, run.SessionHash); e != nil {
			t.Fatal(e)
		}
		if _, e = s.db.Exec(`INSERT INTO golf_workflow_execution_bindings(run_id,binding_id,binding_version) VALUES($1,$2,1)`, run.ID, binding); e != nil {
			t.Fatal(e)
		}
		if _, e = s.prepareWorkflowAgent(ctx, run, job, "advice"); !errors.Is(e, errRunnerUnavailable) {
			t.Fatal("broker-bound parent admitted agent child", e)
		}
		if e = s.codexGuard(ctx, actor, func(tx *sql.Tx, _ int64) error { return s.agentAttemptFence(ctx, tx, actor, repeated.Account, task) }); !errors.Is(e, errRunnerUnavailable) {
			t.Fatal("broker-bound child acquired approver/publication authority", e)
		}
		return
	}
	if poolRace {
		holder, e := s.db.BeginTx(ctx, nil)
		if e != nil {
			t.Fatal(e)
		}
		defer holder.Rollback()
		if e = s.lockRunnerControl(ctx, holder, run.RunnerID); e != nil {
			t.Fatal(e)
		}
		result := make(chan error, 1)
		pid := make(chan int, 1)
		go func() {
			tx, e := s.db.BeginTx(ctx, nil)
			if e != nil {
				result <- e
				return
			}
			defer tx.Rollback()
			var backend int
			if e = tx.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&backend); e != nil {
				result <- e
				return
			}
			pid <- backend
			result <- s.agentAttemptFence(ctx, tx, actor, repeated.Account, task)
		}()
		backend := <-pid
		// Wait for the actual advisory-lock wait, not a timing assumption.
		deadline := time.Now().Add(5 * time.Second)
		for {
			var waiting bool
			if e = s.db.QueryRowContext(ctx, `SELECT coalesce(wait_event='advisory',false) FROM pg_stat_activity WHERE pid=$1`, backend).Scan(&waiting); e != nil {
				t.Fatal(e)
			}
			if waiting {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("child did not reach the worker-control lock")
			}
			time.Sleep(5 * time.Millisecond)
		}
		edit, e := s.db.BeginTx(ctx, nil)
		if e != nil {
			t.Fatal(e)
		}
		defer edit.Rollback()
		if e = s.lockRunnerPool(ctx, edit, poolID); e != nil {
			t.Fatal(e)
		}
		// Exercise the same versioned Golf metadata transition under the same
		// pool lock as SaveRunnerPool, without taking a second actor lock.
		if _, e = edit.ExecContext(ctx, `UPDATE golf_runner_pools SET cpu_millis=500,version=version+1 WHERE forge_url=$1 AND id=$2`, s.config.ForgeURL, poolID); e != nil {
			t.Fatal(e)
		}
		if e = edit.Commit(); e != nil {
			t.Fatal(e)
		}
		if e = holder.Commit(); e != nil {
			t.Fatal(e)
		}
		select {
		case e = <-result:
			if !errors.Is(e, errRunnerResourcesStale) {
				t.Fatal("pool edit during worker wait retained child authority", e)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("child resource fence did not settle")
		}
		return
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

func TestWorkflowAgent088ChildReadLateReplacementPostgres(t *testing.T) {
	for _, change := range []string{"repository", "owner"} {
		t.Run(change, func(t *testing.T) {
			f := newConversationFixture(t)
			s := f.x.f.server
			ctx, cookie := controlContext(t, f)
			runID := uuid.NewString()
			f.x.workflow(t, runID, 11, runWorkflowPath, f.x.at)
			run, e := s.loadWorkflowRun(ctx, runID)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = s.db.Exec(`INSERT INTO golf_workflow_agent_children(run_id,parent_attempt,instance_id,step_id,task_id,source_sha256) VALUES($1,$2,$3,'private-step',$4,$5)`, run.ID, run.AttemptID, strings.Repeat("f", 32), f.t.ID, run.SourceSHA256); e != nil {
				t.Fatal(e)
			}
			base := s.client.Transport
			if base == nil {
				base = http.DefaultTransport
			}
			calls := 0
			s.client.Transport = creationRoundTripper(func(req *http.Request) (*http.Response, error) {
				if req.URL.Path == "/api/v1/repos/alice/example" {
					calls++
					if calls == 2 {
						f.x.f.mu.Lock()
						if change == "repository" {
							f.x.f.row.ID = 99
						} else {
							f.x.f.row.Owner.ID = 43
						}
						f.x.f.mu.Unlock()
					}
				}
				return base.RoundTrip(req)
			})
			request := connect.NewRequest(&golfv1.ListWorkflowAgentChildrenRequest{RunId: run.ID, AttemptId: run.AttemptID})
			request.Header().Set("Cookie", cookie)
			response, e := s.ListWorkflowAgentChildren(ctx, request)
			if e == nil || response != nil || calls < 2 {
				t.Fatal("same-name replacement released original private child metadata", e)
			}
		})
	}
}

package server

import (
	"connectrpc.com/connect"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

type workflowAgentAdmission struct {
	Job, Step, Task, Fingerprint string
	Actor                        codexActor
	Account                      codexRecord
	Config                       *golfv1.AgentUsageConfig
	Source                       []byte
	Digest                       [32]byte
}

func (s *Server) ListWorkflowAgentChildren(ctx context.Context, req *connect.Request[golfv1.ListWorkflowAgentChildrenRequest]) (*connect.Response[golfv1.ListWorkflowAgentChildrenResponse], error) {
	a, e := s.codexIdentity(ctx, req.Header())
	if e != nil {
		return nil, rpcError(e)
	}
	run, e := s.loadWorkflowRun(ctx, req.Msg.RunId)
	if e != nil {
		return nil, rpcError(e)
	}
	if run.UserID != a.UserID {
		return nil, rpcError(errResourceNotFound)
	}
	if run.AttemptID != req.Msg.AttemptId {
		return nil, rpcError(errWorkflowRunConflict)
	}
	authority, e := s.agentAuthority(ctx, a, golfv1.AgentUsageScope_AGENT_USAGE_SCOPE_REPOSITORY, "", &golfv1.RepositoryKey{Owner: run.RepositoryOwner, Name: run.RepositoryName})
	if e != nil {
		return nil, rpcError(e)
	}
	if authority.ID != strconv.FormatInt(run.RepositoryID, 10) || authority.OwnerID != run.OwnerID {
		return nil, rpcError(errResourceNotFound)
	}
	out := &golfv1.ListWorkflowAgentChildrenResponse{RunId: run.ID, AttemptId: run.AttemptID, RepositoryId: strconv.FormatInt(run.RepositoryID, 10), CommitId: run.CommitID}
	rows, e := s.db.QueryContext(ctx, `SELECT c.instance_id,c.step_id,t.id::text,t.attempt_id,t.state FROM golf_workflow_agent_children c JOIN golf_agent_tasks t ON t.id=c.task_id WHERE c.run_id=$1 AND c.parent_attempt=$2 AND t.user_id=$3 AND t.repository_id=$4 AND t.commit_id=$5 ORDER BY c.created_at,c.instance_id,c.step_id LIMIT 129`, run.ID, run.AttemptID, a.UserID, run.RepositoryID, run.CommitID)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	for rows.Next() {
		v := &golfv1.WorkflowAgentChild{}
		if e = rows.Scan(&v.JobInstanceId, &v.StepId, &v.TaskId, &v.AttemptId, &v.State); e != nil {
			rows.Close()
			return nil, rpcError(errStorageUnavailable)
		}
		out.Children = append(out.Children, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil || len(out.Children) > 128 {
		return nil, rpcError(errStorageUnavailable)
	}
	if e = s.codexGuard(ctx, a, func(*sql.Tx, int64) error { return nil }); e != nil {
		return nil, rpcError(e)
	}
	if _, e = s.agentAuthority(ctx, a, golfv1.AgentUsageScope_AGENT_USAGE_SCOPE_REPOSITORY, "", &golfv1.RepositoryKey{Owner: run.RepositoryOwner, Name: run.RepositoryName}); e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}

func (s *Server) prepareWorkflowAgent(ctx context.Context, run workflowRunRecord, job, step string) (*workflowAgentAdmission, error) {
	if run.Origin != "manual" || run.EngineCatalog != runner.ActionsAgentCatalog || s.config.ActionsEngineCatalog != runner.ActionsAgentCatalog || !s.agentACPAvailable(ctx) || !attemptIdentifier.MatchString(job) || !actionStepID(step) {
		return nil, errRunnerUnavailable
	}
	var raw []byte
	if s.db.QueryRowContext(ctx, `SELECT plan FROM golf_workflow_runs WHERE id=$1 AND attempt_id=$2`, run.ID, run.AttemptID).Scan(&raw) != nil {
		return nil, errStorageUnavailable
	}
	var plan workflowExecutionPlan
	if json.Unmarshal(raw, &plan) != nil || plan.Actions == nil || plan.Actions.Catalog != runner.ActionsAgentCatalog {
		return nil, errWorkflowRunConflict
	}
	prompt := ""
	for _, j := range plan.Actions.Jobs {
		for _, v := range j.Steps {
			if j.InstanceID == job && v.ID == step {
				prompt = v.AgentPrompt
			}
		}
	}
	if strings.TrimSpace(prompt) == "" || !conversationText(prompt, 2048) {
		return nil, errWorkflowRunConflict
	}
	token, e := s.sessionCredentialHash(ctx, run.SessionHash)
	if e != nil {
		return nil, e
	}
	user, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, e
	}
	actor := codexActor{UserID: run.UserID, NativeID: user.ID, Hash: run.SessionHash, Credential: token}
	authority, settings, account, e := s.taskConfig(ctx, actor, &golfv1.RepositoryKey{Owner: run.RepositoryOwner, Name: run.RepositoryName}, nil, "Workflow agent step (original pinned source snapshot; prior job workspace mutations are not visible, never apply or publish a patch):\n"+prompt)
	if e != nil {
		return nil, e
	}
	if authority.ID != strconv.FormatInt(run.RepositoryID, 10) || authority.OwnerID != run.OwnerID || account.Harness != "opencode" || account.Provider != "opencode-go" {
		return nil, errExecutionPolicyConflict
	}
	fingerprint, e := s.agentPolicyFingerprint(ctx, s.db, actor, run.RepositoryID, run.OwnerID)
	if e != nil {
		return nil, e
	}
	v := &workflowAgentAdmission{Job: job, Step: step, Actor: actor, Account: account, Config: settings.Effective, Fingerprint: fingerprint}
	e = s.db.QueryRowContext(ctx, `SELECT task_id::text FROM golf_workflow_agent_children WHERE run_id=$1 AND parent_attempt=$2 AND instance_id=$3 AND step_id=$4`, run.ID, run.AttemptID, job, step).Scan(&v.Task)
	if e == nil {
		return v, nil
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return nil, errStorageUnavailable
	}
	v.Source, e = s.workflowSourceObject(ctx, run)
	if e != nil || sourceArchiveHash(v.Source) != run.SourceSHA256 {
		return nil, errWorkflowSource
	}
	encoded, _ := json.Marshal([]any{run.ID, run.AttemptID, job, step, run.RepositoryID, run.OwnerID, run.UserID, run.CommitID, run.SourceSHA256, run.WorkflowPath, run.BlobID, settings.Effective, fingerprint, account.ID, account.Version})
	v.Digest = sha256.Sum256(encoded)
	return v, nil
}

// Called under the original runner enrollment/lease, current workflow policy,
// source approval and resource fence. It separately fences current agent grants.
func (s *Server) admitWorkflowAgent(ctx context.Context, tx *sql.Tx, run workflowRunRecord, a *workflowAgentAdmission) (state, id string, err error) {
	if a == nil || run.CancelRequested || run.Origin != "manual" {
		return "", "", errWorkflowRunConflict
	}
	if err = s.agentFence(ctx, tx, a.Actor, a.Account, run.RepositoryID, run.OwnerID, a.Fingerprint); err != nil {
		return
	}
	if err = workflowAgentStepRunning(ctx, tx, run, a.Job, a.Step); err != nil {
		return
	}
	err = tx.QueryRowContext(ctx, `SELECT t.id::text,t.state FROM golf_workflow_agent_children c JOIN golf_agent_tasks t ON t.id=c.task_id WHERE c.run_id=$1 AND c.parent_attempt=$2 AND c.instance_id=$3 AND c.step_id=$4 AND c.source_sha256=$5 AND t.commit_id=$6 AND t.user_id=$7 AND t.repository_id=$8 AND t.owner_id=$9 AND t.policy_fingerprint=$10 AND t.connection_id=$11`, run.ID, run.AttemptID, a.Job, a.Step, run.SourceSHA256, run.CommitID, run.UserID, run.RepositoryID, run.OwnerID, a.Fingerprint, a.Account.ID).Scan(&id, &state)
	if err == nil {
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", "", errStorageUnavailable
	}
	if a.Task != "" {
		return "", "", errWorkflowRunConflict
	}
	id = uuid.NewString()
	config, _ := json.Marshal(a.Config)
	_, err = tx.ExecContext(ctx, `INSERT INTO golf_agent_tasks(id,forge_url,repository_id,owner_id,repository_owner,repository_name,user_id,native_user_id,session_hash,connection_id,connection_version,commit_id,source_archive,config,policy_fingerprint,idempotency_key,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$1,$16)`, id, s.config.GiteaURL, run.RepositoryID, run.OwnerID, run.RepositoryOwner, run.RepositoryName, run.UserID, a.Actor.NativeID, run.SessionHash, a.Account.ID, a.Account.Version, run.CommitID, a.Source, config, a.Fingerprint, a.Digest[:])
	if err != nil {
		return "", "", errStorageUnavailable
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO golf_workflow_agent_children(run_id,parent_attempt,instance_id,step_id,task_id,source_sha256) VALUES($1,$2,$3,$4,$5,$6)`, run.ID, run.AttemptID, a.Job, a.Step, id, run.SourceSHA256)
	if err != nil {
		return "", "", errStorageUnavailable
	}
	return "queued", id, nil
}

func workflowAgentStepRunning(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, run workflowRunRecord, job, step string) error {
	var current bool
	e := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_workflow_runs r WHERE r.id=$1 AND r.attempt_id=$2 AND r.state='running' AND NOT r.cancel_requested AND r.lease_expires_at>clock_timestamp()) AND EXISTS(SELECT 1 FROM golf_workflow_graph_events WHERE run_id=$1 AND attempt_id=$2 AND instance_id=$3 AND kind='job_started') AND NOT EXISTS(SELECT 1 FROM golf_workflow_graph_events WHERE run_id=$1 AND attempt_id=$2 AND instance_id=$3 AND kind='job_finished') AND EXISTS(SELECT 1 FROM golf_workflow_graph_events WHERE run_id=$1 AND attempt_id=$2 AND instance_id=$3 AND step_id=$4 AND kind='step_started') AND NOT EXISTS(SELECT 1 FROM golf_workflow_graph_events WHERE run_id=$1 AND attempt_id=$2 AND instance_id=$3 AND step_id=$4 AND kind='step_finished')`, run.ID, run.AttemptID, job, step).Scan(&current)
	if e != nil {
		return errStorageUnavailable
	}
	if !current {
		return errWorkflowRunConflict
	}
	return nil
}
func (s *Server) workflowAgentParent(ctx context.Context, t agentTaskRecord) (run workflowRunRecord, job, step string, linked bool, err error) {
	var id, attempt, sha string
	err = s.db.QueryRowContext(ctx, `SELECT run_id::text,parent_attempt,instance_id,step_id,source_sha256 FROM golf_workflow_agent_children WHERE task_id=$1`, t.ID).Scan(&id, &attempt, &job, &step, &sha)
	if errors.Is(err, sql.ErrNoRows) {
		return run, "", "", false, nil
	}
	if err != nil {
		return run, "", "", false, errStorageUnavailable
	}
	linked = true
	run, err = s.loadWorkflowRun(ctx, id)
	if err != nil {
		return
	}
	if run.AttemptID != attempt || run.SourceSHA256 != sha || run.CommitID != t.Commit || run.RepositoryID != t.RepositoryID || run.OwnerID != t.OwnerID || run.UserID != t.UserID || !bytesEqual(run.SessionHash, t.Hash) || run.EngineCatalog != runner.ActionsAgentCatalog {
		err = errWorkflowRunConflict
	}
	return
}
func (s *Server) workflowAgentAuthority(ctx context.Context, t agentTaskRecord) error {
	run, job, step, linked, e := s.workflowAgentParent(ctx, t)
	if e != nil || !linked {
		return e
	}
	if e = s.runnerRunAuthority(ctx, run); e != nil {
		return e
	}
	if e = workflowAgentStepRunning(ctx, s.db, run, job, step); e != nil {
		return e
	}
	approval, e := storedExecutionRunBinding(ctx, s.db, run)
	if e != nil {
		return e
	}
	if approval != nil {
		return s.executionApprovalAuthority(ctx, run, approval)
	}
	return nil
}
func (s *Server) agentAttemptFence(ctx context.Context, tx *sql.Tx, a codexActor, r codexRecord, t agentTaskRecord) error {
	run, job, step, linked, e := s.workflowAgentParent(ctx, t)
	if e != nil {
		return e
	}
	if !linked {
		return s.agentFence(ctx, tx, a, r, t.RepositoryID, t.OwnerID, t.Fingerprint)
	}
	if e = s.runnerPolicyFence(ctx, tx, run); e != nil {
		return e
	}
	if e = s.runnerResourceFence(ctx, tx, run); e != nil {
		return e
	}
	if e = workflowAgentStepRunning(ctx, tx, run, job, step); e != nil {
		return e
	}
	var current bool
	if tx.QueryRowContext(ctx, `SELECT state='running' AND NOT cancel_requested AND lease_expires_at>clock_timestamp() AND attempt_id=$2 FROM golf_workflow_runs WHERE id=$1 FOR UPDATE`, run.ID, run.AttemptID).Scan(&current) != nil || !current {
		return errWorkflowRunConflict
	}
	if e = s.lockRunnerControl(ctx, tx, run.RunnerID); e != nil {
		return e
	}
	control, _, e := s.runnerControl(ctx, tx, run.RunnerID)
	if e != nil {
		return e
	}
	if control == "revoked" {
		return errWorkflowRunConflict
	}
	approval, e := storedExecutionRunBinding(ctx, tx, run)
	if e != nil {
		return e
	}
	if _, e = s.executionBrokerFence(ctx, tx, run, approval); e != nil {
		return e
	}
	return s.agentFence(ctx, tx, a, r, t.RepositoryID, t.OwnerID, t.Fingerprint)
}

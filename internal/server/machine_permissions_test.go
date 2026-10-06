package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/runner"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func machineGrant(t *testing.T, s *Server, login loginResult, key *golfv1.RepositoryKey, id string, scopes ...string) (golfv1connect.ApiCredentialServiceClient, *golfv1.CreateApiCredentialResponse) {
	t.Helper()
	management := apiManagementClient(t, &managementFixture{s: s, db: s.db}, login)
	r, e := management.CreateApiCredential(t.Context(), connect.NewRequest(&golfv1.CreateApiCredentialRequest{Label: "Owned machine permission", WriteRepository: key, WriteRepositoryId: id, WriteScopes: scopes}))
	if e != nil {
		t.Fatal("explicit machine grant", e)
	}
	return management, r.Msg
}
func machineBody(t *testing.T, m proto.Message) string {
	t.Helper()
	b, e := protojson.Marshal(m)
	if e != nil {
		t.Fatal(e)
	}
	return string(b)
}
func TestMachineSourceJournalPostgres(t *testing.T) {
	for _, kind := range []golfv1.RepositoryFileMutationKind{golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE, golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_UPDATE, golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_DELETE} {
		t.Run(kind.String(), func(t *testing.T) {
			f := newFileMutationFixture(t, kind)
			session := f.session(t, "pat")
			m := fileFixtureRequest(kind)
			m.AccessRevision = f.request(t, session).AccessRevision
			management, grant := machineGrant(t, f.s, session, m.Repository, m.RepositoryId, "source:write")
			read := issueApiCredential(t, management, "legacy reader", 3600)
			procedure := golfv1connect.RepositoryFileMutationServiceSubmitRepositoryFileMutationProcedure
			if r := apiRequest(f.s, read.Token, procedure, "{malformed"); r.Code != 403 {
				t.Fatal("readonly decoded sourcewrite", r.Code)
			}
			wrong := proto.Clone(m).(*golfv1.SubmitRepositoryFileMutationRequest)
			wrong.RepositoryId = "12"
			if r := apiRequest(f.s, grant.Token, procedure, machineBody(t, wrong)); r.Code != 403 || f.writes.Load() != 0 {
				t.Fatal("different native target wrote", r.Code)
			}
			wrong.RepositoryId = m.RepositoryId
			wrong.Repository.Name = "other"
			if r := apiRequest(f.s, grant.Token, procedure, machineBody(t, wrong)); r.Code != 403 || f.writes.Load() != 0 {
				t.Fatal("different name wrote", r.Code)
			}
			for i := 0; i < 2; i++ {
				r := apiRequest(f.s, grant.Token, procedure, machineBody(t, m))
				var result golfv1.SubmitRepositoryFileMutationResponse
				if r.Code != 200 || protojson.Unmarshal(r.Body.Bytes(), &result) != nil || result.Operation.GetPhase() != golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_SUCCEEDED {
					t.Fatal("delegated source receipt", r.Code, r.Body.String())
				}
			}
			if f.writes.Load() != 1 {
				t.Fatal("original source key resent")
			}
			status := &golfv1.GetRepositoryFileMutationOperationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, OperationId: m.OperationId}
			if r := apiRequest(f.s, grant.Token, golfv1connect.RepositoryFileMutationServiceGetRepositoryFileMutationOperationProcedure, machineBody(t, status)); r.Code != 200 {
				t.Fatal("original source inspection", r.Code)
			}
			if _, e := management.RevokeApiCredential(t.Context(), connect.NewRequest(&golfv1.RevokeApiCredentialRequest{CredentialId: grant.Credential.Id})); e != nil {
				t.Fatal(e)
			}
			if r := apiRequest(f.s, grant.Token, procedure, machineBody(t, m)); r.Code != 401 || f.writes.Load() != 1 {
				t.Fatal("revoked source delegation", r.Code)
			}
		})
	}
}
func TestMachineSourceProtectionAndUncertaintyPostgres(t *testing.T) {
	for _, mode := range []string{"protected", "lost", "wrong-parent", "late-denied", "head-drift"} {
		t.Run(mode, func(t *testing.T) {
			f := newFileMutationFixture(t, golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE)
			session := f.session(t, "pat")
			m := fileFixtureRequest(golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE)
			m.AccessRevision = f.request(t, session).AccessRevision
			_, grant := machineGrant(t, f.s, session, m.Repository, m.RepositoryId, "source:write")
			f.fileMode.Store(mode)
			procedure := golfv1connect.RepositoryFileMutationServiceSubmitRepositoryFileMutationProcedure
			for i := 0; i < 2; i++ {
				r := apiRequest(f.s, grant.Token, procedure, machineBody(t, m))
				var out golfv1.SubmitRepositoryFileMutationResponse
				if r.Code == 200 && protojson.Unmarshal(r.Body.Bytes(), &out) == nil && out.Operation.GetPhase() == golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_SUCCEEDED {
					t.Fatal("unsafe success", mode)
				}
			}
			if f.writes.Load() > 1 {
				t.Fatal("uncertain source operation resent")
			}
			if (mode == "protected" || mode == "head-drift") && f.writes.Load() != 0 {
				t.Fatal("protected/stale source dispatched")
			}
		})
	}
}
func TestMachineExecutionInspectionPostgres(t *testing.T) {
	f := newConversationFixture(t)
	f.start(t)
	f.observe(t, runner.AgentObservation{Sequence: 1, Kind: "thread_started"})
	f.observe(t, runner.AgentObservation{Sequence: 2, Kind: "turn_started", Status: "inProgress"})
	f.observe(t, runner.AgentObservation{Sequence: 3, Kind: "assistant_message", Text: "Owned recorded progress"})
	f.finish(t, conversationInitial, true)
	s := f.x.f.server
	key := &golfv1.RepositoryKey{Owner: "alice", Name: "example"}
	management, grant := machineGrant(t, s, f.x.login, key, "11", "agents:read", "actions:read")
	taskBody := machineBody(t, &golfv1.GetAgentTaskRequest{TaskId: f.t.ID})
	r := apiRequest(s, grant.Token, golfv1connect.AgentTaskServiceGetAgentTaskProcedure, taskBody)
	var task golfv1.GetAgentTaskResponse
	if r.Code != 200 || protojson.Unmarshal(r.Body.Bytes(), &task) != nil || task.Task == nil || task.Task.CanCancel {
		t.Fatal("own task inspection authority", r.Code, r.Body.String())
	}
	events, _ := json.Marshal(f.body())
	r = apiRequest(s, grant.Token, golfv1connect.AgentTaskServiceListAgentTaskEventsProcedure, string(events))
	if r.Code != 200 || !strings.Contains(r.Body.String(), "Owned recorded progress") {
		t.Fatal("retained private journal", r.Code, r.Body.String())
	}
	id := uuid.NewString()
	f.x.workflow(t, id, 11, ".github/workflows/test.yml", f.x.at)
	for _, procedure := range []string{golfv1connect.WorkflowRunServiceGetWorkflowRunProcedure, golfv1connect.WorkflowRunServiceGetWorkflowRunLogsProcedure} {
		r = apiRequest(s, grant.Token, procedure, machineBody(t, &golfv1.GetWorkflowRunRequest{RunId: id}))
		if r.Code != 200 || strings.Contains(r.Body.String(), `"canCancel":true`) {
			t.Fatal("workflow inspection", r.Code, r.Body.String())
		}
	}
	listBody := machineBody(t, &golfv1.ListAgentTasksRequest{Repository: key})
	if r = apiRequest(s, grant.Token, golfv1connect.AgentTaskServiceListAgentTasksProcedure, listBody); r.Code != 200 {
		t.Fatal("own task inventory", r.Code, r.Body.String())
	}
	for _, procedure := range []string{golfv1connect.AgentTaskServiceCreateAgentTaskProcedure, golfv1connect.AgentTaskServiceCancelAgentTaskProcedure, golfv1connect.WorkflowRunServiceDispatchWorkflowProcedure, golfv1connect.WorkflowRunServiceCancelWorkflowRunProcedure, golfv1connect.CodexAccountServiceListCodexConnectionsProcedure, golfv1connect.AccountSecurityServiceChangeOwnPasswordProcedure} {
		if r = apiRequest(s, grant.Token, procedure, "{malformed"); r.Code != http.StatusForbidden {
			t.Fatal("inspection inherited execution/credentials", r.Code, procedure)
		}
	}
	foreign := uuid.NewString()
	f.x.task(t, foreign, 11, f.x.foreign, f.x.at)
	if r = apiRequest(s, grant.Token, golfv1connect.AgentTaskServiceGetAgentTaskProcedure, machineBody(t, &golfv1.GetAgentTaskRequest{TaskId: foreign})); r.Code != 404 {
		t.Fatal("foreign private task visible", r.Code)
	}
	other := uuid.NewString()
	f.x.workflow(t, other, 12, ".github/workflows/other.yml", f.x.at)
	if r = apiRequest(s, grant.Token, golfv1connect.WorkflowRunServiceGetWorkflowRunProcedure, machineBody(t, &golfv1.GetWorkflowRunRequest{RunId: other})); r.Code == 200 {
		t.Fatal("different workflow repository visible")
	}
	if _, e := management.RevokeApiCredential(t.Context(), connect.NewRequest(&golfv1.RevokeApiCredentialRequest{CredentialId: grant.Credential.Id})); e != nil {
		t.Fatal(e)
	}
	if r = apiRequest(s, grant.Token, golfv1connect.AgentTaskServiceGetAgentTaskProcedure, taskBody); r.Code != 401 {
		t.Fatal("revoked private inspection", r.Code)
	}
}

func TestMachineRefJournalPostgres(t *testing.T) {
	for _, kind := range []golfv1.RepositoryRefMutationKind{golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_CREATE_BRANCH, golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_DELETE_BRANCH, golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_CREATE_TAG, golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_DELETE_TAG} {
		t.Run(kind.String(), func(t *testing.T) {
			f := newRefMutationFixture(t, kind)
			session := f.session(t, "pat")
			m := f.requestRef(t, session, kind)
			management, grant := machineGrant(t, f.s, session, m.Repository, m.RepositoryId, "source:write")
			procedure := golfv1connect.RepositoryRefMutationServiceSubmitRepositoryRefMutationProcedure
			for i := 0; i < 2; i++ {
				response := apiRequest(f.s, grant.Token, procedure, machineBody(t, m))
				var out golfv1.SubmitRepositoryRefMutationResponse
				if response.Code != 200 || protojson.Unmarshal(response.Body.Bytes(), &out) != nil || out.Operation.GetPhase() != golfv1.RepositoryRefMutationPhase_REPOSITORY_REF_MUTATION_PHASE_SUCCEEDED {
					t.Fatal("delegated original ref effect", response.Code, response.Body.String())
				}
			}
			if f.writes.Load() != 1 {
				t.Fatal("original ref dispatched twice")
			}
			if _, e := management.RevokeApiCredential(t.Context(), connect.NewRequest(&golfv1.RevokeApiCredentialRequest{CredentialId: grant.Credential.Id})); e != nil {
				t.Fatal(e)
			}
			if response := apiRequest(f.s, grant.Token, procedure, machineBody(t, m)); response.Code != 401 {
				t.Fatal("revoked ref credential", response.Code)
			}
		})
	}
}

package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const originalDispatchKey = "12345678-1234-4234-8234-123456789abc"

func originalWorkflowDispatchInput(f *workflowRunFixture) *golfv1.GetWorkflowDispatchRequest {
	return &golfv1.GetWorkflowDispatchRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: strconv.FormatInt(f.row.ID, 10), OwnerId: strconv.FormatInt(f.row.Owner.ID, 10), CommitId: f.commit, WorkflowPath: runWorkflowPath, IdempotencyKey: originalDispatchKey}
}
func admittedOriginalWorkflowDispatch(t *testing.T, f *workflowRunFixture) (*golfv1.GetWorkflowDispatchRequest, *golfv1.WorkflowRun) {
	t.Helper()
	f.enable(t)
	input := originalWorkflowDispatchInput(f)
	response, err := f.server.DispatchWorkflow(f.context(t), workflowRunRequest(f, &golfv1.DispatchWorkflowRequest{Repository: input.Repository, Ref: input.CommitId, WorkflowPath: input.WorkflowPath, IdempotencyKey: input.IdempotencyKey}))
	if err != nil {
		t.Fatal(err)
	}
	return input, response.Msg.Run
}
func readOriginalWorkflowDispatch(t *testing.T, f *workflowRunFixture, input *golfv1.GetWorkflowDispatchRequest) (*connect.Response[golfv1.GetWorkflowDispatchResponse], error) {
	t.Helper()
	return f.server.GetWorkflowDispatch(f.context(t), workflowRunRequest(f, input))
}

func TestWorkflowDispatchInput(t *testing.T) {
	valid := &golfv1.GetWorkflowDispatchRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "9007199254740993", OwnerId: "42", CommitId: strings.Repeat("a", 40), WorkflowPath: runWorkflowPath, IdempotencyKey: originalDispatchKey}
	_, repo, owner, e := workflowDispatchTarget(valid)
	if e != nil || repo != 9007199254740993 || owner != 42 {
		t.Fatal("exact target identity rejected", e)
	}
	for _, change := range []func(*golfv1.GetWorkflowDispatchRequest){
		func(m *golfv1.GetWorkflowDispatchRequest) { m.RepositoryId = "01" },
		func(m *golfv1.GetWorkflowDispatchRequest) { m.OwnerId = "0" },
		func(m *golfv1.GetWorkflowDispatchRequest) { m.CommitId = "main" },
		func(m *golfv1.GetWorkflowDispatchRequest) { m.CommitId = strings.Repeat("A", 40) },
		func(m *golfv1.GetWorkflowDispatchRequest) { m.WorkflowPath = "../workflow.yml" },
		func(m *golfv1.GetWorkflowDispatchRequest) { m.IdempotencyKey = "unknown" },
	} {
		m := proto.Clone(valid).(*golfv1.GetWorkflowDispatchRequest)
		change(m)
		if _, _, _, e = workflowDispatchTarget(m); e == nil {
			t.Fatal("unbound original selection accepted")
		}
	}
}

func TestWorkflowDispatchBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	path := "/rpc/golf.v1.WorkflowRunService/GetWorkflowDispatch"
	for _, origin := range []string{s.config.PublicURL, "https://foreign.invalid"} {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Connect-Protocol-Version", "1")
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		want := 401
		if origin != s.config.PublicURL {
			want = 403
		}
		if response.Code != want || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("original inspection boundary", response.Code)
		}
	}
	if response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), "/golf.v1.WorkflowRunService/GetWorkflowDispatch", "{}"); response.Code != 403 {
		t.Fatal("bearer original-key discovery admitted", response.Code)
	}
}

func TestWorkflowDispatchOriginalReadPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	input, run := admittedOriginalWorkflowDispatch(t, f)
	// A later policy disable/source move must not hide or silently follow an
	// already admitted original outcome. Inspection does not restore permission.
	if _, e := f.server.db.ExecContext(t.Context(), `UPDATE golf_execution_policies SET mode='disabled',revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE scope='instance'`); e != nil {
		t.Fatal(e)
	}
	f.mu.Lock()
	f.commit = strings.Repeat("c", 40)
	f.mu.Unlock()
	originalArchives := f.archives
	var forbiddenNativeReads atomic.Int32
	f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet || strings.Contains(r.URL.Path, "/archive/") || strings.Contains(r.URL.Path, "/git/") || strings.HasSuffix(r.URL.Path, "/commits") {
			forbiddenNativeReads.Add(1)
		}
		return http.DefaultTransport.RoundTrip(r)
	})
	for range 3 {
		receipt, e := readOriginalWorkflowDispatch(t, f, input)
		if e != nil {
			t.Fatal(e)
		}
		r := receipt.Msg
		if r.Run == nil || r.Run.Id != run.Id || r.Run.CommitId != input.CommitId || r.Run.WorkflowPath != input.WorkflowPath || r.Run.WorkflowBlobId != run.WorkflowBlobId || r.Run.SourceSha256 != run.SourceSha256 || r.Run.Version != run.Version || r.Run.CreatedAt != run.CreatedAt || r.Run.Origin != golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_MANUAL || r.Run.CanCancel || r.NativeActorId != "42" || r.RepositoryId != input.RepositoryId || r.OwnerId != input.OwnerId || r.IdempotencyKey != input.IdempotencyKey || !proto.Equal(r.Repository, input.Repository) {
			t.Fatal("original receipt changed or granted an action")
		}
		body, _ := protojson.Marshal(r)
		if bytes.Contains(body, []byte("untrusted-script")) || bytes.Contains(body, []byte("run-fixture")) || bytes.Contains(body, []byte("session_hash")) {
			t.Fatal("inspection disclosed private execution material")
		}
	}
	var count int
	if e := f.server.db.QueryRowContext(t.Context(), `SELECT count(*) FROM golf_workflow_runs`).Scan(&count); e != nil || count != 1 || f.archives != originalArchives || forbiddenNativeReads.Load() != 0 {
		t.Fatal("read created work or fetched source", e, count)
	}
	// Exercise the actual outer whitelist/Connect handler with a managed cookie.
	body, _ := protojson.Marshal(input)
	req := httptest.NewRequest(http.MethodPost, "/rpc/golf.v1.WorkflowRunService/GetWorkflowDispatch", bytes.NewReader(body))
	req.Header.Set("Origin", f.server.config.PublicURL)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Cookie", cookieName+"="+f.session.Value)
	response := httptest.NewRecorder()
	f.server.ServeHTTP(response, req)
	var received golfv1.GetWorkflowDispatchResponse
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" || protojson.Unmarshal(response.Body.Bytes(), &received) != nil || received.Run == nil || received.Run.Id != run.Id {
		t.Fatal("managed positive outer original-key transport", response.Code)
	}
}

func TestWorkflowDispatchAbsentAndIntentPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	input, _ := admittedOriginalWorkflowDispatch(t, f)
	for _, tc := range []struct {
		name   string
		code   connect.Code
		change func(*golfv1.GetWorkflowDispatchRequest)
	}{
		{"absent original", connect.CodeNotFound, func(m *golfv1.GetWorkflowDispatchRequest) { m.IdempotencyKey = "12345678-1234-4234-8234-123456789abd" }},
		{"source", connect.CodeFailedPrecondition, func(m *golfv1.GetWorkflowDispatchRequest) { m.CommitId = strings.Repeat("b", 40) }},
		{"path", connect.CodeFailedPrecondition, func(m *golfv1.GetWorkflowDispatchRequest) { m.WorkflowPath = ".github/workflows/other.yml" }},
		{"repository", connect.CodeNotFound, func(m *golfv1.GetWorkflowDispatchRequest) { m.RepositoryId = "999" }},
		{"owner", connect.CodeNotFound, func(m *golfv1.GetWorkflowDispatchRequest) { m.OwnerId = "999" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := proto.Clone(input).(*golfv1.GetWorkflowDispatchRequest)
			tc.change(m)
			r, e := readOriginalWorkflowDispatch(t, f, m)
			if r != nil || connect.CodeOf(e) != tc.code {
				t.Fatal("wrong original target returned a receipt", e)
			}
		})
	}
	// A storage failure is unavailable, never translated into absent/no-effect.
	db := f.server.db
	f.server.db = nil
	if r, e := readOriginalWorkflowDispatch(t, f, input); r != nil || connect.CodeOf(e) != connect.CodeUnavailable {
		t.Fatal("unknown storage outcome represented as absence", e)
	}
	f.server.db = db
}

func TestWorkflowDispatchOtherActorPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	input, _ := admittedOriginalWorkflowDispatch(t, f)
	f.mu.Lock()
	f.user = User{ID: 84, Login: "bob"}
	f.mu.Unlock()
	var e error
	f.session, e = f.server.createSession(t.Context(), User{ID: 84, Login: "bob"}, "pat", "run-fixture", "")
	if e != nil {
		t.Fatal(e)
	}
	originalTransport := http.DefaultTransport
	f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/v1/repos/alice/example/collaborators/bob/permission" {
			body, _ := json.Marshal(map[string]any{"permission": "write", "user": User{ID: 84, Login: "bob"}})
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
		}
		if r.URL.Path == "/api/v1/repos/alice/example/collaborators/bob" {
			return &http.Response{StatusCode: 204, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		}
		return originalTransport.RoundTrip(r)
	})
	if r, e := readOriginalWorkflowDispatch(t, f, input); r != nil || connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("another ordinary writer discovered the original actor's key", e)
	}
}

func TestWorkflowDispatchAuthorityFencesPostgres(t *testing.T) {
	for _, kind := range []string{"permission", "transfer", "replacement", "logout", "reset", "late permission", "late session", "late transfer"} {
		t.Run(kind, func(t *testing.T) {
			f := newWorkflowRunFixture(t)
			if kind == "reset" {
				if _, e := ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "run-fixture"}); e != nil {
					t.Fatal(e)
				}
				var e error
				f.session, e = f.server.loginLocalSession(t.Context(), "alice", localTestPassword, "")
				if e != nil {
					t.Fatal(e)
				}
			}
			input, _ := admittedOriginalWorkflowDispatch(t, f)
			change := func() {
				if strings.Contains(kind, "session") || kind == "logout" {
					hash, e := f.server.authSessionHash(t.Context(), f.session.Value, nil)
					if e != nil {
						t.Fatal(e)
					}
					if _, e = f.server.db.ExecContext(t.Context(), `DELETE FROM golf_sessions WHERE token_hash=$1`, hash); e != nil {
						t.Fatal(e)
					}
					return
				}
				if kind == "reset" {
					if _, e := ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "reset-password", LocalAccountInput{Username: "alice", Password: localTestPassword}); e != nil {
						t.Fatal(e)
					}
					return
				}
				f.mu.Lock()
				defer f.mu.Unlock()
				if strings.Contains(kind, "permission") {
					f.permission = "read"
				} else if kind == "replacement" {
					f.row.ID++
				} else {
					f.row.Owner = &User{ID: 77, Login: "alice"}
				}
			}
			if strings.HasPrefix(kind, "late") {
				var reads atomic.Int32
				f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
					if r.URL.Path == "/api/v1/repos/alice/example" && reads.Add(1) == 2 {
						change()
					}
					return http.DefaultTransport.RoundTrip(r)
				})
			} else {
				change()
			}
			receipt, e := readOriginalWorkflowDispatch(t, f, input)
			want := connect.CodeNotFound
			if strings.Contains(kind, "permission") {
				want = connect.CodePermissionDenied
			}
			if strings.Contains(kind, "session") || kind == "logout" || kind == "reset" {
				want = connect.CodeUnauthenticated
			}
			if receipt != nil || connect.CodeOf(e) != want {
				t.Fatal("private original receipt escaped authority loss", kind, e)
			}
		})
	}
}

func TestWorkflowDispatchManualOriginMatch(t *testing.T) {
	m := &golfv1.GetWorkflowDispatchRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "12", OwnerId: "42", CommitId: strings.Repeat("a", 40), WorkflowPath: runWorkflowPath, IdempotencyKey: originalDispatchKey}
	r := workflowRunRecord{Origin: "manual", RepositoryOwner: "alice", RepositoryName: "example", RepositoryID: 12, OwnerID: 42, UserID: 2, CommitID: m.CommitId, WorkflowPath: m.WorkflowPath, IdempotencyKey: m.IdempotencyKey, InputHash: workflowIntentHash(repositoryKey{"alice", "example"}, m.CommitId, m.WorkflowPath, 12, 42)}
	if !workflowDispatchMatches(r, repositoryKey{"alice", "example"}, 12, 42, 2, m) {
		t.Fatal("own original identity refused")
	}
	r.Origin = "push"
	if workflowDispatchMatches(r, repositoryKey{"alice", "example"}, 12, 42, 2, m) {
		t.Fatal("push outcome adopted as manual")
	}
	r.Origin = "manual"
	r.InputHash = workflowIntentHash(repositoryKey{"alice", "example"}, "main", m.WorkflowPath, 12, 42)
	if workflowDispatchMatches(r, repositoryKey{"alice", "example"}, 12, 42, 2, m) {
		t.Fatal("resolved SHA substituted for an original named-ref intent")
	}
}

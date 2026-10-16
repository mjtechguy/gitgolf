package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

const runWorkflowPath = ".github/workflows/check.yml"

func workflowRunTar(t *testing.T, headers []*tar.Header, contents [][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	for i, h := range headers {
		if h.Typeflag == tar.TypeReg || h.Typeflag == tar.TypeRegA {
			h.Size = int64(len(contents[i]))
		}
		if err := writer.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if len(contents[i]) > 0 {
			if _, err := writer.Write(contents[i]); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
func TestWorkflowRunSnapshotNormalization(t *testing.T) {
	workflow := []byte(workflowActionsFixture)
	blob := workflowTestBlob(workflow)
	commit := strings.Repeat("a", 40)
	source := workflowRunTar(t, []*tar.Header{{Name: "pax_global_header", Typeflag: tar.TypeXGlobalHeader, PAXRecords: map[string]string{"comment": commit}, Format: tar.FormatPAX}, {Name: "example/", Typeflag: tar.TypeDir}, {Name: "example/" + runWorkflowPath, Typeflag: tar.TypeReg, Mode: 06777, Uid: 1234, Gid: 777, Uname: "untrusted"}, {Name: "example/tool.sh", Typeflag: tar.TypeReg, Mode: 04755}}, [][]byte{nil, nil, workflow, []byte("echo source")})
	normalized, err := normalizeWorkflowSource(bytes.NewReader(source), commit, runWorkflowPath, blob, workflow)
	if err != nil {
		t.Fatal(err)
	}
	reader := tar.NewReader(bytes.NewReader(normalized))
	first, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	if first.Name != runWorkflowPath || first.Mode != 0755 || first.Uid != 0 || first.Gid != 0 || first.Uname != "" || first.Linkname != "" || first.ModTime.Unix() != 0 {
		t.Fatal("native root/ownership/privilege metadata escaped normalization")
	}
	data, _ := io.ReadAll(reader)
	if !bytes.Equal(data, workflow) {
		t.Fatal("workflow bytes changed")
	}
	second, _ := reader.Next()
	if second.Name != "tool.sh" || second.Mode != 0755 {
		t.Fatal("executable bit was not preserved safely")
	}
	for _, tc := range []struct {
		name   string
		header *tar.Header
		data   []byte
	}{
		{"traversal", &tar.Header{Name: "example/../escape", Typeflag: tar.TypeReg}, nil},
		{"absolute", &tar.Header{Name: "/example/file", Typeflag: tar.TypeReg}, nil},
		{"backslash", &tar.Header{Name: "example/bad\\file", Typeflag: tar.TypeReg}, nil},
		{"symlink", &tar.Header{Name: "example/link", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}, nil},
		{"hardlink", &tar.Header{Name: "example/link", Typeflag: tar.TypeLink, Linkname: runWorkflowPath}, nil},
		{"device", &tar.Header{Name: "example/device", Typeflag: tar.TypeChar}, nil},
		{"Git metadata", &tar.Header{Name: "example/.git/config", Typeflag: tar.TypeReg}, nil},
		{"different root", &tar.Header{Name: "other/file", Typeflag: tar.TypeReg}, nil},
		{"duplicate", &tar.Header{Name: "example/" + runWorkflowPath, Typeflag: tar.TypeReg}, workflow},
		{"parent file alias", &tar.Header{Name: "example/.github", Typeflag: tar.TypeReg}, nil},
		{"oversize file", &tar.Header{Name: "example/large", Typeflag: tar.TypeReg}, make([]byte, maxWorkflowSourceFile+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := workflowRunTar(t, []*tar.Header{{Name: "example/" + runWorkflowPath, Typeflag: tar.TypeReg}, tc.header}, [][]byte{workflow, tc.data})
			if result, err := normalizeWorkflowSource(bytes.NewReader(bad), commit, runWorkflowPath, blob, workflow); result != nil || !errors.Is(err, errWorkflowSource) {
				t.Fatal("unsafe archive produced a snapshot")
			}
		})
	}
	if result, err := normalizeWorkflowSource(bytes.NewReader(source), commit, runWorkflowPath, blob, []byte("different bytes")); result != nil || err == nil {
		t.Fatal("archive did not bind the verified workflow")
	}
	concatenated := append(append([]byte{}, source...), source...)
	if result, err := normalizeWorkflowSource(bytes.NewReader(concatenated), commit, runWorkflowPath, blob, workflow); result != nil || err == nil {
		t.Fatal("concatenated archive accepted")
	}
}
func TestWorkflowRunSnapshotBounds(t *testing.T) {
	workflow := []byte(workflowActionsFixture)
	blob := workflowTestBlob(workflow)
	commit := strings.Repeat("a", 40)
	headers := []*tar.Header{{Name: "example/" + runWorkflowPath, Typeflag: tar.TypeReg}}
	contents := [][]byte{workflow}
	for i := 0; i < maxWorkflowSourceEntries; i++ {
		headers = append(headers, &tar.Header{Name: fmt.Sprintf("example/file-%d", i), Typeflag: tar.TypeReg})
		contents = append(contents, nil)
	}
	if data, err := normalizeWorkflowSource(bytes.NewReader(workflowRunTar(t, headers, contents)), commit, runWorkflowPath, blob, workflow); data != nil || err == nil {
		t.Fatal("overfull snapshot was silently truncated")
	}
	headers = []*tar.Header{{Name: "example/" + runWorkflowPath, Typeflag: tar.TypeReg}, {Name: "example/a", Typeflag: tar.TypeReg}, {Name: "example/b", Typeflag: tar.TypeReg}}
	contents = [][]byte{workflow, make([]byte, maxWorkflowSourceFile), make([]byte, maxWorkflowSourceFile)}
	if data, err := normalizeWorkflowSource(bytes.NewReader(workflowRunTar(t, headers, contents)), commit, runWorkflowPath, blob, workflow); data != nil || err == nil {
		t.Fatal("aggregate snapshot bound was ignored")
	}
}

func TestWorkflowRunBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"DispatchWorkflow", "GetWorkflowRun", "ListWorkflowRuns", "CancelWorkflowRun", "GetWorkflowRunLogs"} {
		for _, origin := range []string{s.config.PublicURL, "https://foreign.invalid"} {
			req := httptest.NewRequest("POST", "/rpc/golf.v1.WorkflowRunService/"+method, strings.NewReader("{}"))
			req.Header.Set("Origin", origin)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, req)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if rec.Code != want || rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("workflow browser boundary failed", method, rec.Code)
			}
		}
		if rec := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), "/golf.v1.WorkflowRunService/"+method, "{}"); rec.Code != 403 {
			t.Fatal("delegated credentials reached workflow procedure", method)
		}
	}
}

type workflowRunFixture struct {
	server             *Server
	session            loginResult
	mu                 sync.Mutex
	row                forgeRepositorySettings
	user               User
	permission, commit string
	workflow           []byte
	archives           int
	onArchive          func()
	denied             bool
	repositoryStatus   int
	redirectReads      int
}

func newWorkflowRunFixture(t *testing.T, paths ...string) *workflowRunFixture {
	t.Helper()
	workflowPath := runWorkflowPath
	if len(paths) > 0 {
		workflowPath = paths[0]
	}
	db := testDatabase(t)
	f := &workflowRunFixture{row: settingsFixtureRow(), user: User{ID: 42, Login: "alice"}, permission: "owner", commit: strings.Repeat("a", 40), workflow: []byte(workflowActionsFixture)}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		write := func(v any) { json.NewEncoder(w).Encode(v) }
		if r.URL.Path == "/api/v1/version" {
			write(map[string]string{"version": "1.27.3"})
			return
		}
		if r.Header.Get("Authorization") != "token run-fixture" && r.Header.Get("Authorization") != "Bearer run-fixture" {
			w.WriteHeader(401)
			return
		}
		if f.denied {
			w.WriteHeader(404)
			return
		}
		base := "/api/v1/repos/alice/example"
		if r.URL.Path == "/api/v1/repos/moved/example" {
			f.redirectReads++
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if r.URL.Path == base && f.repositoryStatus != 0 {
			w.Header().Set("Location", "/api/v1/repos/moved/example")
			w.WriteHeader(f.repositoryStatus)
			return
		}
		switch r.URL.Path {
		case "/api/v1/user":
			write(f.user)
		case base, "/api/v1/repositories/" + strconv.FormatInt(f.row.ID, 10):
			write(f.row)
		case "/api/v1/users/search":
			write(map[string]any{"ok": true, "data": []User{*f.row.Owner}})
		case base + "/collaborators/alice/permission":
			write(map[string]any{"permission": f.permission, "user": f.user})
		case base + "/collaborators/alice":
			w.WriteHeader(204)
		case base + "/commits":
			commit := f.commit
			if objectID.MatchString(r.URL.Query().Get("sha")) {
				commit = r.URL.Query().Get("sha")
			}
			write([]map[string]string{{"sha": commit}})
		default:
			commit := f.commit
			if strings.HasPrefix(r.URL.Path, base+"/git/commits/") {
				commit = strings.TrimPrefix(r.URL.Path, base+"/git/commits/")
			}
			objects := workflowSourceObjects(commit, map[string]string{workflowPath: string(f.workflow)}, nil)
			if objects.serve(w, r, base) {
				return
			}
			if strings.HasPrefix(r.URL.Path, base+"/archive/") {
				f.archives++
				if f.onArchive != nil {
					f.onArchive()
				}
				source := workflowRunTar(t, []*tar.Header{{Name: "example/" + workflowPath, Typeflag: tar.TypeReg, Mode: 0644}, {Name: "example/README.md", Typeflag: tar.TypeReg, Mode: 0644}}, [][]byte{f.workflow, []byte("ordinary source")})
				var compressed bytes.Buffer
				gz := gzip.NewWriter(&compressed)
				gz.Write(source)
				gz.Close()
				w.Header().Set("Content-Type", "application/gzip")
				w.Write(compressed.Bytes())
			} else {
				w.WriteHeader(404)
			}
		}
	}))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.RunnerKeysJSON = `{"fixture":"` + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)) + `"}`
	config.RunnerImagesJSON = `{"linux":"example/build@sha256:` + strings.Repeat("b", 64) + `"}`
	var err error
	f.server, err = New(config, db)
	if err != nil {
		t.Fatal(err)
	}
	f.session, err = f.server.createSession(t.Context(), f.user, "pat", "run-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *workflowRunFixture) context(t *testing.T) context.Context {
	return context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "run-fixture"})
}
func workflowRunRequest[T any](f *workflowRunFixture, value *T) *connect.Request[T] {
	req := connect.NewRequest(value)
	req.Header().Set("Cookie", cookieName+"="+f.session.Value)
	return req
}
func (f *workflowRunFixture) enable(t *testing.T) {
	t.Helper()
	for _, scope := range []struct {
		name, id string
		owner    int64
	}{{"instance", "instance", 0}, {"repository", strconv.FormatInt(f.row.ID, 10), 42}} {
		_, err := f.server.db.ExecContext(t.Context(), `INSERT INTO golf_execution_policies(forge_url,scope,scope_id,owner_id,mode,manual_dispatch_enabled,allow_all_workflows,revision,revocation_epoch) VALUES($1,$2,$3,$4,'all',true,true,1,1) ON CONFLICT(forge_url,scope,scope_id) DO UPDATE SET mode='all',manual_dispatch_enabled=true,allow_all_workflows=true,revision=golf_execution_policies.revision+1,revocation_epoch=golf_execution_policies.revocation_epoch+1`, f.server.config.ForgeURL, scope.name, scope.id, scope.owner)
		if err != nil {
			t.Fatal(err)
		}
	}
}
func (f *workflowRunFixture) dispatch(t *testing.T, key string) (*connect.Response[golfv1.DispatchWorkflowResponse], error) {
	return f.server.DispatchWorkflow(f.context(t), workflowRunRequest(f, &golfv1.DispatchWorkflowRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, WorkflowPath: runWorkflowPath, IdempotencyKey: key}))
}

func TestWorkflowRunDurableIntentPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	key := "12345678-1234-4234-8234-123456789abc"
	if _, err := f.dispatch(t, key); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("missing policy admitted execution", err)
	}
	if f.archives != 0 {
		t.Fatal("disabled policy fetched private archive")
	}
	f.enable(t)
	response, err := f.dispatch(t, key)
	if err != nil {
		t.Fatal(err)
	}
	run := response.Msg.Run
	if run.State != golfv1.WorkflowRunState_WORKFLOW_RUN_STATE_QUEUED || run.CommitId != f.commit || !run.CanCancel || run.Version != "1" || run.SourceSha256 == "" {
		t.Fatal("queue receipt missing exact source/status")
	}
	f.mu.Lock()
	f.commit = strings.Repeat("c", 40)
	f.mu.Unlock()
	again, err := f.dispatch(t, key)
	if err != nil || again.Msg.Run.Id != run.Id || again.Msg.Run.CommitId != run.CommitId || f.archives != 1 {
		t.Fatal("same intent silently followed advanced branch", err)
	}
	changed := workflowRunRequest(f, &golfv1.DispatchWorkflowRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, Ref: "main", WorkflowPath: runWorkflowPath, IdempotencyKey: key})
	if _, err = f.server.DispatchWorkflow(f.context(t), changed); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("key accepted changed inputs", err)
	}
	var payload, archive []byte
	var count int
	if err = f.server.db.QueryRowContext(t.Context(), `SELECT plan,source_archive FROM golf_workflow_runs WHERE id=$1`, run.Id).Scan(&payload, &archive); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(payload, []byte("untrusted-script")) || len(archive) == 0 {
		t.Fatal("execution payload not persisted")
	}
	if err = f.server.db.QueryRowContext(t.Context(), `SELECT count(*) FROM golf_workflow_runs`).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate run", err)
	}
	status, err := f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: run.Id}))
	if err != nil {
		t.Fatal(err)
	}
	public, _ := json.Marshal(status.Msg)
	if bytes.Contains(public, []byte("untrusted-script")) || bytes.Contains(public, []byte("session_hash")) {
		t.Fatal("private execution payload leaked into public status")
	}
}
func TestWorkflowRunConcurrentDispatchAndCancelPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	key := "12345678-1234-4234-8234-123456789abd"
	var wg sync.WaitGroup
	results := make(chan *golfv1.WorkflowRun, 2)
	failures := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := f.dispatch(t, key)
			if e != nil {
				failures <- e
			} else {
				results <- r.Msg.Run
			}
		}()
	}
	wg.Wait()
	close(results)
	close(failures)
	for e := range failures {
		t.Fatal(e)
	}
	id := ""
	for r := range results {
		if id != "" && id != r.Id {
			t.Fatal("concurrent duplicate assignment intent")
		}
		id = r.Id
	}
	if _, err := f.server.CancelWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.CancelWorkflowRunRequest{RunId: id, ExpectedVersion: "2"})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("stale cancellation accepted", err)
	}
	cancelled, err := f.server.CancelWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.CancelWorkflowRunRequest{RunId: id, ExpectedVersion: "1"}))
	if err != nil || cancelled.Msg.Run.State != golfv1.WorkflowRunState_WORKFLOW_RUN_STATE_CANCELLED || cancelled.Msg.Run.Version != "2" || cancelled.Msg.Run.CanCancel {
		t.Fatal("cancel failed to fence run", err)
	}
	if _, err = f.server.CancelWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.CancelWorkflowRunRequest{RunId: id, ExpectedVersion: "2"})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("terminal run mutated", err)
	}
}
func TestWorkflowRunReadLogsAndRevocationPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	r, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abe")
	if err != nil {
		t.Fatal(err)
	}
	id := r.Msg.Run.Id
	for sequence := 1; sequence <= 17; sequence++ {
		if _, err = f.server.db.ExecContext(t.Context(), `INSERT INTO golf_workflow_run_logs(run_id,sequence,text) VALUES($1,$2,$3)`, id, sequence, fmt.Sprintf("literal log %d", sequence)); err != nil {
			t.Fatal(err)
		}
	}
	f.mu.Lock()
	f.permission = "read"
	f.mu.Unlock()
	status, err := f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: id}))
	if err != nil || status.Msg.Run.CanCancel {
		t.Fatal("reader status authority wrong", err)
	}
	if _, err = f.server.CancelWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.CancelWorkflowRunRequest{RunId: id, ExpectedVersion: "1"})); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("reader cancelled run", err)
	}
	logs, err := f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: id}))
	if err != nil || len(logs.Msg.Logs) != 16 || !logs.Msg.HasMore {
		t.Fatal("log page did not preserve bound", err)
	}
	last, err := f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: id, AfterSequence: 16}))
	if err != nil || len(last.Msg.Logs) != 1 || last.Msg.HasMore {
		t.Fatal("log continuation failed", err)
	}
	list, err := f.server.ListWorkflowRuns(f.context(t), workflowRunRequest(f, &golfv1.ListWorkflowRunsRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}}))
	if err != nil || len(list.Msg.Runs) != 1 {
		t.Fatal("run listing failed", err)
	}
	f.mu.Lock()
	f.row.Owner = &User{ID: 77, Login: "alice"}
	f.mu.Unlock()
	if _, err = f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: id})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("transfer exposed old run", err)
	}
	f.mu.Lock()
	f.row.Owner = &User{ID: 42, Login: "alice"}
	f.denied = true
	f.mu.Unlock()
	if _, err = f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: id})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("revoked private logs disclosed", err)
	}
}
func TestWorkflowRunSourceWaitRechecksPostgres(t *testing.T) {
	for _, kind := range []string{"policy", "session", "transfer", "permission", "archived", "mirror"} {
		t.Run(kind, func(t *testing.T) {
			f := newWorkflowRunFixture(t)
			f.enable(t)
			f.onArchive = func() {
				var err error
				if kind == "archived" {
					value := true
					f.row.Archived = &value
				} else if kind == "mirror" {
					value := true
					f.row.Mirror = &value
				} else if kind == "transfer" {
					f.row.Owner = &User{ID: 77, Login: "alice"}
				} else if kind == "permission" {
					f.permission = "read"
				} else if kind == "policy" {
					_, err = f.server.db.ExecContext(t.Context(), `UPDATE golf_execution_policies SET mode='disabled',revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE scope='instance'`)
				} else {
					hash, _ := sessionHash(f.session.Value)
					_, err = f.server.db.ExecContext(t.Context(), `DELETE FROM golf_sessions WHERE token_hash=$1`, hash)
				}
				if err != nil {
					t.Error(err)
				}
			}
			if _, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abf"); err == nil {
				t.Fatal("source wait retained revoked execution authority")
			}
			var count int
			if err := f.server.db.QueryRowContext(t.Context(), `SELECT count(*) FROM golf_workflow_runs`).Scan(&count); err != nil || count != 0 {
				t.Fatal("revoked dispatch persisted executable run", err)
			}
		})
	}
}
func TestWorkflowRunArchivedMirrorDenyPostgres(t *testing.T) {
	for _, kind := range []string{"archived", "mirror"} {
		t.Run(kind, func(t *testing.T) {
			f := newWorkflowRunFixture(t)
			f.enable(t)
			f.mu.Lock()
			value := true
			if kind == "archived" {
				f.row.Archived = &value
			} else {
				f.row.Mirror = &value
			}
			f.mu.Unlock()
			if _, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc"); connect.CodeOf(err) != connect.CodePermissionDenied {
				t.Fatal("noneditable native repository admitted dispatch", err)
			}
			if f.archives != 0 {
				t.Fatal("denied repository fetched archive")
			}
			var count int
			if err := f.server.db.QueryRowContext(t.Context(), "SELECT count(*) FROM golf_workflow_runs").Scan(&count); err != nil || count != 0 {
				t.Fatal("denied repository queued execution", err)
			}
		})
	}
}
func TestWorkflowRunListingPagesPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	for _, key := range []string{"12345678-1234-4234-8234-123456789abc", "12345678-1234-4234-8234-123456789abd"} {
		if _, err := f.dispatch(t, key); err != nil {
			t.Fatal(err)
		}
	}
	list := func(page uint32) *golfv1.ListWorkflowRunsResponse {
		r, err := f.server.ListWorkflowRuns(f.context(t), workflowRunRequest(f, &golfv1.ListWorkflowRunsRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, Page: &golfv1.PageRequest{Page: page, Limit: 1}}))
		if err != nil {
			t.Fatal(err)
		}
		return r.Msg
	}
	first, last := list(1), list(2)
	if len(first.Runs) != 1 || first.Page.NextPage != 2 || len(last.Runs) != 1 || last.Page.NextPage != 0 || first.Runs[0].Id == last.Runs[0].Id {
		t.Fatal("run pagination fabricated completion or repeated rows")
	}
}

func TestWorkflowRunProjection(t *testing.T) {
	r := workflowRunRecord{ID: "12345678-1234-4234-8234-123456789abc", RepositoryID: 9007199254740993, OwnerID: 42, State: "queued", Version: 1, CreatedAt: time.Unix(1, 0)}
	wire := wireWorkflowRun(r, true)
	if wire.RepositoryId != "9007199254740993" || !wire.CanCancel || wire.State != golfv1.WorkflowRunState_WORKFLOW_RUN_STATE_QUEUED {
		t.Fatal("projection lost identity/state")
	}
	r.State = "lost"
	if wireWorkflowRun(r, true).CanCancel {
		t.Fatal("terminal run exposed cancellation")
	}
}

func TestWorkflowRunRecoveryQuarantinePostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	ids := make([]string, 0, 3)
	for _, key := range []string{"12345678-1234-4234-8234-123456789abc", "12345678-1234-4234-8234-123456789abd", "12345678-1234-4234-8234-123456789abe"} {
		response, err := f.dispatch(t, key)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, response.Msg.Run.Id)
	}
	// Only Golf's disposable test database is changed. No native forge writes.
	if _, err := f.server.db.ExecContext(t.Context(), `UPDATE golf_workflow_runs SET state='running',version=2,started_at=clock_timestamp(),attempt_id=$2,runner_id='qualified-test-runner',lease_token_hash=$3,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1`, ids[1], strings.Repeat("b", 32), bytes.Repeat([]byte{1}, 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.db.ExecContext(t.Context(), `UPDATE golf_workflow_runs SET state='succeeded',version=3,started_at=clock_timestamp(),finished_at=clock_timestamp(),exit_code=0,reason='Completed before backup' WHERE id=$1`, ids[2]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.db.ExecContext(t.Context(), `INSERT INTO golf_workflow_run_logs(run_id,sequence,text) VALUES($1,1,'preserved completion evidence')`, ids[2]); err != nil {
		t.Fatal(err)
	}
	before, err := f.server.loadWorkflowRun(t.Context(), ids[2])
	if err != nil {
		t.Fatal(err)
	}
	result, err := InvalidateRestoredSessions(t.Context(), f.server.db, strings.Repeat("c", 32))
	if err != nil || result.SessionsCount != 1 {
		t.Fatal("restored authority quarantine failed", err)
	}
	for i, id := range ids[:2] {
		row, err := f.server.loadWorkflowRun(t.Context(), id)
		if err != nil || row.State != "cancelled" || row.Version != int64(i+2) || !row.FinishedAt.Valid || len(row.LeaseTokenHash) != 0 || !strings.Contains(row.Reason, "no automatic replay") {
			t.Fatal("restored executable intent retained assignment capability", err)
		}
	}
	after, err := f.server.loadWorkflowRun(t.Context(), ids[2])
	if err != nil || after.State != before.State || after.Version != before.Version || after.FinishedAt != before.FinishedAt || after.ExitCode != before.ExitCode || after.Reason != before.Reason || after.CommitID != before.CommitID || after.SourceSHA256 != before.SourceSHA256 {
		t.Fatal("quarantine rewrote completed evidence", err)
	}
	var log string
	if err := f.server.db.QueryRowContext(t.Context(), `SELECT text FROM golf_workflow_run_logs WHERE run_id=$1 AND sequence=1`, ids[2]).Scan(&log); err != nil || log != "preserved completion evidence" {
		t.Fatal("quarantine removed completion logs", err)
	}
	if _, err := f.server.sessionCredential(t.Context(), f.session.Value); !errors.Is(err, errUnauthenticated) {
		t.Fatal("restored source session remained valid", err)
	}
	if _, err := InvalidateRestoredSessions(t.Context(), f.server.db, strings.Repeat("c", 32)); err != nil {
		t.Fatal(err)
	}
	again, err := f.server.loadWorkflowRun(t.Context(), ids[1])
	if err != nil || again.Version != 3 {
		t.Fatal("repeated quarantine replayed terminal cancellation", err)
	}
}

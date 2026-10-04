package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

func actionCall(s *Server, login loginResult, method string, body any) *httptest.ResponseRecorder {
	data, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", "/rpc/golf.v1.ActionRunService/"+method, bytes.NewReader(data))
	r.Header.Set("Origin", s.config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	r.AddCookie(s.sessionCookie(login.Value, login.Expires, 3600))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func actionSelection() map[string]string {
	return map[string]string{"owner": "alice", "name": "example"}
}
func actionRead(t *testing.T, f *workflowRunFixture, login loginResult, body map[string]any) *golfv1.ListActionRunsResponse {
	t.Helper()
	w := actionCall(f.server, login, "ListActionRuns", body)
	if w.Code != 200 {
		t.Fatalf("Action inventory failed %d: %s", w.Code, w.Body)
	}
	var result golfv1.ListActionRunsResponse
	if e := protojson.Unmarshal(w.Body.Bytes(), &result); e != nil {
		t.Fatal(e)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("Action response cacheable")
	}
	return &result
}

type actionFixture struct {
	f                    *workflowRunFixture
	login                loginResult
	user, foreign        int64
	connection, reviewer string
	hash                 []byte
	at                   time.Time
}

func newActionFixture(t *testing.T) *actionFixture {
	t.Helper()
	f := newWorkflowRunFixture(t)
	f.mu.Lock()
	f.row.ID = 11
	f.mu.Unlock()
	if _, e := ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "run-fixture", IsInstanceAdmin: true}); e != nil {
		t.Fatal(e)
	}
	login, e := f.server.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	x := &actionFixture{f: f, login: login, connection: uuid.NewString(), reviewer: uuid.NewString(), at: time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)}
	x.hash, _ = sessionHash(login.Value)
	if e = f.server.db.QueryRow(`SELECT user_id FROM golf_local_accounts WHERE username='alice'`).Scan(&x.user); e != nil {
		t.Fatal(e)
	}
	if e = f.server.db.QueryRow(`INSERT INTO golf_users(forge_url,forge_user_id,login) VALUES($1,84,'bob') RETURNING id`, f.server.config.GiteaURL).Scan(&x.foreign); e != nil {
		t.Fatal(e)
	}
	if _, e = f.server.db.Exec(`INSERT INTO golf_codex_connections(id,user_id,state,forge_url,harness,provider,name) VALUES($1,$2,'CONNECTED',$3,'codex','openai','fixture')`, x.connection, x.user, f.server.config.GiteaURL); e != nil {
		t.Fatal(e)
	}
	if _, e = f.server.db.Exec(`INSERT INTO golf_reviewers(id,forge_url,repository_id,owner_id,repository_owner,repository_name,sponsor_user_id,sponsor_native_id,local_account_id,local_version,publisher_id,config,enabled,expires_at) SELECT $1,$2,11,42,'alice','example',$3,42,id,1,43,'{}',true,clock_timestamp()+interval '1 day' FROM golf_local_accounts WHERE username='alice'`, x.reviewer, f.server.config.GiteaURL, x.user); e != nil {
		t.Fatal(e)
	}
	return x
}
func (x *actionFixture) task(t *testing.T, id string, repo, user int64, at time.Time) {
	t.Helper()
	_, e := x.f.server.db.Exec(`INSERT INTO golf_agent_tasks(id,forge_url,repository_id,owner_id,repository_owner,repository_name,user_id,native_user_id,session_hash,connection_id,connection_version,commit_id,source_archive,config,policy_fingerprint,idempotency_key,input_hash,created_at,summary,patch,attempt_id)
 VALUES($1,$2,$3,42,'alice','example',$4,42,$5,$6,1,$7,$8,$9,'fingerprint',$10,$11,$12,'private-task-summary','private-task-patch',$13)`, id, x.f.server.config.GiteaURL, repo, user, x.hash, x.connection, strings.Repeat("a", 40), []byte("private-task-archive"), []byte(`{"model_id":"actual-model","instructions":"private-instructions"}`), uuid.NewString(), bytes.Repeat([]byte{8}, 32), at, strings.Repeat("e", 32))
	if e != nil {
		t.Fatal(e)
	}
}
func (x *actionFixture) workflow(t *testing.T, id string, repo int64, path string, at time.Time) {
	t.Helper()
	plan, _ := json.Marshal(workflowExecutionPlan{JobID: "actual-job", JobName: "Actual job", Steps: []workflowExecutionStep{{Name: "Actual step", Run: "private-command"}}})
	_, e := x.f.server.db.Exec(`INSERT INTO golf_workflow_runs(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,user_id,session_hash,commit_id,workflow_path,blob_id,format,plan,source_archive,source_sha256,policy_epochs,idempotency_key,input_hash,created_at,attempt_id)
 VALUES($1,$2,$3,42,'alice','example',false,$4,$5,$6,$7,$8,1,$9,$10,$11,'[]',$12,$13,$14,$15)`, id, x.f.server.config.GiteaURL, repo, x.user, x.hash, strings.Repeat("a", 40), path, strings.Repeat("b", 40), plan, []byte("private-workflow-archive"), strings.Repeat("c", 64), uuid.NewString(), bytes.Repeat([]byte{9}, 32), at, strings.Repeat("d", 32))
	if e != nil {
		t.Fatal(e)
	}
}
func (x *actionFixture) review(t *testing.T, id, task string, at time.Time) {
	t.Helper()
	_, e := x.f.server.db.Exec(`INSERT INTO golf_reviewer_runs(id,reviewer_id,reviewer_revision,pull_number,base_commit,head_commit,trigger,intent,diff,publisher_id,state,created_at,task_id,findings)
 VALUES($1,$2,1,7,$3,$4,'pr_comment',$5,'private-retained-diff',43,'queued',$6,NULLIF($7,'')::uuid,'{"summary":"actual finding","findings":[]}')`, id, x.reviewer, strings.Repeat("b", 40), strings.Repeat("a", 40), "manual/"+uuid.NewString(), at, task)
	if e != nil {
		t.Fatal(e)
	}
}
func TestActionRunBoundaries(t *testing.T) {
	s, e := New(testConfig("http://native.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, method := range []string{"ListActionRuns", "GetActionRun"} {
		for _, origin := range []string{s.config.PublicURL, "https://foreign.invalid"} {
			r := httptest.NewRequest("POST", "/rpc/golf.v1.ActionRunService/"+method, strings.NewReader("bad json"))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", origin)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want {
				t.Fatal("auth/origin decoded body", w.Code)
			}
		}
	}
	c := actionCursor{Version: 1, Repository: 11, Owner: 42, User: 9, Limit: 25, At: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixMicro(), Kind: 2, ID: uuid.NewString()}
	if actual, e := decodeActionCursor(encodeActionCursor(c)); e != nil || actual != c {
		t.Fatal("cursor roundtrip", e)
	}
	for _, raw := range []string{"!=", strings.Repeat("x", 2049), base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"unknown":1}`)), encodeActionCursor(actionCursor{Version: 2}), encodeActionCursor(actionCursor{Version: 1, Kind: 4, ID: c.ID})} {
		if _, e := decodeActionCursor(raw); e == nil {
			t.Fatal("malformed cursor accepted")
		}
	}
	if actionAttempt("owned") != "" || actionAttempt(strings.Repeat("f", 32)) != strings.Repeat("f", 32) {
		t.Fatal("invented/invalid attempt exposed")
	}
}

func TestActionRunMixedPaginationPostgres(t *testing.T) {
	x := newActionFixture(t)
	f := x.f
	// Same timestamps and even identical cross-family UUIDs need the kind key.
	shared := "10000000-0000-4000-8000-000000000001"
	second := "20000000-0000-4000-8000-000000000002"
	review := "30000000-0000-4000-8000-000000000003"
	linked := uuid.NewString()
	x.workflow(t, shared, 11, ".github/workflows/a.yml", x.at)
	x.task(t, shared, 11, x.user, x.at)
	x.task(t, linked, 11, x.user, x.at)
	x.review(t, review, linked, x.at)
	x.workflow(t, second, 11, ".gitlab-ci.yml", x.at)
	x.task(t, uuid.NewString(), 11, x.foreign, x.at.Add(time.Hour))
	x.task(t, uuid.NewString(), 99, x.user, x.at.Add(time.Hour))
	x.workflow(t, uuid.NewString(), 99, ".github/workflows/foreign.yml", x.at.Add(time.Hour))
	body := map[string]any{"repository": actionSelection(), "repositoryId": "11", "limit": 2}
	first := actionRead(t, f, x.login, body)
	if len(first.Runs) != 2 || first.Runs[0].Ref.Kind != 3 || first.Runs[0].Ref.Id != review || first.Runs[0].ChildTask == nil || first.Runs[0].ChildTask.Id != linked || first.Runs[1].Ref.Kind != 2 || first.NextCursor == "" {
		t.Fatal("mixed kind/tie ordering or actual child lost")
	}
	// Insert a newer row between pages; it must not enter this continuation.
	x.workflow(t, uuid.NewString(), 11, ".github/workflows/new.yml", x.at.Add(time.Hour))
	body["cursor"] = first.NextCursor
	secondPage := actionRead(t, f, x.login, body)
	if len(secondPage.Runs) != 2 || secondPage.Runs[0].Ref.Id != second || secondPage.Runs[1].Ref.Id != shared || secondPage.NextCursor != "" {
		t.Fatal("cursor skipped/duplicated tied workflow rows")
	}
	raw, _ := protojson.Marshal(first)
	for _, secret := range []string{"private-task-summary", "private-task-patch", "private-task-archive", "private-workflow-archive", "private-command", "private-retained-diff", "private-instructions", "actual finding"} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatal("metadata inventory loaded private payload")
		}
	}
	for _, change := range []map[string]any{{"limit": 1}, {"kindFilter": "ACTION_RUN_KIND_WORKFLOW"}, {"workflowPath": ".github/workflows/a.yml"}, {"repositoryId": "99"}} {
		copy := map[string]any{}
		for k, v := range body {
			copy[k] = v
		}
		for k, v := range change {
			copy[k] = v
		}
		if w := actionCall(f.server, x.login, "ListActionRuns", copy); w.Code == 200 {
			t.Fatal("cursor selection reuse allowed")
		}
	}
	delete(body, "cursor")
	body["kindFilter"] = "ACTION_RUN_KIND_WORKFLOW"
	body["workflowPath"] = ".github/workflows/a.yml"
	only := actionRead(t, f, x.login, body)
	if len(only.Runs) != 1 || only.Runs[0].Ref.Kind != 1 || only.Runs[0].Ref.Id != shared || only.NextCursor != "" {
		t.Fatal("server workflow/path filtering failed")
	}
}

func TestActionRunDetailsAndVisibilityPostgres(t *testing.T) {
	x := newActionFixture(t)
	f := x.f
	task, workflow, review := uuid.NewString(), uuid.NewString(), uuid.NewString()
	x.task(t, task, 11, x.user, x.at)
	x.workflow(t, workflow, 11, ".github/workflows/a.yml", x.at)
	x.review(t, review, task, x.at)
	for _, entry := range []struct {
		id     string
		kind   int
		detail string
	}{{task, 2, "task"}, {workflow, 1, "workflow"}, {review, 3, "review"}} {
		body := map[string]any{"repository": actionSelection(), "repositoryId": "11", "ref": map[string]any{"kind": entry.kind, "id": entry.id}}
		w := actionCall(f.server, x.login, "GetActionRun", body)
		if w.Code != 200 {
			t.Fatalf("detail %s failed %d %s", entry.detail, w.Code, w.Body)
		}
		var result golfv1.GetActionRunResponse
		if e := protojson.Unmarshal(w.Body.Bytes(), &result); e != nil {
			t.Fatal(e)
		}
		if result.RepositoryId != "11" || result.Summary.Ref.Id != entry.id || int(result.Summary.Ref.Kind) != entry.kind || result.Summary.CommitId != strings.Repeat("a", 40) {
			t.Fatal("detail identity receipt lost")
		}
		switch entry.kind {
		case 1:
			if result.GetWorkflow() == nil || result.GetWorkflow().Progress.JobId != "actual-job" || result.GetWorkflow().AttemptId != strings.Repeat("d", 32) {
				t.Fatal("actual workflow detail missing")
			}
		case 2:
			if result.GetTask() == nil || result.GetTask().Patch != "private-task-patch" || result.GetTask().AttemptId != strings.Repeat("e", 32) {
				t.Fatal("private own task detail missing")
			}
		case 3:
			if result.GetReview() == nil || result.GetReview().PullNumber != 7 {
				t.Fatal("review detail missing")
			}
		}
		body["ref"] = map[string]any{"kind": (entry.kind % 3) + 1, "id": entry.id}
		if w = actionCall(f.server, x.login, "GetActionRun", body); w.Code != 404 {
			t.Fatal("UUID type guessed", w.Code)
		}
	}
	foreign := uuid.NewString()
	x.task(t, foreign, 11, x.foreign, x.at)
	if w := actionCall(f.server, x.login, "GetActionRun", map[string]any{"repository": actionSelection(), "repositoryId": "11", "ref": map[string]any{"kind": 2, "id": foreign}}); w.Code != 404 {
		t.Fatal("global admin saw foreign task")
	}
	// Native readers retain shared workflow/review observations but no child/task.
	f.mu.Lock()
	f.permission = "read"
	f.mu.Unlock()
	all := actionRead(t, f, x.login, map[string]any{"repository": actionSelection(), "repositoryId": "11"})
	if len(all.Runs) != 2 {
		t.Fatal("reader visibility inventory wrong")
	}
	for _, v := range all.Runs {
		if v.Ref.Kind == 2 || v.ChildTask != nil {
			t.Fatal("reader leaked private child")
		}
	}
	if w := actionCall(f.server, x.login, "GetActionRun", map[string]any{"repository": actionSelection(), "repositoryId": "11", "ref": map[string]any{"kind": 2, "id": task}}); w.Code != 404 {
		t.Fatal("reader inspected own formerly writable task")
	}
	for _, session := range []loginResult{f.session} {
		if w := actionCall(f.server, session, "ListActionRuns", map[string]any{"repository": actionSelection(), "repositoryId": "11"}); w.Code == 200 {
			t.Fatal("PAT granted browser Actions projection")
		}
	}
}

func TestActionRunAuthorityLossPostgres(t *testing.T) {
	for _, mode := range []string{"writer", "native-repository", "local-session"} {
		t.Run(mode, func(t *testing.T) {
			x := newActionFixture(t)
			f := x.f
			id := uuid.NewString()
			x.task(t, id, 11, x.user, x.at)
			base := f.server.client.Transport
			if base == nil {
				base = http.DefaultTransport
			}
			var calls atomic.Int32
			f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
				path := "/api/v1/repos/alice/example/collaborators/alice/permission"
				if mode == "native-repository" {
					path = "/api/v1/repos/alice/example"
				}
				if r.URL.Path == path && calls.Add(1) == 2 {
					switch mode {
					case "writer":
						f.mu.Lock()
						f.permission = "read"
						f.mu.Unlock()
					case "native-repository":
						f.mu.Lock()
						f.row.ID = 99
						f.mu.Unlock()
					case "local-session":
						if _, e := f.server.db.Exec(`DELETE FROM golf_sessions WHERE token_hash=$1`, x.hash); e != nil {
							t.Error(e)
						}
					}
				}
				return base.RoundTrip(r)
			})
			w := actionCall(f.server, x.login, "GetActionRun", map[string]any{"repository": actionSelection(), "repositoryId": "11", "ref": map[string]any{"kind": 2, "id": id}})
			if w.Code == 200 || strings.Contains(w.Body.String(), "private-task-") {
				t.Fatal("late authority loss released private result", w.Code)
			}
		})
	}
}

// The native HTTP boundary returns the current renamed identity while rows
// retain their original name. This is source/PG qualification, not a claim of
// an installed-native rename end-to-end pass.
func TestActionRunRenamedRepositoryPostgres(t *testing.T) {
	x := newActionFixture(t)
	f := x.f
	id := uuid.NewString()
	x.task(t, id, 11, x.user, x.at)
	f.mu.Lock()
	f.row.Name = "renamed"
	f.row.FullName = "alice/renamed"
	f.mu.Unlock()
	base := f.server.client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	var names atomic.Int32
	f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/repos/alice/renamed") {
			names.Add(1)
			clone := r.Clone(r.Context())
			u := *r.URL
			clone.URL = &u
			clone.URL.Path = strings.Replace(r.URL.Path, "/api/v1/repos/alice/renamed", "/api/v1/repos/alice/example", 1)
			return base.RoundTrip(clone)
		}
		return base.RoundTrip(r)
	})
	request := map[string]any{"repository": map[string]string{"owner": "alice", "name": "renamed"}, "repositoryId": "11", "ref": map[string]any{"kind": 2, "id": id}}
	w := actionCall(f.server, x.login, "GetActionRun", request)
	if w.Code != 200 {
		t.Fatalf("current renamed binding failed %d %s", w.Code, w.Body)
	}
	var result golfv1.GetActionRunResponse
	if e := protojson.Unmarshal(w.Body.Bytes(), &result); e != nil {
		t.Fatal(e)
	}
	if names.Load() < 4 || result.GetTask().Repository.Name != "renamed" || result.Summary.RepositoryId != "11" || result.GetTask().CommitId != strings.Repeat("a", 40) {
		t.Fatal("rename guessed identity or changed original snapshot")
	}
	request["repositoryId"] = "99"
	if w = actionCall(f.server, x.login, "GetActionRun", request); w.Code != 404 {
		t.Fatal("renamed replacement identity accepted")
	}
	f.mu.Lock()
	f.denied = true
	f.mu.Unlock()
	request["repositoryId"] = "11"
	if w = actionCall(f.server, x.login, "GetActionRun", request); w.Code == 200 || strings.Contains(w.Body.String(), "private-task-") {
		t.Fatal("renamed native authority revocation released payload")
	}
}

func TestActionRunReviewerChildPrivacyPostgres(t *testing.T) {
	x := newActionFixture(t)
	f := x.f
	task, review := uuid.NewString(), uuid.NewString()
	x.task(t, task, 11, x.foreign, x.at)
	x.review(t, review, task, x.at)
	request := map[string]any{"repository": actionSelection(), "repositoryId": "11", "ref": map[string]any{"kind": 3, "id": review}}
	w := actionCall(f.server, x.login, "GetActionRun", request)
	if w.Code != 200 {
		t.Fatalf("shared reviewer read refused %d", w.Code)
	}
	var result golfv1.GetActionRunResponse
	if e := protojson.Unmarshal(w.Body.Bytes(), &result); e != nil {
		t.Fatal(e)
	}
	if result.Summary.ChildTask != nil || result.GetReview().TaskId != "" || strings.Contains(w.Body.String(), task) {
		t.Fatal("global admin inherited foreign reviewer task visibility")
	}
	f.mu.Lock()
	f.permission = "read"
	f.mu.Unlock()
	w = actionCall(f.server, x.login, "GetActionRun", request)
	if w.Code != 200 {
		t.Fatal("repo reader lost shared review detail")
	}
}

func TestActionRunFilteredCursorPostgres(t *testing.T) {
	x := newActionFixture(t)
	f := x.f
	for range 3 {
		x.workflow(t, uuid.NewString(), 11, ".github/workflows/a.yml", x.at)
	}
	x.workflow(t, uuid.NewString(), 11, ".github/workflows/b.yml", x.at.Add(time.Hour))
	request := map[string]any{"repository": actionSelection(), "repositoryId": "11", "limit": 1, "kindFilter": 1, "workflowPath": ".github/workflows/a.yml"}
	first := actionRead(t, f, x.login, request)
	if len(first.Runs) != 1 || first.NextCursor == "" || first.Runs[0].WorkflowPath != ".github/workflows/a.yml" {
		t.Fatal("filtered chronology wrong")
	}
	request["cursor"] = first.NextCursor
	request["workflowPath"] = ".github/workflows/b.yml"
	if w := actionCall(f.server, x.login, "ListActionRuns", request); w.Code != 400 {
		t.Fatal("cursor crossed valid exact workflow filters", w.Code)
	}
	request["workflowPath"] = ".github/workflows/a.yml"
	cursor, e := decodeActionCursor(first.NextCursor)
	if e != nil {
		t.Fatal(e)
	}
	cursor.User = x.foreign
	request["cursor"] = encodeActionCursor(cursor)
	if w := actionCall(f.server, x.login, "ListActionRuns", request); w.Code != 400 {
		t.Fatal("cursor crossed actor scope", w.Code)
	}
	request["cursor"] = first.NextCursor
	request["limit"] = 101
	if w := actionCall(f.server, x.login, "ListActionRuns", request); w.Code != 400 {
		t.Fatal("unbounded inventory accepted")
	}
}

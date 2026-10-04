package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
)

func standardMergeFixtureRequest() *golfv1.SubmitStandardPullMergeRequest {
	p := standardMergeFixturePull(false)
	return &golfv1.SubmitStandardPullMergeRequest{Selection: &golfv1.PullRequestSelection{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", PullRequestId: "9007199254740993", Number: 7, HeadCommitId: strings.Repeat("a", 40), BaseCommitId: strings.Repeat("b", 40)}, OwnerId: "42", ExpectedPullRevision: pullRevision(p), OperationId: uuid.NewString(), SourceRef: "feature/slash", TargetRef: "main"}
}
func standardMergeFixturePull(merged bool) forgePull {
	p := mergeFixturePull("")
	p.Head.RepositoryID = 11
	p.Head.Repository = &Repository{ID: 11, Name: "private", FullName: "alice/private", HTMLURL: "https://forge.invalid/alice/private"}
	if merged {
		yes := true
		c := strings.Repeat("c", 40)
		at := "2026-10-04T12:00:00Z"
		p.State = "closed"
		p.Merged = &yes
		p.MergeCommitID = &c
		p.MergedAt = &at
		p.Base.SHA = c
	}
	return p
}
func TestStandardMergeInputAndFingerprint(t *testing.T) {
	m := standardMergeFixtureRequest()
	if e := validateStandardMerge(m); e != nil {
		t.Fatal(e)
	}
	original := standardMergeFingerprint(m)
	m.OperationId = uuid.NewString()
	if !bytes.Equal(original, standardMergeFingerprint(m)) {
		t.Fatal("key changed semantic fingerprint")
	}
	for _, field := range []string{"title", "message", "base", "head", "ref", "owner", "revision"} {
		altered := proto.Clone(m).(*golfv1.SubmitStandardPullMergeRequest)
		switch field {
		case "title":
			altered.CommitTitle = "Requested private title"
		case "message":
			altered.CommitMessage = "Requested private message"
		case "base":
			altered.Selection.BaseCommitId = strings.Repeat("d", 40)
		case "head":
			altered.Selection.HeadCommitId = strings.Repeat("d", 40)
		case "ref":
			altered.SourceRef = "different"
		case "owner":
			altered.OwnerId = "43"
		case "revision":
			altered.ExpectedPullRevision = strings.Repeat("d", 64)
		}
		if bytes.Equal(original, standardMergeFingerprint(altered)) {
			t.Fatal("intent not bound", field)
		}
	}
	for _, change := range []string{"nil", "id", "uuid", "sha", "width", "ref", "title", "body"} {
		bad := proto.Clone(m).(*golfv1.SubmitStandardPullMergeRequest)
		switch change {
		case "nil":
			bad.Selection = nil
		case "id":
			bad.OwnerId = "042"
		case "uuid":
			bad.OperationId = "not-uuid"
		case "sha":
			bad.Selection.HeadCommitId = "main"
		case "width":
			bad.Selection.BaseCommitId = strings.Repeat("b", 64)
		case "ref":
			bad.SourceRef = "refs/pull/7/head"
		case "title":
			bad.CommitTitle = " leading"
		case "body":
			bad.CommitMessage = strings.Repeat("x", 6001)
		}
		if validateStandardMerge(bad) == nil {
			t.Fatal("invalid request admitted", change)
		}
	}
}
func TestStandardMergeManagedOuterBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, method := range []string{golfv1connect.StandardPullMergeServiceSubmitStandardPullMergeProcedure, golfv1connect.StandardPullMergeServiceGetStandardPullMergeOperationProcedure} {
		for _, kind := range []string{"anonymous", "origin", "bearer"} {
			req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/rpc"+method, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Connect-Protocol-Version", "1")
			req.Header.Set("Origin", s.config.PublicURL)
			want := 401
			if kind == "origin" {
				req.Header.Set("Origin", "https://other.invalid")
				want = 403
			}
			if kind == "bearer" {
				req.Header.Set("Authorization", "Bearer golf_ro_"+strings.Repeat("A", 43))
				want = 403
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("outer managed boundary", kind, w.Code)
			}
		}
	}
}

type standardMergeFixture struct {
	*pullFixture
	mu         sync.Mutex
	merged     bool
	calls      atomic.Int32
	mode       atomic.Value
	actualBase string
}

func newStandardMergeFixture(t *testing.T) *standardMergeFixture {
	t.Helper()
	f := &standardMergeFixture{pullFixture: &pullFixture{db: testDatabase(t)}, actualBase: strings.Repeat("b", 40)}
	f.mode.Store("")
	f.pullFixture.mode.Store("")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mode := f.mode.Load().(string)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/user" {
			json.NewEncoder(w).Encode(map[string]any{"id": 42, "login": "alice", "is_admin": false})
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private" {
			row := rulesRepositoryFixture()
			row.ID = 11
			row.Name = "private"
			row.FullName = "alice/private"
			row.HTMLURL = "https://forge.invalid/alice/private"
			if mode == "replacement" {
				row.ID = 12
			}
			raw, _ := json.Marshal(row)
			var result map[string]any
			json.Unmarshal(raw, &result)
			result["permissions"] = map[string]bool{"pull": mode != "denied", "push": mode != "reader" && mode != "denied", "admin": false}
			result["has_actions"] = false
			json.NewEncoder(w).Encode(result)
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/pulls/7" {
			f.mu.Lock()
			p := standardMergeFixturePull(f.merged)
			f.mu.Unlock()
			if mode == "fork" {
				p.Head.RepositoryID = 23
				p.Head.Repository.ID = 23
			}
			json.NewEncoder(w).Encode(p)
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/commits" {
			json.NewEncoder(w).Encode([]any{workspaceCommit(strings.Repeat("a", 40))})
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/branches/main" {
			json.NewEncoder(w).Encode(map[string]any{"name": "main", "commit": map[string]string{"id": strings.Repeat("b", 40)}, "protected": mode == "protected", "user_can_merge": true})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/repos/alice/private/git/refs/heads/") {
			name := strings.TrimPrefix(r.URL.Path, "/api/v1/repos/alice/private/git/refs/heads/")
			sha := strings.Repeat("a", 40)
			if name == "main" {
				sha = strings.Repeat("b", 40)
				f.mu.Lock()
				if f.merged {
					sha = strings.Repeat("c", 40)
				}
				f.mu.Unlock()
			}
			if mode == "source-drift" && name == "feature/slash" {
				sha = strings.Repeat("d", 40)
			}
			json.NewEncoder(w).Encode([]any{map[string]any{"ref": "refs/heads/" + name, "object": map[string]string{"type": "commit", "sha": sha}}})
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/pulls/7/merge" && r.Method == http.MethodPost {
			var payload map[string]any
			if json.NewDecoder(r.Body).Decode(&payload) != nil {
				w.WriteHeader(400)
				return
			}
			if payload["do"] != "merge" || payload["head_commit_id"] != strings.Repeat("a", 40) || payload["force_merge"] != false || payload["merge_when_checks_succeed"] != false || payload["delete_branch_after_merge"] != false {
				t.Error("native expected-H/nonforce/nonscheduled/nondestructive flags lost")
				w.WriteHeader(400)
				return
			}
			f.calls.Add(1)
			f.mu.Lock()
			f.merged = true
			f.mu.Unlock()
			if mode == "lost-response" {
				w.WriteHeader(500)
				return
			}
			if mode == "role-loss" {
				f.mode.Store("reader")
			}
			w.WriteHeader(200)
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/git/commits/"+strings.Repeat("c", 40) {
			h := strings.Repeat("a", 40)
			if mode == "bad-receipt" {
				h = strings.Repeat("d", 40)
			}
			json.NewEncoder(w).Encode(map[string]any{"sha": strings.Repeat("c", 40), "parents": []map[string]string{{"sha": f.actualBase}, {"sha": h}}})
			return
		}
		f.serveProvider(w, r)
	}))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.GiteaPublicURL = provider.URL
	config.GiteaOAuthClientID = "fixture-client"
	config.GiteaOAuthClientSecret = "fixture-secret"
	var e error
	f.s, e = New(config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *standardMergeFixture) submit(t *testing.T, session loginResult, m *golfv1.SubmitStandardPullMergeRequest) (*golfv1.StandardPullMergeOperation, error) {
	t.Helper()
	_, _, _, httpClient, origin := testRPCClients(t, f.s)
	httpClient.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	client := golfv1connect.NewStandardPullMergeServiceClient(httpClient, origin.String()+"/rpc")
	req := connect.NewRequest(m)
	req.Header().Set("Origin", f.s.config.PublicURL)
	r, e := client.SubmitStandardPullMerge(context.Background(), req)
	if e != nil {
		return nil, e
	}
	return r.Msg.Operation, nil
}
func (f *standardMergeFixture) status(t *testing.T, session loginResult, m *golfv1.GetStandardPullMergeOperationRequest) (*golfv1.StandardPullMergeOperation, error) {
	t.Helper()
	_, _, _, httpClient, origin := testRPCClients(t, f.s)
	httpClient.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	client := golfv1connect.NewStandardPullMergeServiceClient(httpClient, origin.String()+"/rpc")
	req := connect.NewRequest(m)
	req.Header().Set("Origin", f.s.config.PublicURL)
	r, e := client.GetStandardPullMergeOperation(context.Background(), req)
	if e != nil {
		return nil, e
	}
	return r.Msg.Operation, nil
}
func TestStandardMergeOnceAndOriginalPostgres(t *testing.T) {
	f := newStandardMergeFixture(t)
	session := f.session(t, "pat")
	m := standardMergeFixtureRequest()
	m.CommitTitle = "Explicit private title"
	m.CommitMessage = "Explicit private requested content"
	first, e := f.submit(t, session, m)
	if e != nil {
		t.Fatal(e)
	}
	if first.Phase != golfv1.StandardPullMergePhase_STANDARD_PULL_MERGE_PHASE_SUCCEEDED || first.MergeCommitId != strings.Repeat("c", 40) || first.ActualBaseCommitId != strings.Repeat("b", 40) || first.ObservedBaseCommitId != m.Selection.BaseCommitId {
		t.Fatal("independent exact native receipt lost")
	}
	replay, e := f.submit(t, session, m)
	if e != nil || !proto.Equal(first, replay) || f.calls.Load() != 1 {
		t.Fatal("same-key replay dispatched", e)
	}
	changed := proto.Clone(m).(*golfv1.SubmitStandardPullMergeRequest)
	changed.CommitMessage = "Different private request"
	if _, e = f.submit(t, session, changed); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("changed content did not conflict", e)
	}
	status, e := f.status(t, session, standardMergeStatusRequest(m))
	if e != nil || !proto.Equal(first, status) || f.calls.Load() != 1 {
		t.Fatal("original status changed/dispatched", e)
	}
	var n int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_standard_pull_merge_events`).Scan(&n); e != nil || n != 3 {
		t.Fatal("durable phase event count", e, n)
	}
	var stored string
	if e = f.db.QueryRow(`SELECT row_to_json(t)::text FROM golf_standard_pull_merges t`).Scan(&stored); e != nil || strings.Contains(stored, m.CommitTitle) || strings.Contains(stored, m.CommitMessage) {
		t.Fatal("requested plaintext retained", e)
	}
}
func TestStandardMergeRefusalAndUnknownPostgres(t *testing.T) {
	for _, mode := range []string{"protected", "fork", "source-drift", "lost-response", "bad-receipt", "role-loss"} {
		t.Run(mode, func(t *testing.T) {
			f := newStandardMergeFixture(t)
			session := f.session(t, "pat")
			m := standardMergeFixtureRequest()
			f.mode.Store(mode)
			r, e := f.submit(t, session, m)
			if mode == "role-loss" {
				if connect.CodeOf(e) != connect.CodeNotFound {
					t.Fatal("late role loss exposed receipt", e)
				}
				f.mode.Store("")
				r, e = f.status(t, session, standardMergeStatusRequest(m))
			}
			if e != nil {
				t.Fatal(e)
			}
			known := mode == "protected" || mode == "fork" || mode == "source-drift"
			phase := golfv1.StandardPullMergePhase_STANDARD_PULL_MERGE_PHASE_DISPATCH_UNKNOWN
			if known {
				phase = golfv1.StandardPullMergePhase_STANDARD_PULL_MERGE_PHASE_REJECTED
			}
			if r.Phase != phase || known && f.calls.Load() != 0 || !known && f.calls.Load() != 1 {
				t.Fatal("effect classification", mode, r.Phase, f.calls.Load())
			}
			replay, e := f.submit(t, session, m)
			if e != nil || replay.Phase != phase {
				t.Fatal("original replay", e)
			}
			if !known {
				var active int
				if e = f.db.QueryRow(`SELECT golf_repository_lifecycle_active($1,11)`, f.s.config.GiteaURL).Scan(&active); e != nil || active < 1 {
					t.Fatal("unknown archive exclusion", e)
				}
				fresh := proto.Clone(m).(*golfv1.SubmitStandardPullMergeRequest)
				fresh.OperationId = uuid.NewString()
				if _, e = f.submit(t, session, fresh); connect.CodeOf(e) != connect.CodeFailedPrecondition {
					t.Fatal("unknown replaced", e)
				}
				if f.calls.Load() != 1 {
					t.Fatal("native mutation repeated")
				}
			}
		})
	}
}
func TestStandardMergeConcurrentOriginalPostgres(t *testing.T) {
	f := newStandardMergeFixture(t)
	session := f.session(t, "pat")
	m := standardMergeFixtureRequest()
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for range 4 {
		wg.Add(1)
		go func() { defer wg.Done(); _, e := f.submit(t, session, m); errs <- e }()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	if f.calls.Load() != 1 {
		t.Fatal("concurrent original repeated")
	}
}
func TestStandardMergeStatusPrivacyAndSQLPostgres(t *testing.T) {
	f := newStandardMergeFixture(t)
	session := f.session(t, "pat")
	m := standardMergeFixtureRequest()
	if _, e := f.submit(t, session, m); e != nil {
		t.Fatal(e)
	}
	wrong := standardMergeStatusRequest(m)
	wrong.PullRequestId = "9007199254740994"
	if _, e := f.status(t, session, wrong); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("wrong immutable original target", e)
	}
	missing := standardMergeStatusRequest(m)
	missing.OperationId = uuid.NewString()
	if _, e := f.status(t, session, missing); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("missing outcome treated as no effect", e)
	}
	for _, query := range []string{`UPDATE golf_standard_pull_merges SET head_commit_id=repeat('d',40)`, `UPDATE golf_standard_pull_merges SET phase='DISPATCH_UNKNOWN'`, `DELETE FROM golf_standard_pull_merges`, `TRUNCATE golf_standard_pull_merge_events`} {
		if _, e := f.db.Exec(query); e == nil {
			t.Fatal("retained identity/outcome mutable", query)
		}
	}
	f.mode.Store("reader")
	if _, e := f.status(t, session, standardMergeStatusRequest(m)); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("lost writer exposed private original", e)
	}
	f.mode.Store("")
	hash, e := sessionHash(session.Value)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.db.Exec(`DELETE FROM golf_sessions WHERE token_hash=$1`, hash); e != nil {
		t.Fatal(e)
	}
	if _, e = f.status(t, session, standardMergeStatusRequest(m)); connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("logout exposed original", e)
	}
}

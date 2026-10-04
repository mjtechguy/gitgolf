package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestPullMergeBranchExactObservation(t *testing.T) {
	for _, mode := range []string{"valid", "missing-protection", "missing-caller", "wrong-name", "wrong-commit", "ref-drift", "prefix-only", "duplicate-ref"} {
		t.Run(mode, func(t *testing.T) {
			var requests atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Method != http.MethodGet {
					t.Error("read dispatched mutation")
				}
				sha := strings.Repeat("a", 40)
				if strings.Contains(r.URL.Path, "/branches/") {
					row := map[string]any{"name": "feature/slash", "commit": map[string]string{"id": sha}, "protected": false, "user_can_merge": false}
					switch mode {
					case "missing-protection":
						delete(row, "protected")
					case "missing-caller":
						delete(row, "user_can_merge")
					case "wrong-name":
						row["name"] = "feature"
					case "wrong-commit":
						row["commit"] = map[string]string{"id": "main"}
					}
					json.NewEncoder(w).Encode(row)
					return
				}
				if r.URL.Path != "/api/v1/repos/alice/private/git/refs/heads/feature/slash" {
					t.Error("exact namespace escaped incorrectly", r.URL.Path)
				}
				ref := "refs/heads/feature/slash"
				if mode == "ref-drift" {
					sha = strings.Repeat("b", 40)
				}
				if mode == "prefix-only" {
					ref += "/nested"
				}
				row := map[string]any{"ref": ref, "object": map[string]string{"sha": sha, "type": "commit"}}
				rows := []any{row}
				if mode == "duplicate-ref" {
					rows = append(rows, row)
				}
				json.NewEncoder(w).Encode(rows)
			}))
			defer provider.Close()
			s := &Server{config: Config{GiteaURL: provider.URL}, client: provider.Client()}
			row, e := s.readMergeBranch(context.Background(), forgeCredential{Kind: "pat", Token: "owned-source-test"}, "/repos/alice/private", "feature/slash")
			if mode == "valid" {
				if e != nil || row.Protected == nil || *row.Protected || row.UserCanMerge == nil || *row.UserCanMerge || requests.Load() != 2 {
					t.Fatal("explicit false/exact namespace lost", e)
				}
			} else if e == nil {
				t.Fatal("ambiguous or omitted native observation admitted")
			}
		})
	}
}

func TestPullMergeObservationBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	proc := "/rpc" + golfv1connect.PullMergeObservationServiceGetPullRequestMergeObservationProcedure
	for _, kind := range []string{"anonymous", "foreign-origin", "bearer"} {
		req := httptest.NewRequest(http.MethodPost, proc, strings.NewReader("not-json"))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Connect-Protocol-Version", "1")
		req.Header.Set("Origin", s.config.PublicURL)
		want := 401
		if kind == "foreign-origin" {
			want = 403
			req.Header.Set("Origin", "https://foreign.invalid")
		}
		if kind == "bearer" {
			want = 403
			req.Header.Set("Authorization", "Bearer golf_ro_"+strings.Repeat("A", 43))
		}
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != want || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("managed predecode boundary", kind, rec.Code)
		}
	}
}

type pullMergeFixture struct {
	*pullFixture
	branchReads, sourceReads, mutations atomic.Int32
}

func newPullMergeFixture(t *testing.T) *pullMergeFixture {
	t.Helper()
	f := &pullMergeFixture{pullFixture: &pullFixture{db: testDatabase(t), entered: make(chan struct{}, 1), resume: make(chan struct{})}}
	f.mode.Store("")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			f.mutations.Add(1)
			w.WriteHeader(405)
			return
		}
		mode := f.mode.Load().(string)
		if r.URL.Path == "/api/v1/user" {
			json.NewEncoder(w).Encode(map[string]any{"id": 42, "login": "alice", "is_admin": false})
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private" || r.URL.Path == "/api/v1/repos/author/fork" {
			source := strings.Contains(r.URL.Path, "author/fork")
			if source && mode == "source-denied" {
				w.WriteHeader(404)
				return
			}
			row := rulesRepositoryFixture()
			row.ID = 11
			row.Name = "private"
			row.FullName = "alice/private"
			row.HTMLURL = "https://forge.invalid/alice/private"
			if source {
				row.ID = 23
				row.Name = "fork"
				row.FullName = "author/fork"
				row.HTMLURL = "https://forge.invalid/author/fork"
				row.Owner = &User{ID: 71, Login: "author"}
			}
			bytes, _ := json.Marshal(row)
			var raw map[string]any
			json.Unmarshal(bytes, &raw)
			raw["permissions"] = map[string]bool{"pull": source || mode != "target-denied", "push": mode != "read-only", "admin": false}
			raw["has_actions"] = false
			if !source && mode == "target-replacement" && f.repoRead.Add(1) > 1 {
				raw["id"] = 12
			}
			json.NewEncoder(w).Encode(raw)
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/pulls/7" {
			row := mergeFixturePull(mode)
			json.NewEncoder(w).Encode(row)
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/commits" {
			json.NewEncoder(w).Encode([]any{workspaceCommit(strings.Repeat("a", 40))})
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/branches/main" {
			n := f.branchReads.Add(1)
			protected := mode == "protected" || mode == "protection-drift" && n > 1
			json.NewEncoder(w).Encode(map[string]any{"name": "main", "commit": map[string]string{"id": strings.Repeat("b", 40)}, "protected": protected, "user_can_merge": mode != "read-only"})
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/git/refs/heads/main" {
			json.NewEncoder(w).Encode([]any{map[string]any{"ref": "refs/heads/main", "object": map[string]string{"sha": strings.Repeat("b", 40), "type": "commit"}}})
			return
		}
		if r.URL.Path == "/api/v1/repos/author/fork/git/refs/heads/feature/slash" {
			n := f.sourceReads.Add(1)
			if mode == "wait-source" && n == 1 {
				f.entered <- struct{}{}
				select {
				case <-f.resume:
				case <-r.Context().Done():
				}
			}
			sha := strings.Repeat("a", 40)
			if mode == "source-changed" || mode == "source-drift" && n > 1 {
				sha = strings.Repeat("c", 40)
			}
			json.NewEncoder(w).Encode([]any{map[string]any{"ref": "refs/heads/feature/slash", "object": map[string]string{"sha": sha, "type": "commit"}}})
			return
		}
		f.serveProvider(w, r)
	}))
	t.Cleanup(provider.Close)
	t.Cleanup(func() { close(f.resume) })
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
func mergeFixturePull(mode string) forgePull {
	no := false
	version := int64(0)
	row := forgePull{ContentVersion: &version, ID: 9007199254740993, Number: 7, Title: "Private change", State: "open", User: &User{ID: 42, Login: "alice"}, CreatedAt: "2026-10-02T12:00:00Z", UpdatedAt: "2026-10-02T12:01:00Z", HTMLURL: "https://forge.invalid/alice/private/pulls/7", Draft: &no, Merged: &no, Head: &forgePullRef{RepositoryID: 23, Ref: "feature/slash", SHA: strings.Repeat("a", 40), Repository: &Repository{ID: 23, Name: "fork", FullName: "author/fork", HTMLURL: "https://forge.invalid/author/fork"}}, Base: &forgePullRef{RepositoryID: 11, Ref: "main", SHA: strings.Repeat("b", 40)}}
	if mode == "retained" {
		row.Head.Ref = "refs/pull/7/head"
	}
	return row
}
func (f *pullMergeFixture) read(t *testing.T, session loginResult) (*golfv1.GetPullRequestMergeObservationResponse, error) {
	t.Helper()
	_, _, _, transport, origin := testRPCClients(t, f.s)
	transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	client := golfv1connect.NewPullMergeObservationServiceClient(transport, origin.String()+"/rpc")
	req := connect.NewRequest(&golfv1.GetPullRequestMergeObservationRequest{Selection: workspaceSelection(), ExpectedPullRevision: pullRevision(mergeFixturePull(f.mode.Load().(string)))})
	req.Header().Set("Origin", f.s.config.PublicURL)
	r, e := client.GetPullRequestMergeObservation(context.Background(), req)
	if e != nil {
		return nil, e
	}
	return r.Msg, nil
}
func TestPullMergeObservationPostgres(t *testing.T) {
	for _, mode := range []string{"", "protected", "read-only", "source-denied", "source-changed", "retained", "protection-drift", "source-drift", "target-replacement"} {
		t.Run(mode, func(t *testing.T) {
			f := newPullMergeFixture(t)
			session := f.session(t, "pat")
			f.mode.Store(mode)
			r, e := f.read(t, session)
			if mode == "protection-drift" || mode == "source-drift" || mode == "target-replacement" {
				if e == nil || r != nil {
					t.Fatal("changed identity/predicate exposed", e)
				}
				return
			}
			if e != nil {
				t.Fatal("current authorized observation", e)
			}
			v := r.Observation
			if v.Selection.HeadCommitId != strings.Repeat("a", 40) || v.Base.CommitId != strings.Repeat("b", 40) || v.TargetOwnerId != "42" || v.UnavailableReason != mergeObservationUnavailable || len(v.Fingerprint) != 64 || v.ObservedAt == "" {
				t.Fatal("exact observation receipt lost")
			}
			if mode == "source-denied" || mode == "retained" {
				if v.Source != nil || v.SourceRepository != nil || v.SourceRepositoryId != "" {
					t.Fatal("unavailable private source disclosed")
				}
			} else if v.SourceRepositoryId != "23" || v.Source.Name != "feature/slash" {
				t.Fatal("live source identity lost")
			}
			if mode == "source-changed" && v.SourceState != golfv1.PullMergeSourceState_PULL_MERGE_SOURCE_STATE_CHANGED {
				t.Fatal("retained H falsely treated as current")
			}
			if mode == "read-only" && (v.CurrentTargetWriter == nil || *v.CurrentTargetWriter || v.NativeCallerCanMerge == nil || *v.NativeCallerCanMerge) {
				t.Fatal("native false/writer refusal lost")
			}
			if mode == "protected" && v.TargetProtection != golfv1.PullMergeTargetProtection_PULL_MERGE_TARGET_PROTECTION_PROTECTED {
				t.Fatal("protection missing")
			}
			raw, _ := protojson.Marshal(r)
			for _, forbidden := range []string{"pull-pat", "can_dispatch", "mergeable", "Private change"} {
				if strings.Contains(string(raw), forbidden) {
					t.Fatal("uncontracted private content or authority escaped")
				}
			}
			if f.mutations.Load() != 0 {
				t.Fatal("observation dispatched mutation")
			}
		})
	}
}
func TestPullMergeObservationLogoutAfterWaitPostgres(t *testing.T) {
	f := newPullMergeFixture(t)
	session := f.session(t, "pat")
	f.mode.Store("wait-source")
	done := make(chan error, 1)
	go func() { _, e := f.read(t, session); done <- e }()
	select {
	case <-f.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("source boundary not reached")
	}
	hash, err := sessionHash(session.Value)
	if err != nil {
		t.Fatal(err)
	}
	if _, e := f.db.Exec(`DELETE FROM golf_sessions WHERE token_hash=$1`, hash); e != nil {
		t.Fatal(e)
	}
	f.resume <- struct{}{}
	e := <-done
	if connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("late private read escaped logout", e)
	}
}

func TestPullMergeObservationAuthorityAfterWaitPostgres(t *testing.T) {
	for _, mode := range []string{"target-denied", "read-only"} {
		t.Run(mode, func(t *testing.T) {
			f := newPullMergeFixture(t)
			session := f.session(t, "pat")
			f.mode.Store("wait-source")
			done := make(chan error, 1)
			go func() { _, e := f.read(t, session); done <- e }()
			select {
			case <-f.entered:
			case <-time.After(3 * time.Second):
				t.Fatal("source boundary not reached")
			}
			f.mode.Store(mode)
			f.resume <- struct{}{}
			e := <-done
			if e == nil {
				t.Fatal("late target authority change returned a private observation")
			}
			if mode == "target-denied" && connect.CodeOf(e) != connect.CodeNotFound {
				t.Fatal("target denial lost", e)
			}
			if mode == "read-only" && connect.CodeOf(e) != connect.CodeFailedPrecondition {
				t.Fatal("writer drift lost", e)
			}
			if f.mutations.Load() != 0 {
				t.Fatal("observation dispatched a native write")
			}
		})
	}
}

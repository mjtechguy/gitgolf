package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func workspaceSelection() *golfv1.PullRequestSelection {
	return &golfv1.PullRequestSelection{Repository: pullKey, RepositoryId: "11", PullRequestId: "9007199254740993", Number: 7, BaseCommitId: strings.Repeat("b", 40), HeadCommitId: strings.Repeat("a", 40)}
}
func workspaceCommit(sha string) map[string]any {
	return map[string]any{"sha": sha, "html_url": "https://forge.invalid/alice/private/commit/" + sha, "commit": map[string]any{"message": "Private commit\n\nLonger body", "author": map[string]string{"name": "Alice", "date": "2026-10-03T12:00:00Z"}}}
}
func workspaceStatus() forgeReportedCheck {
	return forgeReportedCheck{ID: 9007199254740993, Context: "ci/build", State: "success", Description: "Reported build result", Creator: &User{ID: 42, Login: "alice"}, Created: "2026-10-03T12:00:00Z", Updated: "2026-10-03T12:00:00Z", TargetURL: "https://checks.invalid/result"}
}
func newPullWorkspaceFixture(t *testing.T) (*pullFixture, *atomic.Int32) {
	t.Helper()
	f := &pullFixture{db: testDatabase(t), entered: make(chan struct{}, 1), resume: make(chan struct{})}
	f.mode.Store("")
	payloads := &atomic.Int32{}
	var retained, pulls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mode := f.mode.Load().(string)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/repos/alice/private/pulls/7" && (mode == "changed-head" || mode == "changed-base" || mode == "changed-pull-id" || mode == "changed-source-id") {
			rec := httptest.NewRecorder()
			f.serveProvider(rec, r)
			var row forgePull
			_ = json.Unmarshal(rec.Body.Bytes(), &row)
			if pulls.Add(1) > 1 {
				switch mode {
				case "changed-head":
					row.Head.SHA = strings.Repeat("c", 40)
				case "changed-base":
					row.Base.SHA = strings.Repeat("c", 40)
				case "changed-pull-id":
					row.ID++
				case "changed-source-id":
					row.Head.RepositoryID++
				}
			}
			_ = json.NewEncoder(w).Encode(row)
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/commits" {
			if r.URL.Query().Get("sha") != "refs/pull/7/head" || r.URL.Query().Get("limit") != "1" || r.URL.Query().Get("verification") != "false" || r.URL.Query().Get("files") != "false" || r.URL.Query().Get("stat") != "false" {
				t.Error("retained source read lost bounded reference")
			}
			sha := strings.Repeat("a", 40)
			if mode == "retained-pre" || mode == "retained-post" && retained.Add(1) > 1 {
				sha = strings.Repeat("c", 40)
			}
			_ = json.NewEncoder(w).Encode([]any{workspaceCommit(sha)})
			return
		}
		if r.URL.Path != "/api/v1/repos/alice/private/pulls/7/commits" && r.URL.Path != "/api/v1/repos/alice/private/commits/"+strings.Repeat("a", 40)+"/status" {
			f.serveProvider(w, r)
			return
		}
		payloads.Add(1)
		if r.Method != "GET" || (r.Header.Get("Authorization") != "token pull-pat" && r.Header.Get("Authorization") != "Bearer pull-oauth") {
			t.Error("workspace lost native caller credential")
		}
		if mode == "payload-denied" {
			w.WriteHeader(403)
			return
		}
		if mode == "wait-payload" {
			f.entered <- struct{}{}
			select {
			case <-f.resume:
			case <-r.Context().Done():
			}
		}
		count := "2"
		if mode == "bad-count" {
			count = "02"
		}
		w.Header().Set("X-Total-Count", count)
		if strings.HasSuffix(r.URL.Path, "/pulls/7/commits") {
			if r.URL.Query().Get("files") != "false" || r.URL.Query().Get("verification") != "false" {
				t.Error("expensive commit projections requested")
			}
			sha := strings.Repeat("a", 40)
			if r.URL.Query().Get("page") == "2" {
				sha = strings.Repeat("d", 40)
			}
			row := workspaceCommit(sha)
			switch mode {
			case "bad-sha":
				row["sha"] = "main"
			case "foreign-commit":
				row["html_url"] = "https://forge.invalid/bob/other/commit/" + sha
			case "bad-date":
				row["commit"] = map[string]any{"author": map[string]string{"date": "yesterday"}}
			}
			rows := []any{row}
			if mode == "duplicate-commits" || mode == "oversized-commits" {
				rows = append(rows, row)
			}
			if mode == "null-commits" {
				rows = nil
			}
			_ = json.NewEncoder(w).Encode(rows)
			return
		}
		row := workspaceStatus()
		if r.URL.Query().Get("page") == "2" {
			row.ID++
			row.Context = "review/security"
			row.State = "pending"
		}
		switch mode {
		case "bad-state":
			row.State = "future"
		case "bad-creator":
			row.Creator.ID = 0
		case "unsafe-target":
			row.TargetURL = "javascript:alert(1)"
		case "ghost-creator":
			row.Creator.ID = -1
		}
		combined := map[string]any{"sha": strings.Repeat("a", 40), "repository": Repository{ID: 11, FullName: "alice/private"}, "statuses": []forgeReportedCheck{row}, "state": "success", "total_count": 1}
		switch mode {
		case "wrong-check-sha":
			combined["sha"] = strings.Repeat("c", 40)
		case "wrong-check-repo":
			combined["repository"] = Repository{ID: 12, FullName: "alice/private"}
		case "null-statuses":
			combined["statuses"] = nil
		case "empty-statuses":
			combined["statuses"] = nil
			w.Header().Set("X-Total-Count", "0")
		case "duplicate-context":
			second := row
			second.ID++
			combined["statuses"] = []forgeReportedCheck{row, second}
		case "oversized-statuses":
			combined["statuses"] = []forgeReportedCheck{row, row}
		}
		_ = json.NewEncoder(w).Encode(combined)
	}))
	t.Cleanup(provider.Close)
	t.Cleanup(func() { close(f.resume) })
	config := testConfig(provider.URL)
	config.ForgePublicURL, config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f, payloads
}
func TestPullWorkspacePagination(t *testing.T) {
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			f, _ := newPullWorkspaceFixture(t)
			client := f.client(t, f.session(t, kind))
			for page := uint32(1); page <= 2; page++ {
				commits, err := client.ListPullRequestCommits(t.Context(), connect.NewRequest(&golfv1.ListPullRequestCommitsRequest{Selection: workspaceSelection(), Page: &golfv1.PageRequest{Page: page, Limit: 1}}))
				if err != nil {
					t.Fatal(err)
				}
				checks, err := client.ListPullRequestChecks(t.Context(), connect.NewRequest(&golfv1.ListPullRequestChecksRequest{Selection: workspaceSelection(), Page: &golfv1.PageRequest{Page: page, Limit: 1}}))
				if err != nil {
					t.Fatal(err)
				}
				next := uint32(0)
				if page == 1 {
					next = 2
				}
				if len(commits.Msg.Commits) != 1 || len(checks.Msg.Checks) != 1 || commits.Msg.Page.GetNextPage() != next || checks.Msg.Page.GetNextPage() != next || checks.Msg.Selection.HeadCommitId != strings.Repeat("a", 40) || commits.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("workspace paging/binding lost")
				}
				if page == 2 && checks.Msg.Checks[0].State != golfv1.ReportedCheckState_REPORTED_CHECK_STATE_PENDING {
					t.Fatal("native aggregate invented page success")
				}
			}
		})
	}
}
func TestPullWorkspaceFailures(t *testing.T) {
	for _, operation := range []string{"commits", "checks"} {
		t.Run(operation, func(t *testing.T) {
			cases := map[string]connect.Code{"retained-pre": connect.CodeFailedPrecondition, "retained-post": connect.CodeFailedPrecondition, "changed-head": connect.CodeFailedPrecondition, "changed-base": connect.CodeFailedPrecondition, "changed-pull-id": connect.CodeFailedPrecondition, "changed-source-id": connect.CodeFailedPrecondition, "repository-denied": connect.CodeNotFound, "access-removed": connect.CodeNotFound, "repository-rebound": connect.CodeUnavailable, "wrong-identity": connect.CodeUnauthenticated, "missing-scope": connect.CodePermissionDenied, "payload-denied": connect.CodePermissionDenied, "bad-count": connect.CodeUnavailable}
			if operation == "commits" {
				for _, mode := range []string{"bad-sha", "foreign-commit", "bad-date", "duplicate-commits", "null-commits"} {
					cases[mode] = connect.CodeUnavailable
				}
				cases["oversized-commits"] = connect.CodeResourceExhausted
			} else {
				for _, mode := range []string{"bad-state", "bad-creator", "wrong-check-sha", "wrong-check-repo", "null-statuses", "duplicate-context"} {
					cases[mode] = connect.CodeUnavailable
				}
				cases["oversized-statuses"] = connect.CodeResourceExhausted
			}
			for mode, want := range cases {
				t.Run(mode, func(t *testing.T) {
					f, payloads := newPullWorkspaceFixture(t)
					client := f.client(t, f.session(t, "pat"))
					f.mode.Store(mode)
					limit := uint32(20)
					if strings.HasPrefix(mode, "oversized-") {
						limit = 1
					}
					var err error
					if operation == "commits" {
						result, e := client.ListPullRequestCommits(t.Context(), connect.NewRequest(&golfv1.ListPullRequestCommitsRequest{Selection: workspaceSelection(), Page: &golfv1.PageRequest{Limit: limit}}))
						err = e
						if result != nil {
							t.Fatal("failure leaked commits")
						}
					} else {
						result, e := client.ListPullRequestChecks(t.Context(), connect.NewRequest(&golfv1.ListPullRequestChecksRequest{Selection: workspaceSelection(), Page: &golfv1.PageRequest{Limit: limit}}))
						err = e
						if result != nil {
							t.Fatal("failure leaked checks")
						}
					}
					if connect.CodeOf(err) != want {
						t.Fatal("wrong workspace failure", mode, err)
					}
					if mode == "retained-pre" && payloads.Load() != 0 {
						t.Fatal("stale retained head fetched payload")
					}
				})
			}
		})
	}
}
func TestPullWorkspaceRevocationDuringRead(t *testing.T) {
	for _, operation := range []string{"commits", "checks"} {
		t.Run(operation, func(t *testing.T) {
			f, _ := newPullWorkspaceFixture(t)
			session := f.session(t, "pat")
			client := f.client(t, session)
			f.mode.Store("wait-payload")
			done := make(chan error, 1)
			go func() {
				var err error
				if operation == "commits" {
					_, err = client.ListPullRequestCommits(context.Background(), connect.NewRequest(&golfv1.ListPullRequestCommitsRequest{Selection: workspaceSelection()}))
				} else {
					_, err = client.ListPullRequestChecks(context.Background(), connect.NewRequest(&golfv1.ListPullRequestChecksRequest{Selection: workspaceSelection()}))
				}
				done <- err
			}()
			select {
			case <-f.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("wait not entered")
			}
			hash, _ := sessionHash(session.Value)
			if _, err := f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); err != nil {
				t.Fatal(err)
			}
			f.resume <- struct{}{}
			select {
			case err := <-done:
				if connect.CodeOf(err) != connect.CodeUnauthenticated {
					t.Fatal("read survived revocation", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("wait did not settle")
			}
		})
	}
}
func TestPullWorkspaceMetadataAndSelection(t *testing.T) {
	for _, mode := range []string{"unsafe-target", "ghost-creator", "empty-statuses"} {
		t.Run(mode, func(t *testing.T) {
			f, _ := newPullWorkspaceFixture(t)
			client := f.client(t, f.session(t, "pat"))
			f.mode.Store(mode)
			result, err := client.ListPullRequestChecks(t.Context(), connect.NewRequest(&golfv1.ListPullRequestChecksRequest{Selection: workspaceSelection()}))
			if err != nil {
				t.Fatal(err)
			}
			if mode == "unsafe-target" && result.Msg.Checks[0].TargetUrl != "" {
				t.Fatal("active target link leaked")
			}
			if mode == "ghost-creator" && result.Msg.Checks[0].Creator != nil {
				t.Fatal("ghost fabricated")
			}
			if mode == "empty-statuses" && (len(result.Msg.Checks) != 0 || result.Msg.Page.GetNextPage() != 0) {
				t.Fatal("empty reports invented")
			}
		})
	}
	f, payloads := newPullWorkspaceFixture(t)
	client := f.client(t, f.session(t, "pat"))
	for _, field := range []string{"repository", "pull", "head", "invalid-id", "invalid-sha"} {
		selected := workspaceSelection()
		want := connect.CodeFailedPrecondition
		switch field {
		case "repository":
			selected.RepositoryId = "12"
		case "pull":
			selected.PullRequestId = "99"
		case "head":
			selected.HeadCommitId = strings.Repeat("d", 40)
		case "invalid-id":
			selected.RepositoryId = "011"
			want = connect.CodeInvalidArgument
		case "invalid-sha":
			selected.HeadCommitId = "main"
			want = connect.CodeInvalidArgument
		}
		_, err := client.ListPullRequestCommits(t.Context(), connect.NewRequest(&golfv1.ListPullRequestCommitsRequest{Selection: selected}))
		if connect.CodeOf(err) != want {
			t.Fatal("invalid selection accepted", field, err)
		}
	}
	if payloads.Load() != 0 {
		t.Fatal("invalid selections fetched payloads")
	}
}
func TestPullWorkspaceRPCBoundary(t *testing.T) {
	s, err := New(testConfig("http://forgejo.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{golfv1connect.RepositoryServiceListPullRequestCommitsProcedure, golfv1connect.RepositoryServiceListPullRequestChecksProcedure} {
		if !apiReadProcedure(method) {
			t.Fatal("safe read absent from allowlist")
		}
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			r := httptest.NewRequest("POST", "/rpc"+method, strings.NewReader("malformed"))
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want {
				t.Fatal("read crossed pre-decode auth boundary", strconv.Itoa(w.Code))
			}
		}
	}
}

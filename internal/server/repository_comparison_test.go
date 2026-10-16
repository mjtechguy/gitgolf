package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func comparisonRequest() *connect.Request[golfv1.GetRepositoryComparisonRequest] {
	return connect.NewRequest(&golfv1.GetRepositoryComparisonRequest{Selection: &golfv1.RepositoryComparisonSelection{Repository: pullKey, RepositoryId: "11", SourceRepository: &golfv1.RepositoryKey{Owner: "author", Name: "fork"}, SourceRepositoryId: "23", BaseBranch: "main", HeadBranch: "feature/slash", BaseCommitId: strings.Repeat("b", 40), HeadCommitId: strings.Repeat("a", 40)}})
}
func newComparisonFixture(t *testing.T) *pullMutationFixture {
	t.Helper()
	f := newPullMutationFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/compare/") {
			f.serve(w, r)
			return
		}
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/repos/alice/private/compare/"+strings.Repeat("b", 40)+"...author/fork:"+strings.Repeat("a", 40) {
			t.Error("comparison is not exact/caller GET", r.Method, r.URL.Path)
		}
		mode := f.mode.Load().(string)
		if mode == "wait-compare" {
			f.entered <- struct{}{}
			select {
			case <-f.resume:
				f.mode.Store("")
			case <-r.Context().Done():
			}
		}
		if mode == "raw-denied" {
			w.WriteHeader(403)
			return
		}
		if r.URL.Query().Get("output") == "diff" {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			switch mode {
			case "oversized":
				_, _ = w.Write([]byte(strings.Repeat("x", maxCommitDiffBytes+1)))
			case "invalid-utf8":
				_, _ = w.Write([]byte{0xff})
			case "control":
				_, _ = w.Write([]byte("bad\x00text"))
			case "empty":
			default:
				_, _ = w.Write([]byte(diffFixtureText))
			}
			if mode == "source-after" {
				f.mode.Store("source-denied")
			}
			if mode == "branch-after" {
				f.mode.Store("branch-stale")
			}
			if mode == "identity-after" {
				f.mode.Store("wrong-identity")
			}
			return
		}
		if r.URL.Query().Get("files") != "false" || r.URL.Query().Get("verification") != "false" {
			t.Error("unnecessary native commit files/verification requested")
		}
		w.Header().Set("Content-Type", "application/json")
		row := map[string]any{"sha": strings.Repeat("a", 40), "html_url": "https://forge.invalid/author/fork/commit/" + strings.Repeat("a", 40), "commit": map[string]any{"message": "Literal <script> code", "author": map[string]string{"name": "Alice", "date": "2026-10-03T12:00:00Z"}}}
		rows := []any{row}
		total := 1
		switch mode {
		case "empty":
			rows = []any{}
			total = 0
		case "duplicate":
			rows = append(rows, row)
			total = 2
		case "bad-total":
			total = 2
		case "wrong-commit-repo":
			row["html_url"] = "https://forge.invalid/alice/private/commit/" + strings.Repeat("a", 40)
		case "large-commits":
			rows = make([]any, 501)
			for i := range rows {
				rows[i] = row
			}
			total = len(rows)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"total_commits": total, "commits": rows})
	}))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.ForgePublicURL = provider.URL
	config.ForgeOAuthClientID = "fixture-client"
	config.ForgeOAuthClientSecret = "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func TestRepositoryComparisonPostgres(t *testing.T) {
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			f := newComparisonFixture(t)
			response, err := f.client(t, f.session(t, kind)).GetRepositoryComparison(context.Background(), comparisonRequest())
			if err != nil {
				t.Fatal(err)
			}
			if response.Msg.RawDiff != diffFixtureText || response.Msg.ByteSize != uint32(len(diffFixtureText)) || !proto.Equal(response.Msg.Selection, comparisonRequest().Msg.Selection) || len(response.Msg.Commits) != 1 || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("comparison identity/text/private binding lost")
			}
			if f.posts.Load() != 0 || f.patches.Load() != 0 {
				t.Fatal("comparison dispatched a write")
			}
		})
	}
	for _, tc := range []struct {
		mode string
		code connect.Code
	}{{"empty", 0}, {"missing-scope", connect.CodePermissionDenied}, {"repository-denied", connect.CodeNotFound}, {"wrong-identity", connect.CodeUnauthenticated}, {"source-denied", connect.CodeNotFound}, {"source-rebound", connect.CodeFailedPrecondition}, {"branch-stale", connect.CodeFailedPrecondition}, {"source-after", connect.CodeNotFound}, {"branch-after", connect.CodeFailedPrecondition}, {"identity-after", connect.CodeUnauthenticated}, {"raw-denied", connect.CodePermissionDenied}, {"bad-total", connect.CodeUnavailable}, {"duplicate", connect.CodeUnavailable}, {"wrong-commit-repo", connect.CodeUnavailable}, {"large-commits", connect.CodeResourceExhausted}, {"oversized", connect.CodeResourceExhausted}, {"invalid-utf8", connect.CodeFailedPrecondition}, {"control", connect.CodeFailedPrecondition}} {
		t.Run(tc.mode, func(t *testing.T) {
			f := newComparisonFixture(t)
			client := f.client(t, f.session(t, "pat"))
			f.mode.Store(tc.mode)
			response, err := client.GetRepositoryComparison(context.Background(), comparisonRequest())
			if tc.code == 0 {
				if err != nil || len(response.Msg.Commits) != 0 || response.Msg.RawDiff != "" {
					t.Fatal("empty comparison", err)
				}
				return
			}
			if connect.CodeOf(err) != tc.code {
				t.Fatal(tc.mode, err)
			}
		})
	}
}
func TestRepositoryComparisonRevocationPostgres(t *testing.T) {
	f := newComparisonFixture(t)
	session := f.session(t, "pat")
	client := f.client(t, session)
	f.mode.Store("wait-compare")
	outcome := make(chan error, 1)
	go func() {
		_, err := client.GetRepositoryComparison(context.Background(), comparisonRequest())
		outcome <- err
	}()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("native comparison wait absent")
	}
	hash, _ := sessionHash(session.Value)
	if _, err := f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	f.resume <- struct{}{}
	select {
	case err := <-outcome:
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("revoked comparison disclosed", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("revoked comparison did not settle")
	}
}

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
)

func newPullDiffFixture(t *testing.T) *pullFixture {
	t.Helper()
	f := &pullFixture{db: testDatabase(t), entered: make(chan struct{}, 1), resume: make(chan struct{})}
	f.mode.Store("")
	var reads, retainedReads atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mode := f.mode.Load().(string)
		if r.URL.Path == "/api/v1/repos/alice/private/commits" {
			if r.Method != "GET" || r.URL.Query().Get("sha") != "refs/pull/7/head" || r.URL.Query().Get("limit") != "1" || r.URL.Query().Get("page") != "1" || r.URL.Query().Get("files") != "false" || r.URL.Query().Get("verification") != "false" || r.URL.Query().Get("stat") != "false" {
				t.Error("unexpected retained-head request")
			}
			n := retainedReads.Add(1)
			if mode == "retained-denied" {
				w.WriteHeader(403)
				return
			}
			rows := []forgeCommit{{SHA: strings.Repeat("a", 40)}}
			if mode == "retained-missing" {
				rows = []forgeCommit{}
			}
			if mode == "retained-wrong" || mode == "retained-drift" && n > 1 {
				rows[0].SHA = strings.Repeat("d", 40)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(rows)
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/pulls/7.diff" {
			if r.Method != http.MethodGet || r.Header.Get("Accept") != "text/plain" || r.URL.RawQuery != "" {
				t.Error("unexpected native diff request")
			}
			if mode == "raw-denied" {
				w.WriteHeader(403)
				return
			}
			if mode == "wait-diff" {
				f.entered <- struct{}{}
				select {
				case <-f.resume:
				case <-r.Context().Done():
				}
			}
			w.Header().Set("Content-Type", "text/plain")
			if mode == "oversized" {
				_, _ = w.Write([]byte(strings.Repeat("x", maxCommitDiffBytes+1)))
				return
			}
			if mode == "invalid-utf8" {
				_, _ = w.Write([]byte{0xff})
				return
			}
			_, _ = w.Write([]byte(diffFixtureText))
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/pulls/7" {
			recorder := httptest.NewRecorder()
			f.serveProvider(recorder, r)
			var row forgePull
			_ = json.Unmarshal(recorder.Body.Bytes(), &row)
			row.MergeBase = strings.Repeat("c", 40)
			if mode == "missing-merge-base" {
				row.MergeBase = ""
			}
			if mode == "bad-merge-base" {
				row.MergeBase = "main"
			}
			if mode == "wrong-hash-family" {
				row.MergeBase = strings.Repeat("c", 64)
			}
			if reads.Add(1) > 1 {
				switch mode {
				case "changed-head":
					row.Head.SHA = strings.Repeat("c", 40)
				case "changed-base":
					row.Base.SHA = strings.Repeat("c", 40)
				case "changed-merge-base":
					row.MergeBase = strings.Repeat("d", 40)
				case "changed-pull-id":
					row.ID++
				}
			}
			_ = json.NewEncoder(w).Encode(row)
			return
		}
		f.serveProvider(w, r)
	}))
	t.Cleanup(provider.Close)
	t.Cleanup(func() { close(f.resume) })
	config := testConfig(provider.URL)
	config.GiteaPublicURL, config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestPullDiffSessionWaitPostgres(t *testing.T) {
	f := newPullDiffFixture(t)
	session := f.session(t, "pat")
	client := f.client(t, session)
	f.mode.Store("wait-diff")
	outcome := make(chan error, 1)
	go func() { _, err := client.GetPullRequestDiff(context.Background(), pullDiffRequest()); outcome <- err }()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("diff wait not reached")
	}
	hash, _ := sessionHash(session.Value)
	if _, err := f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	f.resume <- struct{}{}
	select {
	case err := <-outcome:
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("diff outlived revoked session", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("diff did not settle")
	}
}

func pullDiffRequest() *connect.Request[golfv1.GetPullRequestDiffRequest] {
	return connect.NewRequest(&golfv1.GetPullRequestDiffRequest{Repository: pullKey, RepositoryId: "11", PullRequestId: "9007199254740993", Number: 7, BaseCommitId: strings.Repeat("b", 40), HeadCommitId: strings.Repeat("a", 40)})
}

func TestPullDiffRPCPostgres(t *testing.T) {
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			f := newPullDiffFixture(t)
			response, err := f.client(t, f.session(t, kind)).GetPullRequestDiff(context.Background(), pullDiffRequest())
			if err != nil {
				t.Fatal(err)
			}
			if response.Msg.RepositoryId != "11" || response.Msg.PullRequestId != "9007199254740993" || response.Msg.MergeBaseCommitId != strings.Repeat("c", 40) || response.Msg.MergeBaseCommitId == response.Msg.BaseCommitId || response.Msg.RawDiff != diffFixtureText || response.Msg.ByteSize != uint32(len(diffFixtureText)) || response.Msg.HeadCommitId != strings.Repeat("a", 40) || response.Msg.BaseCommitId != strings.Repeat("b", 40) || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("PR snapshot/diff/private response binding lost")
			}
		})
	}
}

func TestPullDiffDenialsPostgres(t *testing.T) {
	for mode, want := range map[string]connect.Code{
		"changed-head": connect.CodeFailedPrecondition, "changed-base": connect.CodeFailedPrecondition,
		"changed-pull-id": connect.CodeFailedPrecondition, "changed-merge-base": connect.CodeFailedPrecondition,
		"missing-merge-base": connect.CodeFailedPrecondition, "bad-merge-base": connect.CodeUnavailable, "wrong-hash-family": connect.CodeUnavailable,
		"retained-missing": connect.CodeFailedPrecondition, "retained-wrong": connect.CodeFailedPrecondition, "retained-drift": connect.CodeFailedPrecondition, "retained-denied": connect.CodePermissionDenied,
		"repository-denied": connect.CodeNotFound, "access-removed": connect.CodeNotFound,
		"repository-rebound": connect.CodeUnavailable, "wrong-base": connect.CodeUnavailable,
		"wrong-identity": connect.CodeUnauthenticated, "revoked": connect.CodeUnauthenticated,
		"missing-scope": connect.CodePermissionDenied, "raw-denied": connect.CodePermissionDenied,
		"oversized": connect.CodeResourceExhausted, "invalid-utf8": connect.CodeFailedPrecondition,
	} {
		t.Run(mode, func(t *testing.T) {
			f := newPullDiffFixture(t)
			f.mode.Store(mode)
			response, err := f.client(t, f.session(t, "pat")).GetPullRequestDiff(context.Background(), pullDiffRequest())
			if connect.CodeOf(err) != want || response != nil {
				t.Fatalf("want %s without private content, got %v", want, err)
			}
		})
	}
	f := newPullDiffFixture(t)
	client := f.client(t, f.session(t, "pat"))
	request := pullDiffRequest()
	request.Msg.BaseCommitId = strings.Repeat("c", 40)
	if _, err := client.GetPullRequestDiff(context.Background(), request); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("stale selection accepted", err)
	}
	for _, id := range []string{"", "main", "HEAD~1", strings.Repeat("A", 40), strings.Repeat("a", 39)} {
		request := pullDiffRequest()
		request.Msg.HeadCommitId = id
		if _, err := client.GetPullRequestDiff(context.Background(), request); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid snapshot accepted", err)
		}
	}
}

func TestPullDiffExactIdentityPostgres(t *testing.T) {
	f := newPullDiffFixture(t)
	client := f.client(t, f.session(t, "pat"))
	for _, field := range []string{"repository", "pull"} {
		for _, value := range []string{"", "0", "01", "+11", "-1", "9223372036854775808"} {
			input := pullDiffRequest()
			if field == "repository" {
				input.Msg.RepositoryId = value
			} else {
				input.Msg.PullRequestId = value
			}
			result, err := client.GetPullRequestDiff(context.Background(), input)
			if connect.CodeOf(err) != connect.CodeInvalidArgument || result != nil {
				t.Fatal("noncanonical target accepted", field, value, err)
			}
		}
		input := pullDiffRequest()
		if field == "repository" {
			input.Msg.RepositoryId = "12"
		} else {
			input.Msg.PullRequestId = "9007199254740994"
		}
		result, err := client.GetPullRequestDiff(context.Background(), input)
		if connect.CodeOf(err) != connect.CodeFailedPrecondition || result != nil {
			t.Fatal("wrong native target accepted", field, err)
		}
	}
}

func TestPullDiffBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
		r := httptest.NewRequest("POST", "/rpc"+golfv1connect.RepositoryServiceGetPullRequestDiffProcedure, strings.NewReader("malformed"))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Connect-Protocol-Version", "1")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		want := 401
		if origin != s.config.PublicURL {
			want = 403
		}
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("diff decoded before authorization", w.Code)
		}
	}
}

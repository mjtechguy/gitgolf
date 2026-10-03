package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func newBoundCommitFixture(t *testing.T) (*pullMutationFixture, *atomic.Int32) {
	t.Helper()
	f := newPullMutationFixture(t)
	reads := &atomic.Int32{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/repos/alice/private/commits" {
			f.serve(w, r)
			return
		}
		reads.Add(1)
		q := r.URL.Query()
		if r.Method != "GET" || q.Get("sha") != strings.Repeat("a", 40) || q.Get("path") != "" || q.Get("files") != "false" || q.Get("stat") != "false" || q.Get("verification") != "false" {
			t.Error("exact history lost native selection")
		}
		mode := f.mode.Load().(string)
		if mode == "wait-history" {
			f.entered <- struct{}{}
			select {
			case <-f.resume:
			case <-r.Context().Done():
			}
		}
		sha := strings.Repeat("a", 40)
		if q.Get("page") == "2" || mode == "wrong-head" {
			sha = strings.Repeat("b", 40)
		}
		row := workspaceCommit(sha)
		rows := []any{row}
		switch mode {
		case "empty":
			rows = []any{}
		case "bad-date":
			row["commit"].(map[string]any)["author"].(map[string]string)["date"] = "yesterday"
		case "bad-name":
			row["commit"].(map[string]any)["author"].(map[string]string)["name"] = "unsafe\x00"
		}
		w.Header().Set("Link", "<http://forge.invalid/?page=2>; rel=\"next\"")
		_ = json.NewEncoder(w).Encode(rows)
		if mode == "access-after" {
			f.mode.Store("repository-denied")
		}
	}))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.GiteaPublicURL, config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f, reads
}

func TestBoundCommitReceiptPostgres(t *testing.T) {
	f, reads := newBoundCommitFixture(t)
	client := f.client(t, f.session(t, "pat"))
	for _, page := range []uint32{1, 2} {
		response, err := client.ListCommits(t.Context(), connect.NewRequest(&golfv1.ListCommitsRequest{Repository: pullKey, RepositoryId: "11", Ref: strings.Repeat("a", 40), Page: &golfv1.PageRequest{Page: page, Limit: 1}}))
		if err != nil {
			t.Fatal(err)
		}
		want := strings.Repeat("a", 40)
		if page == 2 {
			want = strings.Repeat("b", 40)
		}
		if response.Msg.RepositoryId != "11" || response.Msg.CommitId != strings.Repeat("a", 40) || response.Msg.Path != "" || len(response.Msg.Commits) != 1 || response.Msg.Commits[0].Sha != want || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("wrong immutable selection receipt", response.Msg)
		}
	}
	if reads.Load() != 3 {
		t.Fatal("latest commit duplicated reads or later page lost anchor check", reads.Load())
	}
}

func TestBoundCommitDenialsPostgres(t *testing.T) {
	for _, mode := range []string{"wrong-head", "empty", "bad-date", "bad-name", "repository-denied", "repository-rebound", "access-after"} {
		t.Run(mode, func(t *testing.T) {
			f, _ := newBoundCommitFixture(t)
			client := f.client(t, f.session(t, "pat"))
			f.mode.Store(mode)
			response, err := client.ListCommits(t.Context(), connect.NewRequest(&golfv1.ListCommitsRequest{Repository: pullKey, RepositoryId: "11", Ref: strings.Repeat("a", 40), Page: &golfv1.PageRequest{Limit: 1}}))
			want := connect.CodeUnavailable
			if mode == "repository-denied" || mode == "access-after" {
				want = connect.CodeNotFound
			}
			if response != nil || connect.CodeOf(err) != want {
				t.Fatal("invalid snapshot released", err, want)
			}
		})
	}
	f, reads := newBoundCommitFixture(t)
	client := f.client(t, f.session(t, "pat"))
	for _, tc := range []struct{ id, ref string }{{"11", "main"}, {"11", ""}, {"011", strings.Repeat("a", 40)}, {"12", strings.Repeat("a", 40)}} {
		if _, err := client.ListCommits(t.Context(), connect.NewRequest(&golfv1.ListCommitsRequest{Repository: pullKey, RepositoryId: tc.id, Ref: tc.ref})); err == nil || reads.Load() != 0 {
			t.Fatal("invalid exact selection reached native history", tc, err)
		}
	}
}

func TestBoundCommitRevocationPostgres(t *testing.T) {
	f, _ := newBoundCommitFixture(t)
	session := f.session(t, "pat")
	client := f.client(t, session)
	f.mode.Store("wait-history")
	outcome := make(chan error, 1)
	go func() {
		_, err := client.ListCommits(t.Context(), connect.NewRequest(&golfv1.ListCommitsRequest{Repository: pullKey, RepositoryId: "11", Ref: strings.Repeat("a", 40), Page: &golfv1.PageRequest{Limit: 1}}))
		outcome <- err
	}()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("history wait absent")
	}
	hash, _ := sessionHash(session.Value)
	if _, err := f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	f.resume <- struct{}{}
	select {
	case err := <-outcome:
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("revoked private history released", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("history revocation did not settle")
	}
}

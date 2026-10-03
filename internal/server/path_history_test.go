package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func pathHistoryRequest(page, limit uint32) *connect.Request[golfv1.ListCommitsRequest] {
	return connect.NewRequest(&golfv1.ListCommitsRequest{Repository: pullKey, RepositoryId: "11", Ref: strings.Repeat("a", 40), Path: "src/[literal]* 世界.ts", Page: &golfv1.PageRequest{Page: page, Limit: limit}})
}
func newPathHistoryFixture(t *testing.T, span, total int) (*pullMutationFixture, *atomic.Int32) {
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
		if r.Method != "GET" || q.Get("sha") != strings.Repeat("a", 40) || q.Get("path") != ":(literal)src/[literal]* 世界.ts" || q.Get("limit") != "100" || q.Get("files") != "false" || q.Get("verification") != "false" || q.Get("stat") != "false" {
			t.Error("lost exact literal bounded path selection")
		}
		mode := f.mode.Load().(string)
		if mode == "payload-denied" {
			w.WriteHeader(403)
			return
		}
		if mode == "wait-path" {
			f.entered <- struct{}{}
			select {
			case <-f.resume:
			case <-r.Context().Done():
			}
		}
		page, _ := strconv.Atoi(q.Get("page"))
		offset := (page - 1) * span
		rows := []any{}
		for i := offset; i < min(offset+span, total); i++ {
			rows = append(rows, workspaceCommit(fmt.Sprintf("%040x", i+1)))
		}
		count := strconv.Itoa(total)
		switch mode {
		case "bad-count":
			count = "0" + count
		case "missing-count":
			count = ""
		case "count-drift":
			if page > 1 {
				count = strconv.Itoa(total + 1)
			}
		case "short-page":
			if page > 1 {
				rows = rows[:len(rows)-1]
			}
		case "empty":
			rows = []any{}
		case "duplicate":
			if len(rows) > 1 {
				rows[1] = rows[0]
			}
		case "bad-sha":
			rows[0] = workspaceCommit(strings.Repeat("A", 40))
		case "bad-date":
			row := workspaceCommit(strings.Repeat("b", 40))
			row["commit"].(map[string]any)["author"].(map[string]string)["date"] = "tomorrow"
			rows[0] = row
		}
		w.Header().Set("X-Total", count)
		w.Header().Set("Link", "<https://forge.invalid/wrong?limit=100&page=2>; rel=\"next\"")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(rows)
		if mode == "access-after" {
			f.mode.Store("repository-denied")
		}
		if mode == "identity-after" {
			f.mode.Store("wrong-identity")
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
func TestPathHistoryPaginationPostgres(t *testing.T) {
	for _, span := range []int{1, 7, 50} {
		t.Run(fmt.Sprint(span), func(t *testing.T) {
			f, reads := newPathHistoryFixture(t, span, 63)
			client := f.client(t, f.session(t, "pat"))
			var all []string
			for page := uint32(1); page <= 4; page++ {
				response, err := client.ListCommits(context.Background(), pathHistoryRequest(page, 20))
				if err != nil {
					t.Fatal(err)
				}
				if response.Msg.RepositoryId != "11" || response.Msg.Path != pathHistoryRequest(1, 20).Msg.Path || response.Msg.CommitId != strings.Repeat("a", 40) || response.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("missing exact private selection")
				}
				for _, row := range response.Msg.Commits {
					all = append(all, row.Sha)
				}
				want := uint32(0)
				if page < 4 {
					want = page + 1
				}
				if response.Msg.Page.NextPage != want {
					t.Fatal("wrong next page", response.Msg.Page)
				}
			}
			if len(all) != 63 {
				t.Fatal("skipped commits", len(all))
			}
			for i, sha := range all {
				if sha != fmt.Sprintf("%040x", i+1) {
					t.Fatal("native order changed", i, sha)
				}
			}
			response, err := client.ListCommits(context.Background(), pathHistoryRequest(5, 20))
			if err != nil || len(response.Msg.Commits) != 0 || response.Msg.Page.NextPage != 0 {
				t.Fatal("past-end history", err)
			}
			if reads.Load() > 72 {
				t.Fatal("unbounded native requests", reads.Load())
			}
		})
	}
}
func TestPathHistoryDenialsPostgres(t *testing.T) {
	for _, tc := range []struct {
		mode string
		code connect.Code
	}{
		{"payload-denied", connect.CodePermissionDenied}, {"bad-count", connect.CodeUnavailable}, {"missing-count", connect.CodeUnavailable}, {"count-drift", connect.CodeUnavailable}, {"short-page", connect.CodeUnavailable}, {"empty", connect.CodeUnavailable}, {"duplicate", connect.CodeUnavailable}, {"bad-sha", connect.CodeUnavailable}, {"bad-date", connect.CodeUnavailable}, {"repository-denied", connect.CodeNotFound}, {"repository-rebound", connect.CodeUnavailable}, {"access-after", connect.CodeNotFound}, {"identity-after", connect.CodeUnauthenticated},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			f, _ := newPathHistoryFixture(t, 7, 63)
			client := f.client(t, f.session(t, "pat"))
			f.mode.Store(tc.mode)
			response, err := client.ListCommits(context.Background(), pathHistoryRequest(2, 20))
			if response != nil || connect.CodeOf(err) != tc.code {
				t.Fatal("invalid history released", err)
			}
		})
	}
	f, reads := newPathHistoryFixture(t, 7, 63)
	client := f.client(t, f.session(t, "pat"))
	req := pathHistoryRequest(1, 20)
	req.Msg.RepositoryId = "12"
	_, err := client.ListCommits(context.Background(), req)
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || reads.Load() != 0 {
		t.Fatal("rebound selection dispatched", err)
	}
}
func TestPathHistoryRevocationPostgres(t *testing.T) {
	f, _ := newPathHistoryFixture(t, 50, 63)
	session := f.session(t, "pat")
	client := f.client(t, session)
	f.mode.Store("wait-path")
	outcome := make(chan error, 1)
	go func() { _, err := client.ListCommits(context.Background(), pathHistoryRequest(1, 20)); outcome <- err }()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("path wait absent")
	}
	hash, _ := sessionHash(session.Value)
	if _, err := f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	f.resume <- struct{}{}
	select {
	case err := <-outcome:
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("revoked path released", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("revocation did not settle")
	}
}
func TestPathHistoryBoundary(t *testing.T) {
	for _, tc := range []struct {
		ref, path string
		page      pageRequest
	}{
		{"main", "src/file", pageRequest{}}, {strings.Repeat("A", 40), "src/file", pageRequest{}}, {strings.Repeat("a", 40), "../private", pageRequest{}}, {strings.Repeat("a", 40), "src/file", pageRequest{Page: 10001}}, {strings.Repeat("a", 40), "src/file", pageRequest{Limit: 101}},
	} {
		_, _, err := (&Server{}).listPathCommits(context.Background(), "", forgeCredential{}, repositoryKey{}, 11, tc.ref, tc.path, tc.page)
		if err == nil {
			t.Fatal("invalid path boundary accepted")
		}
	}
}

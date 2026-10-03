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

func TestInventoryPageBounds(t *testing.T) {
	for _, span := range []int{1, 7, 50, 100} {
		t.Run(strconv.Itoa(span), func(t *testing.T) {
			for _, limit := range []uint32{1, 20, 100} {
				all := []int{}
				for page := uint32(1); ; page++ {
					rows, next, total, err := inventoryPage(pageRequest{page, limit}, func(p uint32) ([]int, int64, error) {
						a := []int{}
						for i := int(p-1) * span; i < min(int(p)*span, 123); i++ {
							a = append(a, i)
						}
						return a, 123, nil
					})
					if err != nil || total != 123 || len(rows) > int(limit) {
						t.Fatal("invalid sliced page", rows, next, total, err)
					}
					all = append(all, rows...)
					if next == 0 {
						break
					}
					if next != page+1 {
						t.Fatal("invalid continuation", next)
					}
				}
				if len(all) != 123 {
					t.Fatal("inventory truncated", len(all))
				}
				for i, row := range all {
					if row != i {
						t.Fatal("inventory skipped or duplicated", i, row)
					}
				}
			}
		})
	}
	for _, value := range []string{"", "01", "-1", "+1", "1.5", "9223372036854775808"} {
		if _, err := inventoryTotal(http.Header{"X-Total-Count": {value}}); err == nil {
			t.Fatal("invalid native total accepted", value)
		}
	}
	for _, value := range []string{"0", "123", "9223372036854775807"} {
		if _, err := inventoryTotal(http.Header{"X-Total-Count": {value}}); err != nil {
			t.Fatal("canonical total rejected", value, err)
		}
	}
	if _, err := inventoryTotal(http.Header{"X-Total-Count": {"1", "2"}}); err == nil {
		t.Fatal("ambiguous count accepted")
	}
}

func newInventoryFixture(t *testing.T, span, total int) (*pullMutationFixture, *atomic.Int32) {
	t.Helper()
	f := newPullMutationFixture(t)
	reads := &atomic.Int32{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/repos/alice/private" && f.mode.Load().(string) == "empty-native" {
			_ = json.NewEncoder(w).Encode(Repository{ID: 11, Name: "private", FullName: "alice/private", HTMLURL: "https://forge.invalid/alice/private", Private: true, Empty: true})
			return
		}
		isTag := r.URL.Path == "/api/v1/repos/alice/private/tags"
		if !isTag && r.URL.Path != "/api/v1/repos/alice/private/branches" {
			f.serve(w, r)
			return
		}
		reads.Add(1)
		if r.Method != "GET" || r.URL.Query().Get("limit") != "100" || r.Header.Get("Authorization") != "token pull-pat" {
			t.Error("inventory lost bounded read-only native request")
		}
		mode := f.mode.Load().(string)
		if mode == "payload-denied" {
			w.WriteHeader(403)
			return
		}
		if mode == "wait-inventory" {
			f.entered <- struct{}{}
			select {
			case <-f.resume:
			case <-r.Context().Done():
			}
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		rows := []any{}
		for i := (page - 1) * span; i < min(page*span, total); i++ {
			name := fmt.Sprintf("v%03d/雪", i)
			if isTag {
				rows = append(rows, map[string]any{"name": name, "id": fmt.Sprintf("%040x", i+1001), "message": "Annotated <tag>\n", "commit": map[string]string{"sha": fmt.Sprintf("%040x", i+1)}})
			} else {
				rows = append(rows, map[string]any{"name": name, "protected": i == 0, "commit": map[string]string{"id": fmt.Sprintf("%040x", i+1)}})
			}
		}
		count := strconv.Itoa(total)
		switch mode {
		case "missing-count":
			count = ""
		case "bad-count":
			count = "0" + count
		case "count-drift":
			if page > 1 {
				count = strconv.Itoa(total + 1)
			}
		case "short-page":
			if page > 1 {
				rows = rows[:len(rows)-1]
			}
		case "empty-page":
			rows = []any{}
		case "duplicate":
			rows[1] = rows[0]
		case "bad-ref":
			rows[0].(map[string]any)["name"] = "main~1"
		case "bad-commit":
			field := "id"
			if isTag {
				field = "sha"
			}
			rows[0].(map[string]any)["commit"].(map[string]string)[field] = strings.Repeat("A", 40)
		case "bad-tag-id":
			rows[0].(map[string]any)["id"] = "short"
		case "bad-message":
			rows[0].(map[string]any)["message"] = "control\x00"
		}
		w.Header().Set("X-Total-Count", count)
		// Deliberately no Link: the pinned native tags route has none.
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

func TestRepositoryInventoryPaginationPostgres(t *testing.T) {
	for _, span := range []int{1, 7, 50} {
		t.Run(strconv.Itoa(span), func(t *testing.T) {
			f, reads := newInventoryFixture(t, span, 63)
			client := f.client(t, f.session(t, "pat"))
			for _, kind := range []string{"tags", "branches"} {
				all := []string{}
				for page := uint32(1); page <= 4; page++ {
					var names []string
					var count *string
					var id string
					var next uint32
					if kind == "tags" {
						response, err := client.ListTags(t.Context(), connect.NewRequest(&golfv1.ListTagsRequest{Repository: pullKey, RepositoryId: "11", Page: &golfv1.PageRequest{Page: page, Limit: 20}}))
						if err != nil {
							t.Fatal(err)
						}
						for _, row := range response.Msg.Tags {
							if row.Id == row.CommitId || row.Message != "Annotated <tag>\n" {
								t.Fatal("tag-object identity was conflated with source commit")
							}
							names = append(names, row.Name)
						}
						count, id, next = response.Msg.TotalCount, response.Msg.RepositoryId, response.Msg.Page.NextPage
						if response.Header().Get("Cache-Control") != "no-store" {
							t.Fatal("private tags cacheable")
						}
					} else {
						response, err := client.ListBranches(t.Context(), connect.NewRequest(&golfv1.ListBranchesRequest{Repository: pullKey, RepositoryId: "11", Page: &golfv1.PageRequest{Page: page, Limit: 20}}))
						if err != nil {
							t.Fatal(err)
						}
						for _, row := range response.Msg.Branches {
							names = append(names, row.Name)
						}
						count, id, next = response.Msg.TotalCount, response.Msg.RepositoryId, response.Msg.Page.NextPage
					}
					wantNext := page + 1
					if page == 4 {
						wantNext = 0
					}
					if count == nil || *count != "63" || id != "11" || next != wantNext || len(names) != min(20, 63-int(page-1)*20) {
						t.Fatal("loaded count posed as total or wrong paging", kind, count, id, next, len(names))
					}
					all = append(all, names...)
				}
				for i, name := range all {
					if name != fmt.Sprintf("v%03d/雪", i) {
						t.Fatal("inventory skipped or repeated", kind, i, name)
					}
				}
			}
			if reads.Load() > 144 {
				t.Fatal("unbounded inventory reads", reads.Load())
			}
		})
	}
}

func TestRepositoryInventoryDenialsPostgres(t *testing.T) {
	for _, kind := range []string{"tags", "branches"} {
		for _, mode := range []string{"payload-denied", "missing-count", "bad-count", "count-drift", "short-page", "empty-page", "duplicate", "bad-ref", "bad-commit", "repository-denied", "repository-rebound", "access-after", "identity-after"} {
			t.Run(kind+"/"+mode, func(t *testing.T) {
				f, _ := newInventoryFixture(t, 7, 63)
				client := f.client(t, f.session(t, "pat"))
				f.mode.Store(mode)
				var err error
				if kind == "tags" {
					response, e := client.ListTags(t.Context(), connect.NewRequest(&golfv1.ListTagsRequest{Repository: pullKey, RepositoryId: "11", Page: &golfv1.PageRequest{Page: 2, Limit: 20}}))
					err = e
					if response != nil {
						t.Fatal("invalid private tags released")
					}
				} else {
					response, e := client.ListBranches(t.Context(), connect.NewRequest(&golfv1.ListBranchesRequest{Repository: pullKey, RepositoryId: "11", Page: &golfv1.PageRequest{Page: 2, Limit: 20}}))
					err = e
					if response != nil {
						t.Fatal("invalid private branches released")
					}
				}
				want := connect.CodeUnavailable
				switch mode {
				case "payload-denied":
					want = connect.CodePermissionDenied
				case "repository-denied", "access-after":
					want = connect.CodeNotFound
				case "identity-after":
					want = connect.CodeUnauthenticated
				}
				if connect.CodeOf(err) != want {
					t.Fatal("wrong denial", err, want)
				}
			})
		}
	}
	for _, mode := range []string{"bad-tag-id", "bad-message"} {
		f, _ := newInventoryFixture(t, 7, 63)
		client := f.client(t, f.session(t, "pat"))
		f.mode.Store(mode)
		if _, err := client.ListTags(t.Context(), connect.NewRequest(&golfv1.ListTagsRequest{Repository: pullKey, RepositoryId: "11"})); connect.CodeOf(err) != connect.CodeUnavailable {
			t.Fatal("invalid tag object accepted", mode, err)
		}
	}
	f, reads := newInventoryFixture(t, 7, 63)
	client := f.client(t, f.session(t, "pat"))
	for _, id := range []string{"", "011", "-1", "9223372036854775808", "12"} {
		if _, err := client.ListTags(t.Context(), connect.NewRequest(&golfv1.ListTagsRequest{Repository: pullKey, RepositoryId: id})); err == nil || reads.Load() != 0 {
			t.Fatal("missing/rebound/noncanonical identity dispatched", id, err)
		}
	}
}

func TestRepositoryInventoryRevocationPostgres(t *testing.T) {
	f, _ := newInventoryFixture(t, 50, 63)
	session := f.session(t, "pat")
	client := f.client(t, session)
	f.mode.Store("wait-inventory")
	outcome := make(chan error, 1)
	go func() {
		_, err := client.ListTags(context.Background(), connect.NewRequest(&golfv1.ListTagsRequest{Repository: pullKey, RepositoryId: "11"}))
		outcome <- err
	}()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("inventory wait absent")
	}
	hash, _ := sessionHash(session.Value)
	if _, err := f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	f.resume <- struct{}{}
	select {
	case err := <-outcome:
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("revoked private inventory released", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("inventory revocation did not settle")
	}
}

func TestRepositoryInventoryEmptyPostgres(t *testing.T) {
	f, reads := newInventoryFixture(t, 50, 0)
	client := f.client(t, f.session(t, "pat"))
	response, err := client.ListTags(t.Context(), connect.NewRequest(&golfv1.ListTagsRequest{Repository: pullKey, RepositoryId: "11"}))
	if err != nil || response.Msg.TotalCount == nil || response.Msg.GetTotalCount() != "0" || len(response.Msg.Tags) != 0 || response.Msg.Page.NextPage != 0 {
		t.Fatal("verified empty tags lost", err)
	}
	f.mode.Store("empty-native")
	before := reads.Load()
	branches, err := client.ListBranches(t.Context(), connect.NewRequest(&golfv1.ListBranchesRequest{Repository: pullKey, RepositoryId: "11"}))
	if err != nil || branches.Msg.TotalCount != nil || branches.Msg.RepositoryId != "11" || len(branches.Msg.Branches) != 0 || reads.Load() != before {
		t.Fatal("empty native metadata invented count or dispatched first-push race", err)
	}
}

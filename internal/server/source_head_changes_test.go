package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func headChangesPayload(head string) map[string]any {
	row := workspaceCommit(head)
	row["parents"] = []any{map[string]string{"sha": strings.Repeat("b", len(head))}}
	row["files"] = []any{
		map[string]string{"filename": "[literal]* 世界.ts", "status": "modified"},
		map[string]string{"filename": "nested/deleted.ts", "status": "removed"},
		map[string]string{"filename": "prefix-neighbor.ts", "status": "added"},
	}
	return row
}

func TestHeadChangeProjectionLiteralAndBounds(t *testing.T) {
	head := strings.Repeat("a", 40)
	for _, mode := range []string{"normal", "root", "merge", "wrong-head", "missing-parents", "missing-files", "unknown-status", "duplicate", "unsafe-path", "truncated", "oversize", "bad-author", "bad-parent", "too-many-files"} {
		t.Run(mode, func(t *testing.T) {
			row := headChangesPayload(head)
			switch mode {
			case "root":
				row["parents"] = []any{}
			case "merge":
				row["parents"] = []any{map[string]string{"sha": strings.Repeat("b", 40)}, map[string]string{"sha": strings.Repeat("c", 40)}}
			case "wrong-head":
				row["sha"] = strings.Repeat("b", 40)
			case "missing-parents":
				delete(row, "parents")
			case "missing-files":
				delete(row, "files")
			case "unknown-status":
				row["files"] = []any{map[string]string{"filename": "x", "status": "renamed"}}
			case "duplicate":
				row["files"] = append(row["files"].([]any), row["files"].([]any)[0])
			case "unsafe-path":
				row["files"] = []any{map[string]string{"filename": "../x", "status": "added"}}
			case "truncated":
				row["truncated"] = true
			case "oversize":
				row["extra"] = strings.Repeat("x", 256<<10)
			case "bad-author":
				row["commit"].(map[string]any)["author"].(map[string]string)["date"] = "yesterday"
			case "too-many-files":
				row["files"] = make([]any, maxDirectoryEntries+1)
			case "bad-parent":
				row["parents"] = []any{map[string]string{"sha": head}}
			}
			raw, _ := json.Marshal(row)
			_, paths, ok := validatedHeadChanges(raw, head)
			want := mode == "normal" || mode == "root"
			if ok != want || want && len(paths) != 3 {
				t.Fatalf("projection admission %s: %v", mode, ok)
			}
		})
	}
	reads := 0
	wide := false
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads++
		if r.URL.Path != "/api/v1/repos/a/r/git/commits/"+head || r.URL.Query().Get("files") != "true" || r.URL.Query().Get("stat") != "false" || r.URL.Query().Get("verification") != "false" {
			t.Error("not one exact selected-head projection read")
		}
		row := headChangesPayload(head)
		if wide {
			row["commit"].(map[string]any)["message"] = strings.Repeat("m", 2048)
			files := make([]any, 1000)
			for i := range files {
				files[i] = map[string]string{"filename": fmt.Sprintf("row-%d", i), "status": "modified"}
			}
			row["files"] = files
		}
		json.NewEncoder(w).Encode(row)
	}))
	defer provider.Close()
	s, _ := New(testConfig(provider.URL), nil)
	entries := []sourceEntry{{Path: "[literal]* 世界.ts", Type: "file"}, {Path: "nested", Type: "dir"}, {Path: "prefix", Type: "file"}, {Path: "nested/deleted.ts", Type: "file"}, {Path: "untouched", Type: "file"}}
	if err := s.projectHeadChanges(t.Context(), "/repos/a/r", forgeCredential{Kind: "pat", Token: "fixture"}, head, entries); err != nil {
		t.Fatal(err)
	}
	for i, row := range entries {
		if (row.LatestChange != nil) != (i < 2) {
			t.Fatalf("literal projection %q incorrectly admitted", row.Path)
		}
	}
	if reads != 1 {
		t.Fatal("per-path reads disguised as projection", reads)
	}
	wide = true
	many := make([]sourceEntry, 1000)
	for i := range many {
		many[i] = sourceEntry{Path: fmt.Sprintf("row-%d", i), Type: "file"}
	}
	if err := s.projectHeadChanges(t.Context(), "/repos/a/r", forgeCredential{Kind: "pat", Token: "fixture"}, head, many); err != nil {
		t.Fatal(err)
	}
	for _, entry := range many {
		if entry.LatestChange != nil {
			t.Fatal("unbounded repeated metadata admitted")
		}
	}
	if reads != 2 {
		t.Fatal("wide directory projection used per-path reads")
	}
}

func TestHeadChangeProjectionSourceAuthorityPostgres(t *testing.T) {
	for _, mode := range []string{"ok", "opt-out", "file", "merge", "wrong-id", "legacy-opt-in", "payload-denied", "access-after", "caller-after", "malformed", "unavailable", "no-op"} {
		t.Run(mode, func(t *testing.T) {
			head := strings.Repeat("a", 40)
			f := newPullMutationFixture(t)
			reads := &atomic.Int32{}
			objects := newSourceObjectFixture(head, map[string]string{"[literal]* 世界.ts": "x", "nested/alive.ts": "x", "untouched": "x"}, nil)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/repos/alice/private/git/commits/"+head && r.URL.Query().Get("files") == "true" {
					reads.Add(1)
					if mode == "payload-denied" {
						w.WriteHeader(403)
						return
					}
					row := headChangesPayload(head)
					if mode == "malformed" {
						delete(row, "files")
					}
					if mode == "unavailable" {
						w.WriteHeader(500)
						return
					}
					if mode == "no-op" {
						row["files"] = []any{}
					}
					if mode == "merge" {
						row["parents"] = []any{map[string]string{"sha": strings.Repeat("b", 40)}, map[string]string{"sha": strings.Repeat("c", 40)}}
					}
					json.NewEncoder(w).Encode(row)
					if mode == "access-after" {
						f.mode.Store("repository-denied")
					}
					if mode == "caller-after" {
						f.mode.Store("revoked")
					}
					return
				}
				if objects.serve(w, r, "/api/v1/repos/alice/private") {
					return
				}
				f.serve(w, r)
			}))
			defer provider.Close()
			config := testConfig(provider.URL)
			config.GiteaPublicURL, config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
			var err error
			f.s, err = New(config, f.db)
			if err != nil {
				t.Fatal(err)
			}
			input := &golfv1.GetContentsRequest{Repository: pullKey, RepositoryId: "11", Ref: head, IncludeLatestChanges: mode != "opt-out"}
			if mode == "file" {
				input.Path = "untouched"
			}
			if mode == "wrong-id" {
				input.RepositoryId = "12"
			}
			if mode == "legacy-opt-in" {
				input.RepositoryId = ""
			}
			response, err := f.client(t, f.session(t, "pat")).GetContents(t.Context(), connect.NewRequest(input))
			deny := mode == "wrong-id" || mode == "legacy-opt-in" || mode == "payload-denied" || mode == "access-after" || mode == "caller-after"
			if deny {
				if err == nil || response != nil {
					t.Fatal("authority/identity failure disclosed projection")
				}
				if mode == "wrong-id" || mode == "legacy-opt-in" {
					if reads.Load() != 0 {
						t.Fatal("invalid selection probed projection")
					}
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if response.Msg.RepositoryId != "11" || response.Msg.CommitId != head || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("unbound/private projection response")
			}
			count := 0
			for _, entry := range response.Msg.Entries {
				if entry.LatestChange != nil {
					count++
					if entry.LatestChange.Sha != head {
						t.Fatal("false head")
					}
				}
			}
			expected := 0
			if mode == "ok" {
				expected = 2
			}
			if count != expected {
				t.Fatal("unexpected projected rows", count)
			}
			wantReads := int32(1)
			if mode == "opt-out" || mode == "file" {
				wantReads = 0
			}
			if reads.Load() != wantReads {
				t.Fatal("extra/cold per-path native calls", reads.Load())
			}
		})
	}
}

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

const diffFixtureText = "diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\ndiff --git a/binary b/binary\nBinary files a/binary and b/binary differ\n"

// Reuse the established private-repository/caller fixture to exercise the same
// checks that protect PR reads, with actual PostgreSQL sessions and RPC I/O.
func newDiffFixture(t *testing.T) *pullFixture {
	t.Helper()
	f := &pullFixture{db: testDatabase(t), entered: make(chan struct{}, 1), resume: make(chan struct{})}
	f.mode.Store("")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/git/commits/") {
			if f.mode.Load() == "empty-repository" && r.URL.Path == "/api/v1/repos/alice/private" {
				_ = json.NewEncoder(w).Encode(Repository{ID: 11, Name: "private", FullName: "alice/private", HTMLURL: "https://forge.invalid/alice/private", Empty: true})
				return
			}
			f.serveProvider(w, r)
			return
		}
		if r.Method != http.MethodGet || (r.Header.Get("Authorization") != "token pull-pat" && r.Header.Get("Authorization") != "Bearer pull-oauth") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		mode := f.mode.Load().(string)
		sha := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/v1/repos/alice/private/git/commits/"), ".diff")
		if mode == "commit-missing" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if !strings.HasSuffix(r.URL.Path, ".diff") {
			if r.URL.Query().Get("files") != "false" || r.URL.Query().Get("stat") != "false" || r.URL.Query().Get("verification") != "false" || r.Header.Get("Accept") != "application/json" {
				t.Error("commit metadata requested expensive native projections")
				w.WriteHeader(500)
				return
			}
			parents := []map[string]string{{"sha": strings.Repeat("b", len(sha))}}
			if mode == "root" {
				parents = []map[string]string{}
			} else if mode == "merge" {
				parents = append(parents, map[string]string{"sha": strings.Repeat("c", len(sha))})
			} else if mode == "missing-parents" {
				parents = nil
			} else if mode == "invalid-parent" {
				parents[0]["sha"] = "main"
			} else if mode == "self-parent" {
				parents[0]["sha"] = sha
			} else if mode == "wrong-parent-format" {
				parents[0]["sha"] = strings.Repeat("b", 64)
			} else if mode == "too-many-parents" {
				parents = make([]map[string]string, maxCommitDiffParents+1)
			}
			row := map[string]any{"sha": sha, "html_url": "https://forge.invalid/alice/private/commit/" + sha,
				"commit": map[string]any{"message": "Native commit\n", "author": map[string]any{"name": "Alice", "date": "2026-10-02T12:00:00Z"}}, "parents": parents}
			if mode == "wrong-sha" {
				row["sha"] = strings.Repeat("d", len(sha))
			} else if mode == "wrong-commit-url" {
				row["html_url"] = "https://forge.invalid/bob/other/commit/" + sha
			} else if mode == "public-commit-origin" {
				row["html_url"] = "https://public-forge.invalid/alice/private/commit/" + sha
			} else if mode == "invalid-commit-url" {
				row["html_url"] = "file:///alice/private/commit/" + sha
			} else if mode == "commit-url-query" {
				row["html_url"] = "https://forge.invalid/alice/private/commit/" + sha + "?other=1"
			} else if mode == "missing-metadata" {
				row["commit"] = nil
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(row)
			return
		}
		if r.Header.Get("Accept") != "text/plain" || r.URL.RawQuery != "" {
			t.Error("raw diff request does not use qualified endpoint")
		}
		if mode == "wait-diff" {
			f.entered <- struct{}{}
			select {
			case <-f.resume:
			case <-r.Context().Done():
			}
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		body := diffFixtureText
		switch mode {
		case "root":
			body = "commit " + sha + "\nAuthor: Alice <native@example.invalid>\nDate:   Fri Oct 2 12:00:00 2026 +0000\n\n    Native commit\n\n" + body
		case "empty":
			body = ""
		case "unicode":
			body += "+résumé 日本語\t\r\n\\ No newline at end of file\n"
		case "exact-bound":
			body = strings.Repeat("x", maxCommitDiffBytes)
		case "oversized":
			body = strings.Repeat("x", maxCommitDiffBytes+1)
		case "oversized-length":
			w.Header().Set("Content-Length", strconv.Itoa(maxCommitDiffBytes+1))
		case "truncated":
			w.Header().Set("Content-Length", "10000")
		case "invalid-utf8":
			body = string([]byte{0xff})
		case "escape":
			body = "+\x1b[31munsafe\n"
		case "nul":
			body = "+\x00\n"
		case "c1-control":
			body = "+\u0085\n"
		case "json-response":
			w.Header().Set("Content-Type", "application/json")
			body = `{"message":"provider failure"}`
		case "partial-status":
			w.WriteHeader(http.StatusPartialContent)
		case "redirect":
			w.Header().Set("Location", "/must-not-follow")
			w.WriteHeader(http.StatusFound)
			return
		case "raw-denied":
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = fmt.Fprint(w, body)
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

func diffRequest(sha string) *connect.Request[golfv1.GetCommitDiffRequest] {
	return connect.NewRequest(&golfv1.GetCommitDiffRequest{Repository: pullKey, CommitId: sha})
}

func TestCommitDiffBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
		r := httptest.NewRequest("POST", "/rpc"+golfv1connect.RepositoryServiceGetCommitDiffProcedure, strings.NewReader("malformed"))
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
			t.Fatalf("diff decoded before auth/origin or lost no-store: %d", w.Code)
		}
	}
}

func TestCommitDiffRPCPostgres(t *testing.T) {
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			f := newDiffFixture(t)
			client := f.client(t, f.session(t, kind))
			for _, mode := range []string{"", "root", "merge", "empty", "unicode", "exact-bound", "public-commit-origin"} {
				for _, length := range []int{40, 64} {
					f.mode.Store(mode)
					sha := strings.Repeat("a", length)
					response, err := client.GetCommitDiff(context.Background(), diffRequest(sha))
					if err != nil {
						t.Fatalf("%s/%d: %v", mode, length, err)
					}
					row := response.Msg
					if row.Commit.Sha != sha || row.ByteSize != uint32(len(row.RawDiff)) || response.Header().Get("Cache-Control") != "no-store" {
						t.Fatal("commit binding, byte size or private response metadata lost")
					}
					if mode == "root" {
						if row.Base != golfv1.CommitDiffBase_COMMIT_DIFF_BASE_ROOT || row.BaseCommitId != "" || len(row.ParentCommitIds) != 0 || !strings.HasPrefix(row.RawDiff, "commit "+sha) {
							t.Fatal("native root preamble or root base changed")
						}
					} else if row.Base != golfv1.CommitDiffBase_COMMIT_DIFF_BASE_FIRST_PARENT || row.BaseCommitId != strings.Repeat("b", length) || row.ParentCommitIds[0] != row.BaseCommitId {
						t.Fatal("first parent binding changed")
					}
					if mode == "merge" && (len(row.ParentCommitIds) != 2 || row.ParentCommitIds[1] != strings.Repeat("c", length)) {
						t.Fatal("native merge parent ordering changed")
					}
					if mode == "" && row.RawDiff != diffFixtureText || mode == "empty" && row.RawDiff != "" || mode == "exact-bound" && row.ByteSize != maxCommitDiffBytes {
						t.Fatal("raw content altered or valid bound rejected")
					}
				}
			}
		})
	}
}

func TestCommitDiffDenialsPostgres(t *testing.T) {
	cases := map[string]connect.Code{
		"wrong-identity": connect.CodeUnauthenticated, "revoked": connect.CodeUnauthenticated,
		"repository-denied": connect.CodeNotFound, "access-removed": connect.CodeNotFound, "commit-missing": connect.CodeNotFound,
		"missing-scope": connect.CodePermissionDenied, "raw-denied": connect.CodePermissionDenied,
		"repository-rebound": connect.CodeUnavailable, "wrong-repository-name": connect.CodeUnavailable,
		"wrong-sha": connect.CodeUnavailable, "wrong-commit-url": connect.CodeUnavailable, "missing-parents": connect.CodeUnavailable,
		"invalid-commit-url": connect.CodeUnavailable, "commit-url-query": connect.CodeUnavailable,
		"invalid-parent": connect.CodeUnavailable, "self-parent": connect.CodeUnavailable, "wrong-parent-format": connect.CodeUnavailable, "missing-metadata": connect.CodeUnavailable,
		"truncated": connect.CodeUnavailable, "json-response": connect.CodeUnavailable, "partial-status": connect.CodeUnavailable, "redirect": connect.CodeUnavailable,
		"oversized": connect.CodeResourceExhausted, "oversized-length": connect.CodeResourceExhausted, "too-many-parents": connect.CodeResourceExhausted,
		"empty-repository": connect.CodeFailedPrecondition, "invalid-utf8": connect.CodeFailedPrecondition, "escape": connect.CodeFailedPrecondition, "nul": connect.CodeFailedPrecondition, "c1-control": connect.CodeFailedPrecondition,
	}
	f := newDiffFixture(t)
	client := f.client(t, f.session(t, "pat"))
	for mode, want := range cases {
		t.Run(mode, func(t *testing.T) {
			f.mode.Store(mode)
			f.repoRead.Store(0)
			response, err := client.GetCommitDiff(context.Background(), diffRequest(strings.Repeat("a", 40)))
			if connect.CodeOf(err) != want || response != nil {
				t.Fatalf("want %s without private content, got %v", want, err)
			}
		})
	}
	f.mode.Store("")
	f.repoRead.Store(0)
	for _, sha := range []string{"", "main", "feature/slash", "HEAD~1", strings.Repeat("a", 39), strings.Repeat("A", 40), strings.Repeat("a", 65)} {
		if _, err := client.GetCommitDiff(context.Background(), diffRequest(sha)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("noncanonical immutable commit selection accepted", err)
		}
	}
	request := diffRequest(strings.Repeat("a", 40))
	request.Msg.Repository = &golfv1.RepositoryKey{Owner: "..", Name: "private"}
	if _, err := client.GetCommitDiff(context.Background(), request); connect.CodeOf(err) != connect.CodeInvalidArgument || f.repoRead.Load() != 0 {
		t.Fatal("invalid repository or commit reached provider")
	}
}

func TestCommitDiffSessionWaitPostgres(t *testing.T) {
	for _, mode := range []string{"wait-user", "wait-diff"} {
		for _, revoke := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/revoke=%t", mode, revoke), func(t *testing.T) {
				f := newDiffFixture(t)
				session := f.session(t, "pat")
				client := f.client(t, session)
				f.mode.Store(mode)
				outcome := make(chan error, 1)
				go func() {
					_, err := client.GetCommitDiff(context.Background(), diffRequest(strings.Repeat("a", 40)))
					outcome <- err
				}()
				select {
				case <-f.entered:
				case <-time.After(5 * time.Second):
					t.Fatal("provider did not reach wait")
				}
				hash, _ := sessionHash(session.Value)
				statement := "UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1"
				if revoke {
					statement = "DELETE FROM golf_sessions WHERE token_hash=$1"
				}
				if _, err := f.db.Exec(statement, hash); err != nil {
					t.Fatal(err)
				}
				f.resume <- struct{}{}
				select {
				case err := <-outcome:
					if connect.CodeOf(err) != connect.CodeUnauthenticated {
						t.Fatal("private diff outlived local session", err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("diff request failed to settle")
				}
			})
		}
	}
}

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestIssueCommentsBindsIdentitiesWithinOneAuthority(t *testing.T) {
	for _, bearer := range []bool{false, true} {
		for _, failure := range []string{"", "empty", "repository", "issue", "comments", "malformed", "logout"} {
			t.Run(fmt.Sprintf("bearer=%v/%s", bearer, failure), func(t *testing.T) {
				const repositoryID, issueID = "9007199254740993", "9223372036854775807"
				var calls []string
				repository := golfv1connect.RepositoryServiceGetRepositoryProcedure
				issue := golfv1connect.RepositoryServiceGetIssueProcedure
				comments := golfv1connect.RepositoryServiceListIssueCommentsProcedure
				login, logout := golfv1connect.SessionServiceLoginWithForgeTokenProcedure, golfv1connect.SessionServiceLogoutProcedure
				token := "private-discussion-token"
				if bearer {
					token = fixtureAPIToken
				}
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					path := strings.TrimPrefix(r.URL.Path, "/rpc")
					calls = append(calls, path)
					if r.Method != "POST" || r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("Connect-Protocol-Version") != "1" {
						t.Error("lost authenticated RPC boundary")
					}
					w.Header().Set("Content-Type", "application/json")
					if bearer {
						if r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Cookie") != "" {
							t.Error("bearer authority changed")
						}
					} else if path != login {
						cookie, err := r.Cookie("golf_session")
						if err != nil || cookie.Value != "same-discussion-session" || r.Header.Get("Authorization") != "" {
							t.Error("temporary session changed between identity reads")
						}
					}
					var input map[string]any
					if json.NewDecoder(r.Body).Decode(&input) != nil {
						t.Error("invalid input")
					}
					denied := (failure == "repository" && path == repository) || (failure == "issue" && path == issue) || (failure == "comments" && path == comments) || (failure == "logout" && path == logout)
					if denied {
						w.WriteHeader(403)
						fmt.Fprintf(w, `{"code":"permission_denied","message":%q}`, token+" private discussion")
						return
					}
					switch path {
					case login:
						if bearer || input["token"] != token {
							t.Error("unexpected login")
						}
						http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "same-discussion-session", Path: "/"})
						fmt.Fprint(w, `{}`)
					case logout:
						if bearer {
							t.Error("unexpected logout")
						}
						fmt.Fprint(w, `{}`)
					case repository:
						fmt.Fprintf(w, `{"repository":{"id":%q}}`, repositoryID)
					case issue:
						if input["number"] != float64(7) {
							t.Error("wrong issue number")
						}
						if failure == "malformed" {
							fmt.Fprint(w, `{}`)
						} else {
							fmt.Fprintf(w, `{"issue":{"id":%q,"number":7}}`, issueID)
						}
					case comments:
						expected := map[string]any{"repository": map[string]any{"owner": "alice", "name": "private"}, "repositoryId": repositoryID, "issueId": issueID, "number": float64(7), "page": map[string]any{"page": float64(2), "limit": float64(1)}}
						if !reflect.DeepEqual(input, expected) {
							t.Error("did not preserve exact current identities and page")
						}
						if failure == "empty" {
							fmt.Fprint(w, `{"page":{"nextPage":3}}`)
						} else {
							fmt.Fprint(w, `{"comments":[{"id":"9007199254740995","body":"<script>plain text</script>\u001b[31m"}],"page":{"nextPage":3}}`)
						}
					default:
						t.Error("unexpected procedure or automatic page traversal")
						w.WriteHeader(404)
					}
				}))
				defer upstream.Close()
				var out, diagnostic bytes.Buffer
				credentialFlag := "--token-stdin"
				if bearer {
					credentialFlag = "--api-token-stdin"
				}
				code := Run(context.Background(), []string{"--url", upstream.URL, credentialFlag, "issue", "comments", "alice/private", "7", "--page", "2", "--limit", "1"}, strings.NewReader(token), &out, &diagnostic, func(string) string { return "" })
				success := failure == "" || failure == "empty" || (bearer && failure == "logout")
				if success {
					if code != 0 || diagnostic.Len() != 0 || !strings.Contains(out.String(), `"nextPage": 3`) {
						t.Fatal("lost successful page/empty continuation")
					}
					if failure == "empty" && !strings.Contains(out.String(), `"comments": []`) {
						t.Fatal("empty page shape lost")
					}
				} else if code != 1 || out.Len() != 0 {
					t.Fatal("denial or malformed identity released private result")
				}
				if strings.Contains(out.String()+diagnostic.String(), token) || strings.Contains(diagnostic.String(), "private discussion") || bytes.Contains(out.Bytes(), []byte{27}) {
					t.Fatal("credential/private diagnostic or terminal escape leaked")
				}
				want := []string{repository}
				if failure != "repository" {
					want = append(want, issue)
				}
				if failure != "repository" && failure != "issue" && failure != "malformed" {
					want = append(want, comments)
				}
				if !bearer {
					want = append([]string{login}, want...)
					want = append(want, logout)
				}
				if !reflect.DeepEqual(calls, want) {
					t.Fatal("identity reads and one page did not share exactly one authority")
				}
			})
		}
	}
}

func TestDiscussionArgumentsRejectBeforeCredentials(t *testing.T) {
	for _, args := range [][]string{
		{"issue", "create", "alice/private"}, {"issue", "comment", "alice/private", "1"},
		{"issue", "comments", "alice/private", "0"}, {"issue", "comments", "alice/private", "01"},
		{"issue", "comments", "alice/private", "2147483648"}, {"issue", "comments", "alice/private", "1", "--page", "10001"},
		{"issue", "comments", "alice/private", "1", "--limit", "101"}, {"issue", "comments", "alice/private", "1", "--issue-id", "2"},
		{"issue", "operation", "12345678-1234-1234-8234-123456789abc"}, {"issue", "operation", "12345678-1234-4234-8234-123456789ABC"},
	} {
		var out, diagnostic bytes.Buffer
		if code := Run(context.Background(), append([]string{"--token-stdin"}, args...), panicReader{}, &out, &diagnostic, func(string) string { return "" }); code != 2 || out.Len() != 0 {
			t.Fatal("invalid discussion command reached authentication")
		}
	}
}

type panicReader struct{}

func (panicReader) Read([]byte) (int, error) { panic("invalid input read credentials") }

var _ io.Reader = panicReader{}

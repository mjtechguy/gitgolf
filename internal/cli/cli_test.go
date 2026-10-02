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
	"sync/atomic"
	"testing"
	"time"

	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestReadCommandSessionAndFailureCleanup(t *testing.T) {
	for _, denied := range []bool{false, true} {
		t.Run(fmt.Sprint("denied=", denied), func(t *testing.T) {
			var calls []string
			const token = "fixture-private-token"
			forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls = append(calls, r.Method+" "+r.URL.Path)
				if r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("Connect-Protocol-Version") != "1" || r.Method != "POST" {
					t.Error("origin does not match the destination")
				}
				w.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(r.URL.Path, golfv1connect.SessionServiceLoginWithGiteaTokenProcedure) {
					var input map[string]string
					if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input["token"] != token {
						t.Error("token login failed")
					}
					http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "opaque-session", Path: "/", HttpOnly: true})
					fmt.Fprint(w, `{"user":{"id":"1"}}`)
					return
				}
				cookie, err := r.Cookie("golf_session")
				if err != nil || cookie.Value != "opaque-session" || r.Header.Get("Authorization") != "" {
					t.Error("request did not use only the ephemeral cookie")
				}
				if strings.HasSuffix(r.URL.Path, golfv1connect.SessionServiceLogoutProcedure) {
					fmt.Fprint(w, `{}`)
					return
				}
				var input struct {
					Ref, Path  string
					Repository struct{ Owner, Name string }
				}
				if json.NewDecoder(r.Body).Decode(&input) != nil || input.Ref != "feature/a&b" || input.Path != "src/hello 世界.txt" || input.Repository.Owner != "alice" || input.Repository.Name != "private" || !strings.HasSuffix(r.URL.Path, golfv1connect.RepositoryServiceGetContentsProcedure) {
					t.Error("query escaping changed the selected source")
				}
				if denied {
					w.WriteHeader(403)
					fmt.Fprintf(w, `{"code":"permission_denied","message":%q}`, token)
					return
				}
				fmt.Fprint(w, `{"commitId":"abc","file":{"content":"<script>alert(1)</script>\u001b[31m"}}`)
			}))
			defer forge.Close()
			var out, diagnostic bytes.Buffer
			code := Run(context.Background(), []string{"--url", forge.URL, "--token-stdin", "repo", "contents", "alice/private", "--ref", "feature/a&b", "--path", "src/hello 世界.txt"}, strings.NewReader(token+"\n"), &out, &diagnostic, func(string) string { return "" })
			if denied {
				if code != 1 || out.Len() != 0 || !strings.Contains(diagnostic.String(), "permission_denied") {
					t.Fatalf("denial was not visible: code=%d", code)
				}
			} else {
				var envelope struct {
					Schema string `json:"schema_version"`
					Data   struct {
						Commit string `json:"commitId"`
					} `json:"data"`
				}
				if code != 0 || json.Unmarshal(out.Bytes(), &envelope) != nil || envelope.Schema != "golf.cli.v1" || envelope.Data.Commit != "abc" || bytes.Contains(out.Bytes(), []byte{27}) {
					t.Fatalf("unsafe or missing machine result: code=%d", code)
				}
			}
			if strings.Contains(out.String()+diagnostic.String(), token) {
				t.Fatal("credential leaked to output")
			}
			want := "POST /rpc" + golfv1connect.SessionServiceLoginWithGiteaTokenProcedure + ",POST /rpc" + golfv1connect.RepositoryServiceGetContentsProcedure + ",POST /rpc" + golfv1connect.SessionServiceLogoutProcedure
			if strings.Join(calls, ",") != want {
				t.Fatalf("missing session cleanup: %v", calls)
			}
		})
	}
}

func TestClientRejectsUnsafeOriginsRedirectsAndMalformedResponses(t *testing.T) {
	for _, origin := range []string{"http://remote.example", "https://user:secret@example.com", "https://example.com/path", "https://example.com?secret", "https://example.com#secret", "file:///tmp/socket"} {
		if _, err := parseOrigin(origin); err == nil {
			t.Fatalf("accepted unsafe origin %s", origin)
		}
	}
	var reached atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) }))
	defer redirect.Close()
	if _, err := execute(context.Background(), redirect.URL, command{name: "repo list"}, "private-token"); err == nil || reached.Load() {
		t.Fatal("credential-bearing request followed a redirect")
	}
	for _, failure := range []string{"malformed", "oversized", "logout"} {
		t.Run(failure, func(t *testing.T) {
			var cleaned atomic.Bool
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(r.URL.Path, golfv1connect.SessionServiceLogoutProcedure) {
					cleaned.Store(true)
					if failure == "logout" {
						w.WriteHeader(503)
					} else {
						fmt.Fprint(w, `{}`)
					}
					return
				}
				if strings.HasSuffix(r.URL.Path, golfv1connect.SessionServiceLoginWithGiteaTokenProcedure) {
					http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "opaque", Path: "/"})
					fmt.Fprint(w, `{}`)
					return
				}
				switch failure {
				case "malformed":
					fmt.Fprint(w, `{"missing":`)
				case "oversized":
					fmt.Fprintf(w, `{"file":{"content":%q}}`, strings.Repeat("a", 8<<20))
				default:
					fmt.Fprint(w, `{}`)
				}
			}))
			defer s.Close()
			if _, err := execute(context.Background(), s.URL, command{name: "repo contents"}, "private-token"); err == nil || !cleaned.Load() {
				t.Fatal("bad response/cleanup was treated as success or session cleanup was skipped")
			}
		})
	}
}

func TestCommandValidationBeforeAuthentication(t *testing.T) {
	for _, args := range [][]string{
		{"repo", "view", "../private"}, {"repo", "list", "--limit", "101"}, {"issue", "view", "alice/private", "0"},
		{"issue", "view", "alice/private", "2147483648"},
		{"pr", "view", "alice/private", "0"}, {"pr", "view", "alice/private", "01"},
		{"pr", "view", "alice/private", "+1"}, {"pr", "reviews", "alice/private", "2147483648"},
		{"pr", "view", "alice/private", "1", "--page", "2"}, {"pr", "list", "alice/private", "--state", "merged"},
		{"pr", "reviews", "alice/private", "1", "--state", "all"}, {"pr", "merge", "alice/private", "1"},
		{"issue", "list", "alice/private", "--state", "deleted"}, {"repo", "list", "--token", "do-not-echo-token"},
		{"org", "view"}, {"org", "view", "."}, {"org", "view", ".."}, {"org", "view", "org/team"},
		{"org", "view", "space org"}, {"org", "view", "org?token=do-not-echo-token"}, {"org", "view", "世界"},
		{"org", "view", strings.Repeat("a", 101)}, {"org", "view", "workshop", "extra"},
		{"org", "view", "workshop", "--page", "1"}, {"org", "list", "--page", "0"}, {"org", "teams", "workshop", "--page", "10001"},
		{"team", "members", "workshop", "2", "--limit", "0"}, {"team", "repos", "workshop", "2", "--limit", "101"},
		{"team", "view", "workshop"}, {"team", "view", "workshop", "0"}, {"team", "view", "workshop", "-1"},
		{"team", "view", "workshop", "+2"}, {"team", "view", "workshop", "02"}, {"team", "view", "workshop", "2 "},
		{"team", "view", "workshop", "2/../3"}, {"team", "view", "workshop", "9223372036854775808"},
		{"team", "view", "workshop", "2", "--page", "1"}, {"team", "create", "workshop", "2"},
	} {
		var out, diagnostic bytes.Buffer
		code := Run(context.Background(), args, strings.NewReader(""), &out, &diagnostic, func(string) string { return "" })
		if code != 2 || out.Len() != 0 || strings.Contains(diagnostic.String(), "do-not-echo-token") {
			t.Fatal("invalid command did not fail safely before authentication")
		}
	}
}

func TestCancellationDuringCredentialInput(t *testing.T) {
	input, producer := io.Pipe()
	defer input.Close()
	defer producer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan int, 1)
	go func() {
		finished <- Run(ctx, []string{"--token-stdin", "repo", "list"}, input, io.Discard, io.Discard, func(string) string { return "" })
	}()
	cancel()
	select {
	case code := <-finished:
		if code != 1 {
			t.Fatalf("cancelled input exit code=%d", code)
		}
	case <-time.After(time.Second):
		t.Fatal("CLI ignored cancellation while waiting for stdin EOF")
	}
}

func TestCancellationStillClosesSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var cleaned atomic.Bool
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/rpc" + golfv1connect.SessionServiceLoginWithGiteaTokenProcedure:
			http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "opaque", Path: "/"})
			fmt.Fprint(w, `{}`)
		case "/rpc" + golfv1connect.RepositoryServiceListRepositoriesProcedure:
			io.Copy(io.Discard, r.Body)
			cancel()
			<-r.Context().Done()
		case "/rpc" + golfv1connect.SessionServiceLogoutProcedure:
			cleaned.Store(true)
			fmt.Fprint(w, `{}`)
		}
	}))
	defer s.Close()
	if _, err := execute(ctx, s.URL, command{name: "repo list"}, "private-token"); err == nil || !cleaned.Load() {
		t.Fatal("cancelled read did not clean up through an independent bounded context")
	}
}

func TestMembershipAndPullCommandsAndEphemeralSession(t *testing.T) {
	const token = "fixture-organization-token"
	const teamID = "9223372036854775807"
	for _, command := range []struct {
		args                                   []string
		procedure, request, response, fragment string
	}{
		{[]string{"pr", "list", "alice/private", "--state", "all", "--page", "2", "--limit", "1"}, golfv1connect.RepositoryServiceListPullRequestsProcedure,
			`{"repository":{"owner":"alice","name":"private"},"state":"ISSUE_STATE_ALL","page":{"page":2,"limit":1}}`, `{"pullRequests":[{"id":"9007199254740993","number":7,"head":{"repositoryId":"9223372036854775807","retainedSnapshot":true}}],"page":{"nextPage":3}}`, `"retainedSnapshot":true`},
		{[]string{"pr", "view", "alice/private", "2147483647"}, golfv1connect.RepositoryServiceGetPullRequestProcedure,
			`{"repository":{"owner":"alice","name":"private"},"number":2147483647}`, `{"pullRequest":{"id":"9007199254740993","number":2147483647,"body":"<script>plain text</script>","merged":true}}`, `"id":"9007199254740993"`},
		{[]string{"pr", "reviews", "alice/private", "7", "--page", "2", "--limit", "1"}, golfv1connect.RepositoryServiceListPullRequestReviewsProcedure,
			`{"repository":{"owner":"alice","name":"private"},"number":7,"page":{"page":2,"limit":1}}`, `{"page":{"nextPage":3}}`, `"reviews":[]`},
		{[]string{"org", "list", "--page", "2", "--limit", "1"}, golfv1connect.OrganizationServiceListOrganizationsProcedure,
			`{"page":{"page":2,"limit":1}}`, `{"organizations":[{"id":"9007199254740993","name":"workshop","visibility":"ORGANIZATION_VISIBILITY_PRIVATE"}],"page":{"nextPage":3}}`, `"id":"9007199254740993"`},
		{[]string{"org", "view", "Workshop_2026.test-org"}, golfv1connect.OrganizationServiceGetOrganizationProcedure,
			`{"organization":"Workshop_2026.test-org"}`, `{"organization":{"id":"9007199254740993","name":"Workshop_2026.test-org","visibility":"ORGANIZATION_VISIBILITY_LIMITED"}}`, `"visibility":"ORGANIZATION_VISIBILITY_LIMITED"`},
		{[]string{"org", "teams", strings.Repeat("a", 100)}, golfv1connect.OrganizationServiceListTeamsProcedure,
			`{"organization":"` + strings.Repeat("a", 100) + `","page":{"page":1,"limit":20}}`, `{"teams":[{"id":"9223372036854775807","permission":"TEAM_PERMISSION_NONE","unitPermissions":{"repo.code":"TEAM_PERMISSION_WRITE"},"visibility":"TEAM_VISIBILITY_PRIVATE"}]}`, `"repo.code":"TEAM_PERMISSION_WRITE"`},
		{[]string{"team", "view", "workshop", teamID}, golfv1connect.OrganizationServiceGetTeamProcedure,
			`{"organization":"workshop","teamId":"9223372036854775807"}`, `{"team":{"id":"9223372036854775807","permission":"TEAM_PERMISSION_NONE","visibility":"TEAM_VISIBILITY_LIMITED"}}`, `"id":"9223372036854775807"`},
		{[]string{"team", "members", "workshop", teamID, "--page", "10000", "--limit", "100"}, golfv1connect.OrganizationServiceListTeamMembersProcedure,
			`{"organization":"workshop","teamId":"9223372036854775807","page":{"page":10000,"limit":100}}`, `{"members":[{"id":"9007199254740993","login":"alice"}]}`, `"id":"9007199254740993"`},
		{[]string{"team", "repos", "workshop", teamID, "--page", "2", "--limit", "1"}, golfv1connect.OrganizationServiceListTeamRepositoriesProcedure,
			`{"organization":"workshop","teamId":"9223372036854775807","page":{"page":2,"limit":1}}`, `{"page":{"nextPage":3}}`, `"repositories":[]`},
	} {
		for _, failure := range []string{"", "denied", "logout"} {
			t.Run(strings.Join(command.args[:2], "-")+"/"+failure, func(t *testing.T) {
				var calls []string
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls = append(calls, r.URL.Path)
					if r.Method != "POST" || r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("Connect-Protocol-Version") != "1" || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "" {
						t.Error("organization request bypassed the normal Connect transport boundary")
					}
					w.Header().Set("Content-Type", "application/json")
					switch r.URL.Path {
					case "/rpc" + golfv1connect.SessionServiceLoginWithGiteaTokenProcedure:
						var input map[string]string
						if json.NewDecoder(r.Body).Decode(&input) != nil || input["token"] != token {
							t.Error("scoped token bootstrap changed")
						}
						http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "organization-session", Path: "/", HttpOnly: true})
						fmt.Fprint(w, `{}`)
					case "/rpc" + golfv1connect.SessionServiceLogoutProcedure:
						if failure == "logout" {
							w.WriteHeader(503)
							fmt.Fprintf(w, `{"code":"unavailable","message":%q}`, token)
							return
						}
						fmt.Fprint(w, `{}`)
					case "/rpc" + command.procedure:
						cookie, err := r.Cookie("golf_session")
						if err != nil || cookie.Value != "organization-session" {
							t.Error("organization request lost its temporary session")
						}
						var input, expected any
						if json.NewDecoder(r.Body).Decode(&input) != nil || json.Unmarshal([]byte(command.request), &expected) != nil || !reflect.DeepEqual(input, expected) {
							t.Error("wrong generated resource request or numeric team ID")
						}
						if failure == "denied" {
							w.WriteHeader(403)
							fmt.Fprintf(w, `{"code":"permission_denied","message":%q}`, token+" private-membership-data")
							return
						}
						fmt.Fprint(w, command.response)
					default:
						t.Error("unexpected RPC or automatic pagination")
						w.WriteHeader(404)
					}
				}))
				defer server.Close()
				var out, diagnostic bytes.Buffer
				args := append([]string{"--url", server.URL, "--token-stdin"}, command.args...)
				code := Run(context.Background(), args, strings.NewReader(token+"\n"), &out, &diagnostic, func(string) string { return "" })
				if failure != "" {
					if code != 1 || out.Len() != 0 {
						t.Fatal("denial or failed logout produced successful private output")
					}
					if failure == "denied" && !strings.Contains(diagnostic.String(), "permission_denied") {
						t.Fatal("typed denial was lost")
					}
				} else {
					var envelope struct {
						Schema string          `json:"schema_version"`
						Data   json.RawMessage `json:"data"`
					}
					if code != 0 || diagnostic.Len() != 0 || json.Unmarshal(out.Bytes(), &envelope) != nil || envelope.Schema != "golf.cli.v1" {
						t.Fatal("invalid command result envelope")
					}
					var compact bytes.Buffer
					if json.Compact(&compact, envelope.Data) != nil || !strings.Contains(compact.String(), command.fragment) {
						t.Fatal("native metadata/defaults or decimal ID precision lost")
					}
					if command.procedure == golfv1connect.OrganizationServiceListTeamRepositoriesProcedure && !strings.Contains(compact.String(), `"nextPage":3`) {
						t.Fatal("empty intermediate page lost continuation")
					}
				}
				if strings.Contains(out.String()+diagnostic.String(), token) || strings.Contains(diagnostic.String(), "private-membership-data") {
					t.Fatal("remote error leaked credential or private data")
				}
				want := []string{"/rpc" + golfv1connect.SessionServiceLoginWithGiteaTokenProcedure, "/rpc" + command.procedure, "/rpc" + golfv1connect.SessionServiceLogoutProcedure}
				if !reflect.DeepEqual(calls, want) {
					t.Fatal("organization read did not use exactly one temporary session and page")
				}
			})
		}
	}
}

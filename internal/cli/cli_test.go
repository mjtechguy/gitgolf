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
	"sync"
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
				if strings.HasSuffix(r.URL.Path, golfv1connect.RepositoryServiceGetRepositoryProcedure) {
					fmt.Fprint(w, `{"repository":{"id":"9007199254740993","name":"private","fullName":"alice/private"}}`)
					return
				}
				var input struct {
					Ref, Path, RepositoryId string
					Repository              struct{ Owner, Name string }
					Selector                struct{ Kind, Name string }
				}
				if json.NewDecoder(r.Body).Decode(&input) != nil || input.Path != "src/hello 世界.txt" || input.Repository.Owner != "alice" || input.Repository.Name != "private" || input.RepositoryId != "9007199254740993" {
					t.Error("query escaping changed the selected source")
				}
				if strings.HasSuffix(r.URL.Path, golfv1connect.RepositoryServiceResolveRepositorySourceProcedure) {
					if input.Selector.Kind != "REPOSITORY_SOURCE_REF_KIND_BRANCH" || input.Selector.Name != "feature/a&b" {
						t.Error("bare named ref did not select exact branch namespace")
					}
					fmt.Fprintf(w, `{"repositoryId":"9007199254740993","repository":{"owner":"alice","name":"private"},"selection":{"kind":"REPOSITORY_SOURCE_REF_KIND_BRANCH","name":"feature/a&b","commitId":%q},"path":"src/hello 世界.txt"}`, strings.Repeat("a", 40))
					return
				}
				if !strings.HasSuffix(r.URL.Path, golfv1connect.RepositoryServiceGetContentsProcedure) || input.Ref != strings.Repeat("a", 40) {
					t.Error("source read did not use resolved full snapshot")
				}
				if denied {
					w.WriteHeader(403)
					fmt.Fprintf(w, `{"code":"permission_denied","message":%q}`, token)
					return
				}
				fmt.Fprintf(w, `{"repositoryId":"9007199254740993","commitId":%q,"path":"src/hello 世界.txt","file":{"content":"<script>alert(1)</script>\u001b[31m"}}`, strings.Repeat("a", 40))
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
				if code != 0 || json.Unmarshal(out.Bytes(), &envelope) != nil || envelope.Schema != "golf.cli.v1" || envelope.Data.Commit != strings.Repeat("a", 40) || bytes.Contains(out.Bytes(), []byte{27}) {
					t.Fatalf("unsafe or missing machine result: code=%d", code)
				}
			}
			if strings.Contains(out.String()+diagnostic.String(), token) {
				t.Fatal("credential leaked to output")
			}
			want := "POST /rpc" + golfv1connect.SessionServiceLoginWithGiteaTokenProcedure + ",POST /rpc" + golfv1connect.RepositoryServiceGetRepositoryProcedure + ",POST /rpc" + golfv1connect.RepositoryServiceResolveRepositorySourceProcedure + ",POST /rpc" + golfv1connect.RepositoryServiceGetContentsProcedure + ",POST /rpc" + golfv1connect.SessionServiceLogoutProcedure
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
	if _, err := execute(context.Background(), redirect.URL, command{name: "repo list"}, credential{token: "private-token"}); err == nil || reached.Load() {
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
			if _, err := execute(context.Background(), s.URL, command{name: "repo contents"}, credential{token: "private-token"}); err == nil || !cleaned.Load() {
				t.Fatal("bad response/cleanup was treated as success or session cleanup was skipped")
			}
		})
	}
}

func TestCommandValidationBeforeAuthentication(t *testing.T) {
	for _, args := range [][]string{
		{"repo", "creation"}, {"repo", "creation", "12345678-1234-1234-8234-123456789abc"},
		{"repo", "creation", "12345678-1234-4234-7234-123456789abc"},
		{"repo", "creation", "12345678-1234-4234-8234-123456789ABC"},
		{"repo", "creation", "12345678-1234-4234-8234-123456789abc", "--page", "2"},
		{"repo", "view", "../private"}, {"repo", "list", "--limit", "101"}, {"issue", "view", "alice/private", "0"},
		{"issue", "view", "alice/private", "2147483648"},
		{"commit", "diff", "alice/private"}, {"commit", "diff", "alice/private", "main"},
		{"commit", "diff", "alice/private", "refs/heads/main"}, {"commit", "diff", "alice/private", strings.Repeat("a", 12)},
		{"commit", "diff", "alice/private", strings.Repeat("A", 40)}, {"commit", "diff", "alice/private", strings.Repeat("a", 39)},
		{"commit", "diff", "alice/private", strings.Repeat("a", 41)}, {"commit", "diff", "alice/private", strings.Repeat("a", 63)},
		{"commit", "diff", "alice/private", strings.Repeat("a", 65)}, {"commit", "diff", "alice/private", strings.Repeat("g", 40)},
		{"commit", "diff", "alice/private", " " + strings.Repeat("a", 40)}, {"commit", "diff", "alice/private", strings.Repeat("a", 40) + " "},
		{"commit", "diff", "alice/private", strings.Repeat("a", 40), "--ref", "main"}, {"commit", "diff", "alice/private", strings.Repeat("a", 40), "--page", "2"},
		{"commit", "diff", "alice/private", strings.Repeat("a", 40), "extra"}, {"commit", "diff", "alice/private", "do-not-echo-token"},
		{"pr", "view", "alice/private", "0"}, {"pr", "view", "alice/private", "01"},
		{"pr", "view", "alice/private", "+1"}, {"pr", "reviews", "alice/private", "2147483648"},
		{"pr", "view", "alice/private", "1", "--page", "2"}, {"pr", "list", "alice/private", "--state", "merged"},
		{"pr", "reviews", "alice/private", "1", "--state", "all"}, {"pr", "merge", "alice/private", "1"},
		{"audit", "list", "--limit", "101"}, {"audit", "list", "--page", "2"},
		{"audit", "list", "--before-id", "1"}, {"audit", "list", "--snapshot-id", "01"},
		{"audit", "list", "--snapshot-id", "+1"}, {"audit", "list", "--snapshot-id", "9223372036854775808"},
		{"audit", "list", "--before-id", "3", "--snapshot-id", "2"}, {"audit", "clear"},
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
	if _, err := execute(ctx, s.URL, command{name: "repo list"}, credential{token: "private-token"}); err == nil || !cleaned.Load() {
		t.Fatal("cancelled read did not clean up through an independent bounded context")
	}
}

func TestAdditionalReadCommandsAndEphemeralSession(t *testing.T) {
	const token = "fixture-organization-token"
	const teamID = "9223372036854775807"
	for _, command := range []struct {
		args                                   []string
		procedure, request, response, fragment string
	}{
		{[]string{"issue", "operation", "12345678-1234-4234-8234-123456789abc"}, golfv1connect.RepositoryServiceGetIssueMutationProcedure,
			`{"idempotencyKey":"12345678-1234-4234-8234-123456789abc"}`, `{"mutation":{"id":"9007199254740993","kind":"ISSUE_MUTATION_KIND_CREATE_COMMENT","state":"ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN","observedResultId":"9007199254740995","observedNumber":2147483647}}`, `"state":"ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN"`},
		{[]string{"repo", "creation", "12345678-1234-4234-8234-123456789abc"}, golfv1connect.RepositoryServiceGetRepositoryCreationProcedure,
			`{"idempotencyKey":"12345678-1234-4234-8234-123456789abc"}`, `{"creation":{"id":"opaque-operation","state":"REPOSITORY_CREATION_STATE_OUTCOME_UNKNOWN","requestedName":"<script>plain</script>\u001b[31m"}}`, `"state":"REPOSITORY_CREATION_STATE_OUTCOME_UNKNOWN"`},
		// An untrusted endpoint can send control text; the CLI must still escape it in JSON.
		{[]string{"commit", "diff", "alice/private", strings.Repeat("a", 40)}, golfv1connect.RepositoryServiceGetCommitDiffProcedure,
			`{"repository":{"owner":"alice","name":"private"},"commitId":"` + strings.Repeat("a", 40) + `"}`, `{"commit":{"sha":"` + strings.Repeat("a", 40) + `"},"base":"COMMIT_DIFF_BASE_ROOT","rawDiff":"<script>plain text</script>\u001b[31m","byteSize":32}`, `"base":"COMMIT_DIFF_BASE_ROOT"`},
		{[]string{"commit", "diff", "alice/private", strings.Repeat("1", 64)}, golfv1connect.RepositoryServiceGetCommitDiffProcedure,
			`{"repository":{"owner":"alice","name":"private"},"commitId":"` + strings.Repeat("1", 64) + `"}`, `{"commit":{"sha":"` + strings.Repeat("1", 64) + `"},"base":"COMMIT_DIFF_BASE_FIRST_PARENT","parentCommitIds":["` + strings.Repeat("2", 64) + `"],"baseCommitId":"` + strings.Repeat("2", 64) + `"}`, `"rawDiff":""`},
		{[]string{"audit", "list", "--limit", "1", "--before-id", "9007199254740993", "--snapshot-id", "9223372036854775807"}, golfv1connect.AuditServiceListAuditEventsProcedure,
			`{"limit":1,"beforeId":"9007199254740993","snapshotId":"9223372036854775807"}`, `{"events":[{"id":"9007199254740992","action":"AUDIT_ACTION_SIGN_IN","actorSessionId":"9007199254740993","credentialKind":"pat"}],"nextBeforeId":"9007199254740992","snapshotId":"9223372036854775807"}`, `"id":"9007199254740992"`},
		{[]string{"audit", "list"}, golfv1connect.AuditServiceListAuditEventsProcedure,
			`{"limit":20}`, `{}`, `"events":[]`},
		{[]string{"pr", "list", "alice/private", "--state", "all", "--page", "2", "--limit", "1"}, golfv1connect.RepositoryServiceListPullRequestsProcedure,
			`{"repository":{"owner":"alice","name":"private"},"state":"ISSUE_STATE_ALL","page":{"page":2,"limit":1}}`, `{"pullRequests":[{"id":"9007199254740993","number":7,"head":{"repositoryId":"9223372036854775807","retainedSnapshot":true}}],"page":{"nextPage":3}}`, `"retainedSnapshot":true`},
		{[]string{"pr", "view", "alice/private", "2147483647"}, golfv1connect.RepositoryServiceGetPullRequestProcedure,
			`{"repository":{"owner":"alice","name":"private"},"number":2147483647}`, `{"pullRequest":{"id":"9007199254740993","number":2147483647,"body":"<script>plain text</script>","merged":true}}`, `"id":"9007199254740993"`},
		{[]string{"pr", "diff", "alice/private", "7", "--repo-id", "9007199254740994", "--pull-id", "9223372036854775807", "--base", strings.Repeat("b", 40), "--head", strings.Repeat("a", 40)}, golfv1connect.RepositoryServiceGetPullRequestDiffProcedure,
			`{"repository":{"owner":"alice","name":"private"},"repositoryId":"9007199254740994","pullRequestId":"9223372036854775807","number":7,"baseCommitId":"` + strings.Repeat("b", 40) + `","headCommitId":"` + strings.Repeat("a", 40) + `"}`, `{"repositoryId":"9007199254740994","pullRequestId":"9223372036854775807","baseCommitId":"` + strings.Repeat("b", 40) + `","headCommitId":"` + strings.Repeat("a", 40) + `","mergeBaseCommitId":"` + strings.Repeat("c", 40) + `","rawDiff":"<script>plain</script>\u001b[31m","byteSize":25}`, `"mergeBaseCommitId":"` + strings.Repeat("c", 40) + `"`},
		{[]string{"pr", "diff", "alice/private", "7", "--repo-id", "9007199254740994", "--pull-id", "9223372036854775807", "--base", strings.Repeat("b", 64), "--head", strings.Repeat("a", 64)}, golfv1connect.RepositoryServiceGetPullRequestDiffProcedure,
			`{"repository":{"owner":"alice","name":"private"},"repositoryId":"9007199254740994","pullRequestId":"9223372036854775807","number":7,"baseCommitId":"` + strings.Repeat("b", 64) + `","headCommitId":"` + strings.Repeat("a", 64) + `"}`, `{"repositoryId":"9007199254740994","pullRequestId":"9223372036854775807","baseCommitId":"` + strings.Repeat("b", 64) + `","headCommitId":"` + strings.Repeat("a", 64) + `","mergeBaseCommitId":"` + strings.Repeat("c", 64) + `"}`, `"rawDiff":""`},
		{[]string{"pr", "review-comments", "alice/private", "7", "9007199254740993", "--repo-id", "9007199254740994", "--pull-id", "9223372036854775807", "--review-commit", strings.Repeat("a", 64)}, golfv1connect.RepositoryServiceGetPullRequestReviewCommentsProcedure,
			`{"repository":{"owner":"alice","name":"private"},"repositoryId":"9007199254740994","pullRequestId":"9223372036854775807","number":7,"reviewId":"9007199254740993","reviewCommitId":"` + strings.Repeat("a", 64) + `"}`, `{"repositoryId":"9007199254740994","pullRequestId":"9223372036854775807","review":{"id":"9007199254740993","commitId":"` + strings.Repeat("a", 64) + `"},"comments":[{"id":"9223372036854775807","body":"<script>literal</script>\u001b[31m","path":"src/[literal]* 世界.ts","oldLine":3,"reviewId":"9007199254740993","resolved":true}],"currentHeadCommitId":"` + strings.Repeat("b", 64) + `"}`, `"oldLine":3`},
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
					if command.procedure == golfv1connect.RepositoryServiceGetIssueMutationProcedure && (!strings.Contains(compact.String(), `"observedResultId":"9007199254740995"`) || !strings.Contains(compact.String(), `"observedNumber":2147483647`) || strings.Contains(compact.String(), "SUCCEEDED")) {
						t.Fatal("provisional receipt lost precision or became confirmed success")
					}
				}
				if strings.Contains(out.String()+diagnostic.String(), token) || strings.Contains(diagnostic.String(), "private-membership-data") || bytes.Contains(out.Bytes(), []byte{27}) {
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

func TestPathHistoryIdentityAndLiteralInput(t *testing.T) {
	ref, path := strings.Repeat("a", 40), "src/[literal]* 世界.ts"
	for _, args := range [][]string{{"repo", "commits", "alice/private", "--path", path}, {"repo", "commits", "alice/private", "--path", path, "--ref", "main"}, {"repo", "commits", "alice/private", "--path", "../other", "--ref", ref}} {
		if _, err := parseCommand(args); err == nil {
			t.Fatal("accepted unpinned/unsafe history")
		}
	}
	var calls []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		calls = append(calls, method)
		w.Header().Set("Content-Type", "application/json")
		switch method {
		case "LoginWithGiteaToken":
			http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "opaque", Path: "/", HttpOnly: true})
			fmt.Fprint(w, `{"user":{"id":"1"}}`)
		case "GetRepository":
			fmt.Fprint(w, `{"repository":{"id":"9007199254740993"}}`)
		case "ListCommits":
			var input struct {
				Ref, Path, RepositoryId string
				Page                    struct{ Page, Limit uint32 }
			}
			if json.NewDecoder(r.Body).Decode(&input) != nil || input.Ref != ref || input.Path != path || input.RepositoryId != "9007199254740993" || input.Page.Page != 2 || input.Page.Limit != 20 {
				t.Error("lost exact history identity/input")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"commitId": ref, "path": path, "repositoryId": input.RepositoryId, "commits": []any{}})
		case "Logout":
			fmt.Fprint(w, `{}`)
		default:
			t.Error("unexpected procedure", method)
		}
	}))
	defer upstream.Close()
	var out, diagnostics bytes.Buffer
	code := Run(context.Background(), []string{"--url", upstream.URL, "--token-stdin", "repo", "commits", "alice/private", "--ref", ref, "--path", path, "--page", "2"}, strings.NewReader("private-token\n"), &out, &diagnostics, func(string) string { return "" })
	var envelope struct{ Data struct{ RepositoryId string } }
	if code != 0 || json.Unmarshal(out.Bytes(), &envelope) != nil || envelope.Data.RepositoryId != "9007199254740993" || strings.Contains(out.String()+diagnostics.String(), "private-token") {
		t.Fatal("history CLI failed", code)
	}
	if strings.Join(calls, ",") != "LoginWithGiteaToken,GetRepository,ListCommits,Logout" {
		t.Fatal("history identity/session cleanup", calls)
	}
}

func TestReviewCommentExplicitSelectionBeforeAuthentication(t *testing.T) {
	valid := []string{"pr", "review-comments", "alice/private", "7", "9007199254740993", "--repo-id", "9007199254740994", "--pull-id", "9223372036854775807", "--review-commit", strings.Repeat("a", 40)}
	parsed, err := parseCommand(valid)
	if err != nil || parsed.reviewID != valid[4] || parsed.repositoryID != valid[6] || parsed.pullID != valid[8] || parsed.page != nil {
		t.Fatal("explicit selection lost exact IDs or invented pagination")
	}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer server.Close()
	cases := [][]string{valid[:5], append(append([]string{}, valid...), "--page", "1"), append(append([]string{}, valid...), "--limit", "1"), append(append([]string{}, valid...), "--ref", "main"), append(append([]string{}, valid...), "extra")}
	for _, index := range []int{3, 4, 6, 8} {
		for _, value := range []string{"", "0", "01", "+1", "-1", "1 ", "1.0", "9223372036854775808"} {
			args := append([]string{}, valid...)
			args[index] = value
			cases = append(cases, args)
		}
	}
	for _, value := range []string{"main", strings.Repeat("A", 40), strings.Repeat("a", 12), strings.Repeat("a", 39), strings.Repeat("a", 41), strings.Repeat("a", 63), strings.Repeat("a", 65), " " + strings.Repeat("a", 40)} {
		args := append([]string{}, valid...)
		args[10] = value
		cases = append(cases, args)
	}
	for _, args := range cases {
		var output, diagnostics bytes.Buffer
		code := Run(context.Background(), append([]string{"--url", server.URL}, args...), strings.NewReader(""), &output, &diagnostics, func(name string) string {
			if name == "GOLF_GITEA_TOKEN" {
				return "fixture-private-token"
			}
			return ""
		})
		if code != 2 || output.Len() != 0 || calls.Load() != 0 || strings.Contains(diagnostics.String(), "fixture-private-token") {
			t.Fatal("invalid review selection authenticated or leaked input")
		}
	}
}

func TestPullDiffExplicitSelectionBeforeAuthentication(t *testing.T) {
	valid := []string{"pr", "diff", "alice/private", "7", "--repo-id", "9007199254740994", "--pull-id", "9223372036854775807", "--base", strings.Repeat("b", 40), "--head", strings.Repeat("a", 40)}
	parsed, err := parseCommand(valid)
	if err != nil || parsed.repositoryID != valid[5] || parsed.pullID != valid[7] || parsed.baseCommit != valid[9] || parsed.headCommit != valid[11] || parsed.page != nil {
		t.Fatal("explicit diff bindings lost or invented pagination")
	}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer server.Close()
	cases := [][]string{valid[:4], valid[:8], valid[:10]}
	for _, flag := range []string{"--page", "--limit", "--ref", "--review-commit"} {
		cases = append(cases, append(append([]string{}, valid...), flag, "1"))
	}
	for _, index := range []int{3, 5, 7} {
		for _, value := range []string{"", "0", "01", "+1", "-1", "1 ", "9223372036854775808", "2147483648"} {
			if index != 3 && value == "2147483648" {
				continue
			}
			args := append([]string{}, valid...)
			args[index] = value
			cases = append(cases, args)
		}
	}
	for _, index := range []int{9, 11} {
		for _, value := range []string{"", "main", strings.Repeat("A", 40), strings.Repeat("a", 39), strings.Repeat("a", 41), strings.Repeat("a", 64), " " + strings.Repeat("a", 40)} {
			args := append([]string{}, valid...)
			args[index] = value
			cases = append(cases, args)
		}
	}
	for _, args := range cases {
		var output, diagnostics bytes.Buffer
		code := Run(context.Background(), append([]string{"--url", server.URL}, args...), strings.NewReader(""), &output, &diagnostics, func(name string) string {
			if name == "GOLF_GITEA_TOKEN" {
				return "fixture-private-token"
			}
			return ""
		})
		if code != 2 || output.Len() != 0 || calls.Load() != 0 || strings.Contains(diagnostics.String(), "fixture-private-token") {
			t.Fatal("invalid diff selection authenticated or leaked input")
		}
	}
}

func TestSourceSelectorsFailBeforeCredentialInput(t *testing.T) {
	for _, flags := range [][]string{
		{"--ref-kind", ""}, {"--ref-kind", "default"}, {"--ref-kind", "BRANCH", "--ref", "main"},
		{"--ref-kind", "branch"}, {"--ref-kind", "tag"}, {"--ref-kind", "commit"},
		{"--ref-kind", "commit", "--ref", "main"}, {"--ref-kind", "commit", "--ref", strings.Repeat("A", 40)},
		{"--ref-kind", "tag", "--ref", "release~1"}, {"--ref-kind", "branch", "--ref", "feature//topic"},
		{"--ref-kind", "tag", "--ref", "release", "--path", "../private"},
	} {
		var output, diagnostic bytes.Buffer
		args := append([]string{"--token-stdin", "repo", "contents", "alice/private"}, flags...)
		if code := Run(context.Background(), args, unreadInput{t}, &output, &diagnostic, func(string) string { return "" }); code != 2 || output.Len() != 0 {
			t.Fatalf("invalid selector consumed credentials: %v", flags)
		}
	}
	for _, flags := range [][]string{{"--ref-kind", "tag", "--ref", "release"}, {"--ref-kind", "branch", "--ref", "main"}} {
		if _, err := parseCommand(append([]string{"repo", "commits", "alice/private"}, flags...)); err == nil {
			t.Fatal("source selector leaked into ordinary history flags")
		}
	}
}

// The fixture models separate authorized metadata, typed resolution and exact
// contents receipts. A rejected intermediate receipt must stop traversal.
func sourceReadFixture(t *testing.T, api bool, kind, name, failure string) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var calls []string
	sha, nativeID, path := strings.Repeat("a", 40), "9007199254740993", "src/hello %25 世界.txt"
	if kind == "COMMIT" {
		sha = name
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		mu.Lock()
		calls = append(calls, method)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Origin") != "http://"+r.Host || r.Method != "POST" {
			t.Error("source request lost origin binding")
		}
		if api {
			if r.Header.Get("Authorization") != "Bearer "+fixtureAPIToken || r.Header.Get("Cookie") != "" || method == "LoginWithGiteaToken" || method == "Logout" {
				t.Error("bearer source traversal crossed session boundary")
			}
		} else if method == "LoginWithGiteaToken" {
			http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "opaque", Path: "/", HttpOnly: true})
			fmt.Fprint(w, `{"user":{"id":"1"}}`)
			return
		} else if cookie, err := r.Cookie("golf_session"); err != nil || cookie.Value != "opaque" || r.Header.Get("Authorization") != "" {
			t.Error("source request lost temporary session")
		}
		if method == "Logout" {
			fmt.Fprint(w, `{}`)
			return
		}
		if method == failure {
			w.WriteHeader(403)
			fmt.Fprint(w, `{"code":"permission_denied","message":"fixture-private-token private-source"}`)
			return
		}
		var input struct {
			Repository              struct{ Owner, Name string }
			RepositoryId, Ref, Path string
			Selector                struct{ Kind, Name string }
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || input.Repository.Owner != "alice" || input.Repository.Name != "private" {
			t.Error("source repository address changed")
		}
		var result map[string]any
		switch method {
		case "GetRepository":
			result = map[string]any{"repository": map[string]any{"id": nativeID, "name": "private", "fullName": "alice/private"}}
			metadata := result["repository"].(map[string]any)
			switch failure {
			case "metadata-id":
				metadata["id"] = "9223372036854775808"
			case "metadata-route":
				metadata["fullName"] = "alice/replaced"
			}
		case "ResolveRepositorySource":
			if input.RepositoryId != nativeID || input.Path != path || input.Selector.Kind != "REPOSITORY_SOURCE_REF_KIND_"+kind || input.Selector.Name != name {
				t.Error("resolver selection or bigint/literal path changed")
			}
			selectedName := name
			if kind == "DEFAULT_BRANCH" {
				selectedName = "main"
			}
			selection := map[string]any{"kind": "REPOSITORY_SOURCE_REF_KIND_" + kind, "name": selectedName, "commitId": sha}
			if kind == "TAG" {
				selection["tagObjectId"] = strings.Repeat("b", 40)
			}
			result = map[string]any{"repositoryId": nativeID, "repository": map[string]any{"owner": "alice", "name": "private"}, "selection": selection, "path": path}
			switch failure {
			case "resolve-id":
				result["repositoryId"] = "1"
			case "resolve-route":
				result["repository"] = map[string]any{"owner": "other", "name": "private"}
			case "resolve-kind":
				selection["kind"] = "REPOSITORY_SOURCE_REF_KIND_TAG"
			case "resolve-name":
				selection["name"] = "other"
			case "resolve-sha":
				selection["commitId"] = "short"
			case "resolve-path":
				result["path"] = "private.txt"
			case "resolve-tag":
				selection["tagObjectId"] = "wrong"
			case "resolve-extra-tag":
				selection["tagObjectId"] = strings.Repeat("b", 40)
			}
		case "GetContents":
			if input.RepositoryId != nativeID || input.Ref != sha || input.Path != path {
				t.Error("contents used legacy/unresolved source selection")
			}
			result = map[string]any{"repositoryId": nativeID, "commitId": sha, "path": path, "kind": "SOURCE_ENTRY_TYPE_FILE", "file": map[string]any{"content": "private-source"}}
			switch failure {
			case "contents-id":
				result["repositoryId"] = "2"
			case "contents-sha":
				result["commitId"] = strings.Repeat("c", 40)
			case "contents-path":
				result["path"] = "other.txt"
			case "contents-missing-id":
				delete(result, "repositoryId")
			}
		default:
			t.Error("unexpected source procedure")
		}
		_ = json.NewEncoder(w).Encode(result)
	}))
	t.Cleanup(server.Close)
	return server, func() []string { mu.Lock(); defer mu.Unlock(); return append([]string{}, calls...) }
}

func TestSourceContentsTypedResolutionAndBoundReceipts(t *testing.T) {
	sha := strings.Repeat("a", 40)
	selectors := []struct {
		kind, name string
		flags      []string
	}{
		{"DEFAULT_BRANCH", "", nil}, {"BRANCH", "feature/topic", []string{"--ref", "feature/topic"}},
		{"TAG", "release", []string{"--ref", "release", "--ref-kind", "tag"}},
		{"COMMIT", sha, []string{"--ref", sha}},
		{"COMMIT", strings.Repeat("a", 64), []string{"--ref", strings.Repeat("a", 64), "--ref-kind", "commit"}},
		{"BRANCH", sha, []string{"--ref", sha, "--ref-kind", "branch"}},
		{"TAG", sha, []string{"--ref", sha, "--ref-kind", "tag"}},
	}
	for _, api := range []bool{false, true} {
		for _, selection := range selectors {
			t.Run(fmt.Sprintf("api=%v/%s/%s", api, selection.kind, selection.name), func(t *testing.T) {
				server, calls := sourceReadFixture(t, api, selection.kind, selection.name, "")
				var output, diagnostic bytes.Buffer
				flag, token := "--token-stdin", "fixture-private-token"
				if api {
					flag, token = "--api-token-stdin", fixtureAPIToken
				}
				args := append([]string{"--url", server.URL, flag, "repo", "contents", "alice/private", "--path", "src/hello %25 世界.txt"}, selection.flags...)
				code := Run(context.Background(), args, strings.NewReader(token+"\n"), &output, &diagnostic, func(string) string { return "" })
				wantSHA := sha
				if selection.kind == "COMMIT" {
					wantSHA = selection.name
				}
				var envelope struct {
					Data struct{ RepositoryId, CommitId, Path string }
				}
				if code != 0 || json.Unmarshal(output.Bytes(), &envelope) != nil || envelope.Data.RepositoryId != "9007199254740993" || envelope.Data.CommitId != wantSHA || envelope.Data.Path != "src/hello %25 世界.txt" {
					t.Fatalf("exact source read failed: code=%d diagnostic=%s", code, diagnostic.String())
				}
				want := "GetRepository,ResolveRepositorySource,GetContents"
				if !api {
					want = "LoginWithGiteaToken," + want + ",Logout"
				}
				if strings.Join(calls(), ",") != want {
					t.Fatalf("source traversal/session cleanup changed: %v", calls())
				}
			})
		}
	}
	for _, failure := range []string{"metadata-id", "metadata-route", "resolve-id", "resolve-route", "resolve-kind", "resolve-name", "resolve-sha", "resolve-path", "resolve-extra-tag", "contents-id", "contents-sha", "contents-path", "contents-missing-id", "GetRepository", "ResolveRepositorySource", "GetContents"} {
		t.Run(failure, func(t *testing.T) {
			server, calls := sourceReadFixture(t, false, "BRANCH", "feature/topic", failure)
			var output, diagnostic bytes.Buffer
			code := Run(context.Background(), []string{"--url", server.URL, "--token-stdin", "repo", "contents", "alice/private", "--ref", "feature/topic", "--path", "src/hello %25 世界.txt"}, strings.NewReader("fixture-private-token\n"), &output, &diagnostic, func(string) string { return "" })
			if code != 1 || output.Len() != 0 || strings.Contains(diagnostic.String(), "private-source") || strings.Contains(diagnostic.String(), "fixture-private-token") {
				t.Fatal("rejected source receipt leaked private output")
			}
			trace := calls()
			if trace[len(trace)-1] != "Logout" {
				t.Fatal("failed source traversal skipped cleanup")
			}
			if (strings.HasPrefix(failure, "metadata") || strings.HasPrefix(failure, "resolve") || failure == "GetRepository" || failure == "ResolveRepositorySource") && strings.Contains(strings.Join(trace, ","), "GetContents") {
				t.Fatal("invalid intermediate source receipt still fetched content")
			}
		})
	}
}

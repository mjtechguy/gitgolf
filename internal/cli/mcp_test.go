package cli

import (
	"bufio"
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

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func mcpTestSession(t *testing.T, origin, version string, ownerContext context.Context) *mcp.ClientSession {
	return mcpTestCredentialSession(t, origin, version, ownerContext, credential{token: "fixture-private-token"})
}

func mcpTestCredentialSession(t *testing.T, origin, version string, ownerContext context.Context, auth credential) *mcp.ClientSession {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	a, b := mcp.NewInMemoryTransports()
	session, err := newMCPServer(ownerContext, origin, auth).Connect(ctx, a, nil)
	if err != nil {
		t.Fatal(err)
	}
	client, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil).Connect(ctx, b, &mcp.ClientSessionOptions{ProtocolVersion: version})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close(); session.Close(); cancel() })
	return client
}

func TestMCPDiscoveryReadErrorsAndCleanup(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			var logins, reads, logouts atomic.Int32
			var denied, cleanupFailure atomic.Bool
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("Authorization") != "" {
					t.Error("MCP crossed credential/origin boundary")
				}
				w.Header().Set("Content-Type", "application/json")
				switch {
				case strings.HasSuffix(r.URL.Path, "/LoginWithGiteaToken"):
					logins.Add(1)
					http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "opaque", Path: "/", HttpOnly: true})
					fmt.Fprint(w, `{"user":{"id":"1"}}`)
				case strings.HasSuffix(r.URL.Path, "/Logout"):
					logouts.Add(1)
					if cleanupFailure.Load() {
						w.WriteHeader(503)
						fmt.Fprint(w, `{"code":"unavailable","message":"fixture-private-token"}`)
					} else {
						fmt.Fprint(w, `{}`)
					}
				case strings.HasSuffix(r.URL.Path, "/ListRepositories"):
					reads.Add(1)
					if denied.Load() {
						w.WriteHeader(403)
						fmt.Fprint(w, `{"code":"permission_denied","message":"fixture-private-token"}`)
					} else {
						fmt.Fprint(w, `{"repositories":[{"id":"9007199254740993","name":"private"}]}`)
					}
				default:
					t.Error("unexpected procedure")
				}
			}))
			defer upstream.Close()
			s := mcpTestSession(t, upstream.URL, version, context.Background())
			tools, err := s.ListTools(context.Background(), &mcp.ListToolsParams{})
			if err != nil || len(tools.Tools) != 24 || logins.Load() != 0 {
				t.Fatalf("discovery performed authentication or lost tools: %v", err)
			}
			for _, tool := range tools.Tools {
				if tool.Annotations == nil || tool.Annotations.ReadOnlyHint || tool.Annotations.IdempotentHint || *tool.Annotations.DestructiveHint || !*tool.Annotations.OpenWorldHint {
					t.Fatal("tool metadata hides audit/provider effects")
				}
			}
			call := func(args any) *mcp.CallToolResult {
				t.Helper()
				result, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_repo_list", Arguments: args})
				if err != nil {
					t.Fatal(err)
				}
				return result
			}
			for _, args := range []any{map[string]any{"origin": "https://evil.example"}, map[string]any{"token": "secret"}, map[string]any{"page": 0}, map[string]any{"limit": 101}, map[string]any{"page": 1.5}, map[string]any{"page": nil}} {
				if result := call(args); !result.IsError || result.StructuredContent != nil || logins.Load() != 0 {
					t.Fatal("invalid input authenticated or returned data")
				}
			}
			result := call(map[string]any{"page": 1, "limit": 2})
			encoded, _ := json.Marshal(result.StructuredContent)
			var structured, textual any
			json.Unmarshal(encoded, &structured)
			json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &textual)
			if result.IsError || !reflect.DeepEqual(structured, textual) || !bytes.Contains(encoded, []byte(`"9007199254740993"`)) || !bytes.Contains(encoded, []byte(`"schema_version":"golf.mcp.v1"`)) {
				t.Fatal("structured/text parity, schema or exact IDs lost")
			}
			denied.Store(true)
			if result := call(map[string]any{}); !result.IsError || result.StructuredContent != nil || strings.Contains(result.Content[0].(*mcp.TextContent).Text, "fixture-private-token") {
				t.Fatal("unsafe permission error")
			}
			denied.Store(false)
			cleanupFailure.Store(true)
			if result := call(map[string]any{}); !result.IsError || result.StructuredContent != nil {
				t.Fatal("failed cleanup released private output")
			}
			if logins.Load() != 3 || reads.Load() != 3 || logouts.Load() != 3 {
				t.Fatal("temporary sessions were reused or not closed")
			}
			if _, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_repo_create", Arguments: map[string]any{}}); err == nil || logins.Load() != 3 {
				t.Fatal("write tool accepted")
			}
		})
	}
}

func TestMCPInputAndLaunchBoundary(t *testing.T) {
	values := map[string]any{"repository": "alice/private", "organization": "org", "team_id": "9007199254740993", "idempotency_key": "12345678-1234-4234-8234-123456789abc", "commit_id": strings.Repeat("a", 40), "number": 1, "review_id": "9007199254740993", "repository_id": "9007199254740994", "pull_request_id": "9223372036854775807", "review_commit_id": strings.Repeat("a", 40), "base_commit_id": strings.Repeat("b", 40), "head_commit_id": strings.Repeat("a", 40)}
	for _, tool := range mcpReads {
		args := map[string]any{}
		for _, key := range tool.schema()["required"].([]string) {
			args[key] = values[key]
		}
		raw, _ := json.Marshal(args)
		if parsed, err := tool.parse(raw); err != nil || parsed.name != tool.command {
			t.Fatalf("catalogue %s: %v", tool.name, err)
		}
		for _, raw := range []json.RawMessage{json.RawMessage(`null`), json.RawMessage(`[]`), json.RawMessage(`{"command":"rm -rf /"}`), json.RawMessage(`{"origin":"https://evil.example"}`)} {
			if _, err := tool.parse(raw); err == nil {
				t.Fatalf("accepted invalid %s input", tool.name)
			}
		}
	}
	for _, entry := range []struct{ name, raw string }{
		{"golf_issue_list", `{"repository":"a/b","state":""}`},
		{"golf_issue_comments", `{"repository":"a/b","number":2147483648}`},
		{"golf_issue_comments", `{"repository":"a/b","number":1,"issue_id":"2"}`},
		{"golf_issue_operation", `{"idempotency_key":"12345678-1234-1234-8234-123456789abc"}`},
		{"golf_pr_view", `{"repository":"a/b","number":2147483648}`},
		{"golf_repo_creation", `{"idempotency_key":"12345678-1234-1234-8234-123456789abc"}`},
		{"golf_team_view", `{"organization":"org","team_id":9007199254740993}`},
		{"golf_audit_list", `{"before_id":"","snapshot_id":""}`},
		{"golf_repo_view", `{"repository":"a/b?token=secret"}`},
		{"golf_repo_contents", `{"repository":"a/b","path":"../private"}`},
		{"golf_repo_contents", `{"repository":"a/b","ref":"main~1"}`},
		{"golf_repo_commits", `{"repository":"a/b","path":"src/a.ts","ref":"main"}`},
		{"golf_repo_commits", `{"repository":"a/b","path":"../other","ref":"` + strings.Repeat("a", 40) + `"}`},
		{"golf_repo_contents", `{"repository":"a/b","path":"a\\b"}`},
	} {
		for _, tool := range mcpReads {
			if tool.name == entry.name {
				if _, err := tool.parse(json.RawMessage(entry.raw)); err == nil {
					t.Fatal("schema mismatch accepted")
				}
			}
		}
	}
	var output, diagnostic bytes.Buffer
	if code := Run(context.Background(), []string{"--token-stdin", "mcp"}, strings.NewReader("secret"), &output, &diagnostic, func(string) string { return "" }); code != 2 || output.Len() != 0 {
		t.Fatal("MCP consumed protocol stdin as credential")
	}
}

func TestMCPFrameBoundary(t *testing.T) {
	for _, input := range []string{"[]\n", "[{\"jsonrpc\":\"2.0\"}]\n", "null\n", "{}", "{}{}\n", "{\"x\":\"\xff\"}\n", "\n", "{\"padding\":\"" + strings.Repeat("a", 64<<10) + "\"}\n"} {
		reader := &mcpInput{Reader: strings.NewReader(input), frames: bufio.NewReaderSize(strings.NewReader(input), (64<<10)+1)}
		if _, err := io.ReadAll(reader); err == nil {
			t.Fatal("batch, partial or oversized frame accepted")
		}
	}
	input := " {\"jsonrpc\":\"2.0\",\"id\":1}\n{\"jsonrpc\":\"2.0\",\"id\":2}\n"
	reader := &mcpInput{Reader: strings.NewReader(input), frames: bufio.NewReaderSize(strings.NewReader(input), (64<<10)+1)}
	data, err := io.ReadAll(reader)
	if err != nil || string(data) != input {
		t.Fatal("ordinary framed messages changed")
	}
}

func TestMCPCancellationAndSaturation(t *testing.T) {
	for _, processCancellation := range []bool{false, true} {
		t.Run(fmt.Sprint("process=", processCancellation), func(t *testing.T) {
			var logouts atomic.Int32
			started := make(chan struct{}, 4)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case strings.HasSuffix(r.URL.Path, "/LoginWithGiteaToken"):
					http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "opaque", Path: "/"})
					fmt.Fprint(w, `{"user":{"id":"1"}}`)
				case strings.HasSuffix(r.URL.Path, "/Logout"):
					logouts.Add(1)
					fmt.Fprint(w, `{}`)
				default:
					io.Copy(io.Discard, r.Body)
					started <- struct{}{}
					<-r.Context().Done()
				}
			}))
			defer upstream.Close()
			ownerContext, stopOwner := context.WithCancel(context.Background())
			defer stopOwner()
			s := mcpTestSession(t, upstream.URL, "2026-07-28", ownerContext)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{}, 4)
			for range 4 {
				go func() {
					defer func() { done <- struct{}{} }()
					s.CallTool(ctx, &mcp.CallToolParams{Name: "golf_repo_list", Arguments: map[string]any{}})
				}()
			}
			for range 4 {
				select {
				case <-started:
				case <-time.After(3 * time.Second):
					t.Fatal("call did not start")
				}
			}
			result, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_repo_list", Arguments: map[string]any{}})
			if err != nil || !result.IsError || !strings.Contains(result.Content[0].(*mcp.TextContent).Text, "busy") {
				t.Fatal("unbounded concurrent work admitted")
			}
			if processCancellation {
				stopOwner()
			} else {
				cancel()
			}
			for range 4 {
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Fatal("cancellation did not propagate")
				}
			}
			deadline := time.Now().Add(3 * time.Second)
			for logouts.Load() != 4 && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			if logouts.Load() != 4 {
				t.Fatal("cancelled calls did not independently log out")
			}

		})
	}
}

func TestMCPExplicitPullReadsAndCredentialModes(t *testing.T) {
	ref := strings.Repeat("a", 40)
	for _, selection := range []struct {
		name, procedure    string
		required           []string
		arguments, request map[string]any
		response, fragment string
	}{
		{"golf_pr_review_comments", "GetPullRequestReviewComments", []string{"repository", "number", "review_id", "repository_id", "pull_request_id", "review_commit_id"},
			map[string]any{"repository": "alice/private", "number": 7, "review_id": "9007199254740993", "repository_id": "9007199254740994", "pull_request_id": "9223372036854775807", "review_commit_id": ref},
			map[string]any{"repository": map[string]any{"owner": "alice", "name": "private"}, "number": float64(7), "repositoryId": "9007199254740994", "pullRequestId": "9223372036854775807", "reviewId": "9007199254740993", "reviewCommitId": ref},
			`{"repositoryId":"9007199254740994","pullRequestId":"9223372036854775807","review":{"id":"9007199254740993"},"comments":[{"id":"9007199254740995","body":"private-review-body"}]}`, `"9007199254740995"`},
		{"golf_pr_diff", "GetPullRequestDiff", []string{"repository", "number", "repository_id", "pull_request_id", "base_commit_id", "head_commit_id"},
			map[string]any{"repository": "alice/private", "number": 7, "repository_id": "9007199254740994", "pull_request_id": "9223372036854775807", "base_commit_id": strings.Repeat("b", 40), "head_commit_id": ref},
			map[string]any{"repository": map[string]any{"owner": "alice", "name": "private"}, "number": float64(7), "repositoryId": "9007199254740994", "pullRequestId": "9223372036854775807", "baseCommitId": strings.Repeat("b", 40), "headCommitId": ref},
			`{"repositoryId":"9007199254740994","pullRequestId":"9223372036854775807","baseCommitId":"` + strings.Repeat("b", 40) + `","headCommitId":"` + ref + `","mergeBaseCommitId":"` + strings.Repeat("c", 40) + `","rawDiff":"private-review-body"}`, `"mergeBaseCommitId":"` + strings.Repeat("c", 40) + `"`},
	} {
		arguments := selection.arguments
		var tool mcpRead
		for _, candidate := range mcpReads {
			if candidate.name == selection.name {
				tool = candidate
			}
		}
		if !reflect.DeepEqual(tool.schema()["required"], selection.required) {
			t.Fatal("explicit identity fields are not required")
		}
		properties := tool.schema()["properties"].(map[string]any)
		for _, field := range selection.required[2:] {
			if properties[field].(map[string]any)["type"] != "string" {
				t.Fatal("opaque ID became a number")
			}
		}
		for _, version := range []string{"2026-07-28", "2025-11-25"} {
			for _, api := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/api=%v", selection.name, version, api), func(t *testing.T) {
					var logins, reads, logouts atomic.Int32
					var deny, failCleanup atomic.Bool
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						w.Header().Set("Content-Type", "application/json")
						if r.Header.Get("Origin") != "http://"+r.Host {
							t.Error("origin changed")
						}
						switch {
						case strings.HasSuffix(r.URL.Path, "/LoginWithGiteaToken"):
							if api {
								t.Error("bearer attempted bootstrap")
							}
							logins.Add(1)
							http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "temporary", Path: "/", HttpOnly: true})
							fmt.Fprint(w, `{}`)
						case strings.HasSuffix(r.URL.Path, "/Logout"):
							logouts.Add(1)
							if failCleanup.Load() {
								w.WriteHeader(503)
								fmt.Fprint(w, `{"code":"unavailable","message":"fixture-private-token"}`)
							} else {
								fmt.Fprint(w, `{}`)
							}
						case strings.HasSuffix(r.URL.Path, "/"+selection.procedure):
							reads.Add(1)
							var input map[string]any
							if json.NewDecoder(r.Body).Decode(&input) != nil || !reflect.DeepEqual(input, selection.request) {
								t.Error("selection/alias mapping lost precision")
							}
							if api {
								if r.Header.Get("Authorization") != "Bearer fixture-private-token" || r.Header.Get("Cookie") != "" {
									t.Error("bearer authority changed")
								}
							} else if cookie, err := r.Cookie("golf_session"); err != nil || cookie.Value != "temporary" {
								t.Error("temporary session missing")
							}
							if deny.Load() {
								w.WriteHeader(403)
								fmt.Fprint(w, `{"code":"permission_denied","message":"fixture-private-token private-review-body"}`)
							} else {
								fmt.Fprint(w, selection.response)
							}
						default:
							t.Error("unexpected lookup/pager/write")
							w.WriteHeader(404)
						}
					}))
					defer upstream.Close()
					session := mcpTestCredentialSession(t, upstream.URL, version, context.Background(), credential{token: "fixture-private-token", api: api})
					call := func(args map[string]any) *mcp.CallToolResult {
						t.Helper()
						result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: tool.name, Arguments: args})
						if err != nil {
							t.Fatal(err)
						}
						return result
					}
					for _, field := range selection.required[2:] {
						for _, value := range []any{nil, "", float64(9007199254740993), "01", "+1", "9223372036854775808", "main"} {
							input := map[string]any{}
							for key, original := range arguments {
								input[key] = original
							}
							input[field] = value
							if result := call(input); !result.IsError || result.StructuredContent != nil || logins.Load() != 0 || reads.Load() != 0 {
								t.Fatal("invalid opaque selection reached authentication")
							}
						}
						input := map[string]any{}
						for key, original := range arguments {
							if key != field {
								input[key] = original
							}
						}
						if result := call(input); !result.IsError || logins.Load() != 0 || reads.Load() != 0 {
							t.Fatal("missing binding authenticated")
						}
					}
					if selection.name == "golf_pr_diff" {
						input := map[string]any{}
						for key, value := range arguments {
							input[key] = value
						}
						input["head_commit_id"] = strings.Repeat("a", 64)
						if result := call(input); !result.IsError || logins.Load() != 0 || reads.Load() != 0 {
							t.Fatal("mismatched object widths authenticated")
						}
					}
					for _, field := range []string{"page", "limit", "token", "origin", "command"} {
						input := map[string]any{}
						for key, value := range arguments {
							input[key] = value
						}
						input[field] = 1
						if result := call(input); !result.IsError || reads.Load() != 0 {
							t.Fatal("extra authority/pagination accepted")
						}
					}
					result := call(arguments)
					encoded, _ := json.Marshal(result.StructuredContent)
					var structured, textual any
					json.Unmarshal(encoded, &structured)
					json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &textual)
					if result.IsError || !reflect.DeepEqual(structured, textual) || !strings.Contains(string(encoded), selection.fragment) {
						t.Fatal("successful comment output/IDs/parity lost")
					}
					deny.Store(true)
					result = call(arguments)
					if !result.IsError || result.StructuredContent != nil || strings.Contains(result.Content[0].(*mcp.TextContent).Text, "private-review-body") || strings.Contains(result.Content[0].(*mcp.TextContent).Text, "fixture-private-token") {
						t.Fatal("denied private output leaked")
					}
					want := int32(2)
					if !api {
						deny.Store(false)
						failCleanup.Store(true)
						result = call(arguments)
						if !result.IsError || result.StructuredContent != nil {
							t.Fatal("failed logout released comments")
						}
						want = 3
					}
					if reads.Load() != want || api && (logins.Load() != 0 || logouts.Load() != 0) || !api && (logins.Load() != want || logouts.Load() != want) {
						t.Fatal("cleanup reused sessions or bearer performed session writes")
					}
				})
			}
		}
	}
}

func TestMCPSourceTypedSelectorsExactReceiptsAndCredentialBoundary(t *testing.T) {
	var tool mcpRead
	for _, entry := range mcpReads {
		if entry.name == "golf_repo_contents" {
			tool = entry
		}
	}
	schema := tool.schema()
	if !reflect.DeepEqual(schema["required"], []string{"repository"}) || !reflect.DeepEqual(schema["properties"].(map[string]any)["ref_kind"].(map[string]any)["enum"], []string{"branch", "tag", "commit"}) {
		t.Fatal("source selector schema changed required fields or namespaces")
	}
	for _, raw := range []string{`{"repository":"alice/private","ref_kind":"default"}`, `{"repository":"alice/private","ref_kind":""}`, `{"repository":"alice/private","ref_kind":"tag"}`, `{"repository":"alice/private","ref_kind":"commit","ref":"main"}`, `{"repository":"alice/private","ref_kind":null}`, `{"repository":"alice/private","ref_kind":"branch","ref":"feature//topic"}`} {
		if _, err := tool.parse(json.RawMessage(raw)); err == nil {
			t.Fatal("invalid typed source arguments accepted")
		}
	}
	sha := strings.Repeat("a", 40)
	selections := []struct {
		kind, name string
		args       map[string]any
	}{
		{"DEFAULT_BRANCH", "", map[string]any{}},
		{"BRANCH", "release", map[string]any{"ref": "release"}},
		{"TAG", "release", map[string]any{"ref": "release", "ref_kind": "tag"}},
		{"COMMIT", sha, map[string]any{"ref": sha}},
		{"TAG", sha, map[string]any{"ref": sha, "ref_kind": "tag"}},
	}
	for _, api := range []bool{false, true} {
		for _, selection := range selections {
			t.Run(fmt.Sprintf("api=%v/%s/%s", api, selection.kind, selection.name), func(t *testing.T) {
				upstream, calls := sourceReadFixture(t, api, selection.kind, selection.name, "")
				auth := credential{token: "fixture-private-token"}
				if api {
					auth = credential{token: fixtureAPIToken, api: true}
				}
				session := mcpTestCredentialSession(t, upstream.URL, "2026-07-28", context.Background(), auth)
				invalidResult, invalidErr := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_repo_contents", Arguments: map[string]any{"repository": "alice/private", "ref_kind": "commit", "ref": "main"}})
				if invalidErr != nil || !invalidResult.IsError || len(calls()) != 0 {
					t.Fatal("invalid typed source arguments performed authentication/network")
				}
				args := map[string]any{"repository": "alice/private", "path": "src/hello %25 世界.txt"}
				for key, value := range selection.args {
					args[key] = value
				}
				result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_repo_contents", Arguments: args})
				if err != nil || result.IsError {
					t.Fatalf("typed MCP source read failed: %v", err)
				}
				encoded, _ := json.Marshal(result.StructuredContent)
				var structured, textual any
				json.Unmarshal(encoded, &structured)
				json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &textual)
				if !reflect.DeepEqual(structured, textual) || !strings.Contains(string(encoded), `"repositoryId":"9007199254740993"`) || !strings.Contains(string(encoded), `"commitId":"`+sha+`"`) {
					t.Fatal("MCP source envelope lost bound identity/text parity")
				}
				want := "GetRepository,ResolveRepositorySource,GetContents"
				if !api {
					want = "LoginWithGiteaToken," + want + ",Logout"
				}
				if strings.Join(calls(), ",") != want {
					t.Fatalf("MCP traversal/lifecycle boundary changed: %v", calls())
				}
			})
		}
	}
	for _, failure := range []string{"resolve-id", "resolve-tag", "contents-sha", "ResolveRepositorySource", "GetContents"} {
		t.Run("failure="+failure, func(t *testing.T) {
			upstream, calls := sourceReadFixture(t, true, "TAG", "release", failure)
			session := mcpTestCredentialSession(t, upstream.URL, "2026-07-28", context.Background(), credential{token: fixtureAPIToken, api: true})
			result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_repo_contents", Arguments: map[string]any{"repository": "alice/private", "ref": "release", "ref_kind": "tag", "path": "src/hello %25 世界.txt"}})
			if err != nil || !result.IsError || result.StructuredContent != nil || strings.Contains(result.Content[0].(*mcp.TextContent).Text, "private-source") {
				t.Fatal("MCP invalid/denied source released private output")
			}
			if strings.Contains(strings.Join(calls(), ","), "LoginWithGiteaToken") || strings.Contains(strings.Join(calls(), ","), "Logout") {
				t.Fatal("MCP bearer traversal created a session")
			}
		})
	}
}

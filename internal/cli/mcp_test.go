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
			if err != nil || len(tools.Tools) != 21 || logins.Load() != 0 {
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
	values := map[string]any{"repository": "alice/private", "organization": "org", "team_id": "9007199254740993", "idempotency_key": "12345678-1234-4234-8234-123456789abc", "commit_id": strings.Repeat("a", 40), "number": 1}
	for _, tool := range mcpReads {
		args := map[string]any{}
		for _, key := range tool.positions {
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

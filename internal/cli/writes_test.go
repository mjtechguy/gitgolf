package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const writeBody = `{"repository":{"owner":"alice","name":"repo"},"repositoryId":"10","idempotencyKey":"12345678-1234-4234-8234-123456789abc"}`

func TestTypedWriteCommandValidation(t *testing.T) {
	for _, name := range []string{"issue create", "issue comment", "issue update", "pr create", "pr update", "pr review"} {
		args := append(strings.Fields(name), "--input", "request.json")
		c, e := parseCommand(args)
		if e != nil || decodeWriteRequest(&c, []byte(writeBody)) != nil || c.writeRequest == nil {
			t.Fatal(name, e)
		}
		for _, raw := range []string{`null`, `{}`, strings.Replace(writeBody, "repositoryId", "token", 1), strings.Replace(writeBody, "10", "010", 1), strings.Replace(writeBody, "alice", "..", 1), strings.Replace(writeBody, "4234", "1234", 1)} {
			if decodeWriteRequest(&c, []byte(raw)) == nil {
				t.Fatal("unsafe write input accepted", name, raw)
			}
		}
	}
	for _, args := range [][]string{{"issue", "create"}, {"pr", "review", "--input", "-"}, {"issue", "create", "--input", "x", "--token", "private"}} {
		if _, e := parseCommand(args); e == nil {
			t.Fatal("unsafe invocation accepted")
		}
	}
}
func TestCLIWriteRequiresScopedBearerAndNeverRetries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request.json")
	if e := os.WriteFile(path, []byte(writeBody), 0600); e != nil {
		t.Fatal(e)
	}
	var calls atomic.Int32
	token := strings.Replace(fixtureAPIToken, "golf_ro_", "golf_rw_", 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Cookie") != "" || r.URL.Path != "/rpc/golf.v1.RepositoryService/CreateIssue" {
			t.Error("write crossed explicit authority")
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		if json.Unmarshal(raw, &body) != nil || body["idempotencyKey"] != "12345678-1234-4234-8234-123456789abc" {
			t.Error("original intent lost")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		io.WriteString(w, `{"code":"unavailable","message":"`+token+` private body"}`)
	}))
	defer server.Close()
	for _, credential := range []string{fixtureAPIToken, token} {
		var out, diag bytes.Buffer
		code := Run(context.Background(), []string{"--url", server.URL, "issue", "create", "--input", path}, strings.NewReader(""), &out, &diag, func(key string) string {
			if key == "GOLF_API_TOKEN" {
				return credential
			}
			return ""
		})
		if credential == fixtureAPIToken {
			if code != 2 || calls.Load() != 0 {
				t.Fatal("read-only credential issued write")
			}
		} else if code != 1 || calls.Load() != 1 || !strings.Contains(diag.String(), "inspect the original key") || strings.Contains(diag.String(), token) || out.Len() != 0 {
			t.Fatal("write retried/leaked/uncertain outcome hidden", diag.String())
		}
	}
}
func TestMCPExplicitWriteCatalogueAndTypedDispatch(t *testing.T) {
	token := strings.Replace(fixtureAPIToken, "golf_ro_", "golf_rw_", 1)
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			if r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Cookie") != "" {
				t.Error("credential boundary")
			}
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"mutation":{"state":"ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN","idempotencyKey":"12345678-1234-4234-8234-123456789abc"}}`)
		}))
		session := mcpTestCredentialSession(t, server.URL, version, context.Background(), credential{token: token, api: true})
		listed, e := session.ListTools(context.Background(), &mcp.ListToolsParams{})
		if e != nil || len(listed.Tools) != len(mcpReads)+len(mcpWrites) || calls.Load() != 0 {
			t.Fatal("unsafe discovery", e)
		}
		for _, tool := range listed.Tools {
			if tool.Name == "golf_issue_create" && (tool.Annotations == nil || tool.Annotations.DestructiveHint == nil || !*tool.Annotations.DestructiveHint || tool.Annotations.IdempotentHint) {
				t.Fatal("write metadata hides effects")
			}
		}
		for _, args := range []any{map[string]any{"request": map[string]any{}}, map[string]any{"request": json.RawMessage(writeBody), "origin": "https://foreign.invalid"}, map[string]any{"request": json.RawMessage(strings.Replace(writeBody, "repositoryId", "token", 1))}} {
			result, e := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_issue_create", Arguments: args})
			if e != nil || !result.IsError || calls.Load() != 0 {
				t.Fatal("invalid input reached network", e)
			}
		}
		result, e := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_issue_create", Arguments: map[string]any{"request": json.RawMessage(writeBody)}})
		if e != nil || result.IsError || calls.Load() != 1 || !strings.Contains(result.Content[0].(*mcp.TextContent).Text, "OUTCOME_UNKNOWN") {
			t.Fatal("unknown journal state lost", e)
		}
		server.Close()
	}
}

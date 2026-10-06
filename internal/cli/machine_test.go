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
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMachineCatalogueTypedRoutesAndNoRetries(t *testing.T) {
	repo := `{"repository":{"owner":"alice","name":"private"},"repositoryId":"11","ownerId":"42","accessRevision":"` + strings.Repeat("a", 64) + `","branch":"main"}`
	operation := `{"repository":{"owner":"alice","name":"private"},"repositoryId":"11","ownerId":"42","operationId":"12345678-1234-4234-8234-123456789abc"}`
	cases := []struct{ name, body, procedure, response string }{
		{"repo access", `{"repository":{"owner":"alice","name":"private"}}`, "RepositoryAccessService/GetRepositoryAccess", `{}`},
		{"source access", repo, "RepositoryFileMutationService/GetRepositoryFileMutationAccess", `{}`},
		{"source operation", operation, "RepositoryFileMutationService/GetRepositoryFileMutationOperation", `{}`},
		{"ref operation", operation, "RepositoryRefMutationService/GetRepositoryRefMutationOperation", `{}`},
		{"actions list", `{"repository":{"owner":"alice","name":"private"},"page":{"page":1,"limit":20}}`, "WorkflowRunService/ListWorkflowRuns", `{"runs":[]}`},
		{"actions view", `{"runId":"12345678-1234-4234-8234-123456789abc"}`, "WorkflowRunService/GetWorkflowRun", `{}`},
		{"actions logs", `{"runId":"12345678-1234-4234-8234-123456789abc","afterSequence":"7","jobInstanceId":"job-a","stepId":"step-a"}`, "WorkflowRunService/GetWorkflowRunLogs", `{}`},
		{"agent list", `{"repository":{"owner":"alice","name":"private"}}`, "AgentTaskService/ListAgentTasks", `{"tasks":[]}`},
		{"agent view", `{"taskId":"12345678-1234-4234-8234-123456789abc"}`, "AgentTaskService/GetAgentTask", `{}`},
		{"agent events", `{"repository":{"owner":"alice","name":"private"},"repositoryId":"11","taskId":"12345678-1234-4234-8234-123456789abc","attemptId":"` + strings.Repeat("c", 32) + `","afterSequence":"0","limit":32}`, "AgentTaskService/ListAgentTaskEvents", `{}`},
	}
	token := strings.Replace(fixtureAPIToken, "golf_ro_", "golf_rw_", 1)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			fail := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/rpc/golf.v1."+tc.procedure || r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Cookie") != "" {
					t.Error("typed route/credential changed")
				}
				raw, _ := io.ReadAll(r.Body)
				var got, want map[string]any
				json.Unmarshal(raw, &got)
				json.Unmarshal([]byte(tc.body), &want)
				actual, _ := json.Marshal(got)
				expected, _ := json.Marshal(want)
				if string(actual) != string(expected) {
					t.Error("typed original selection changed")
				}
				w.Header().Set("Content-Type", "application/json")
				if fail {
					w.WriteHeader(503)
					io.WriteString(w, `{"code":"unavailable","message":"private"}`)
					return
				}
				io.WriteString(w, tc.response)
			}))
			defer server.Close()
			file := filepath.Join(t.TempDir(), "request.json")
			os.WriteFile(file, []byte(tc.body), 0600)
			for _, failure := range []bool{false, true} {
				fail = failure
				var out, diagnostic bytes.Buffer
				args := append(append([]string{"--url", server.URL}, strings.Fields(tc.name)...), "--input", file)
				code := Run(context.Background(), args, strings.NewReader(""), &out, &diagnostic, func(key string) string {
					if key == "GOLF_API_TOKEN" {
						return token
					}
					return ""
				})
				if failure {
					if code != 1 || out.Len() != 0 || strings.Contains(diagnostic.String(), "outcome may be unknown") {
						t.Fatal("inspection failure mislabeled as write")
					}
				} else if code != 0 {
					t.Fatal("typed machine read failed", diagnostic.String())
				}
			}
			if calls != 2 {
				t.Fatal("machine read automatically retried")
			}
		})
	}
}
func TestMachineMCPReadMetadata(t *testing.T) {
	token := strings.Replace(fixtureAPIToken, "golf_ro_", "golf_rw_", 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("discovery performed network call") }))
	defer server.Close()
	session := mcpTestCredentialSession(t, server.URL, "2026-07-28", context.Background(), credential{token: token, api: true})
	tools, e := session.ListTools(context.Background(), &mcp.ListToolsParams{})
	if e != nil {
		t.Fatal(e)
	}
	for _, tool := range tools.Tools {
		if strings.HasPrefix(tool.Name, "golf_agent_") || strings.HasPrefix(tool.Name, "golf_actions_") {
			if tool.Annotations == nil || tool.Annotations.DestructiveHint == nil || *tool.Annotations.DestructiveHint {
				t.Fatal("inspection advertised destructive", tool.Name)
			}
		}
	}
}

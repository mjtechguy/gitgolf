package runner

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgentProtocol(t *testing.T) {
	events := `{"id":1,"result":{}}
{"id":2,"result":{"thread":{"id":"thread"}}}
{"id":3,"result":{"turn":{"id":"turn"}}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"thread","tokenUsage":{"total":{"totalTokens":100}}}}
{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"type":"commandExecution","text":"PRIVATE"}}}
{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","text":"Proposed change"}}}
{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}
`
	var requests bytes.Buffer
	r, e := agentProtocol(context.Background(), &requests, strings.NewReader(events), AgentJob{Model: "model", TokenBudget: 1000, Instructions: "task"})
	if e != nil || r.State != "succeeded" || r.Tokens != 100 || r.Summary != "Proposed change" || strings.Contains(r.Summary, "PRIVATE") {
		t.Fatal("Native completion evidence or output isolation failed")
	}
	if !strings.Contains(requests.String(), `"approvalPolicy":"never"`) || strings.Contains(requests.String(), "dangerFullAccess") {
		t.Fatal("Task approvals broadened")
	}
	r, e = agentProtocol(context.Background(), &requests, strings.NewReader(strings.Replace(events, "\"totalTokens\":100", "\"totalTokens\":1001", 1)), AgentJob{Model: "model", TokenBudget: 1000})
	if e != nil || r.State != "budget_exceeded" || !strings.Contains(requests.String(), "turn/interrupt") {
		t.Fatal("Observed usage limit did not interrupt")
	}
	_, e = agentProtocol(context.Background(), &requests, strings.NewReader(strings.Replace(events, `"status":"completed"`, `"status":"completed","id":"foreign"`, 1)), AgentJob{Model: "model", TokenBudget: 1000})
	if e == nil {
		t.Fatal("Foreign completion accepted")
	}
	r, e = agentProtocol(context.Background(), &requests, strings.NewReader(events[:strings.LastIndex(events, `{"method":"turn/completed"`)]), AgentJob{Model: "model", TokenBudget: 1000})
	if e == nil || r.State == "succeeded" {
		t.Fatal("EOF became success")
	}
}
func TestPinnedAgentSandbox(t *testing.T) {
	image := os.Getenv("GOLF_TEST_AGENT_IMAGE")
	if image == "" {
		t.Skip("Set exact owned local image for native sandbox qualification")
	}
	e, err := New(Config{WorkerID: "agent-qualification", ApprovedImages: []string{image}})
	if err != nil {
		t.Fatal(err)
	}
	profile, err := filepath.Abs("../../deploy/docker/codex/seccomp.json")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	if err = e.QualifyAgent(ctx, image, profile); err != nil {
		t.Fatal("Native credential-read/network isolation failed; diagnostics private")
	}
}

package runner

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestManagedACPEnvelopeAndUsage(t *testing.T) {
	envelope, e := managedACPEnvelope(AgentJob{Auth: []byte(`{"apiKey":"native-provider-credential-123456"}`), Model: "opencode-go/model"})
	if e != nil {
		t.Fatal(e)
	}
	input := tar.NewReader(bytes.NewReader(envelope))
	found := false
	for {
		h, e := input.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		raw, e := io.ReadAll(input)
		if e != nil {
			t.Fatal(e)
		}
		if h.Name == ".config/opencode/opencode.json" {
			var cfg struct {
				Model      string
				Permission map[string]json.RawMessage
			}
			if json.Unmarshal(raw, &cfg) != nil || cfg.Model != "opencode-go/model" || bytes.Contains(raw, []byte("native-provider-credential")) {
				t.Fatal("model/policy envelope mixed authority")
			}
			var edit map[string]string
			if json.Unmarshal(cfg.Permission["edit"], &edit) != nil || edit["/workspace/**"] != "ask" || edit["/workspace/.git/**"] != "deny" || edit["/workspace/.codex/**"] != "deny" || edit["/workspace/.opencode/**"] != "deny" || edit["/workspace/opencode.json"] != "deny" || edit["*"] != "deny" {
				t.Fatal("native file edit authority widened")
			}
			found = true
		}
	}
	if !found {
		t.Fatal("native policy missing")
	}
	usage := `{"info":{"id":"session"},"messages":[{"info":{"id":"message","sessionID":"session","role":"assistant","providerID":"opencode-go","modelID":"model","tokens":{"input":10,"output":5,"reasoning":2,"cache":{"read":3,"write":4}}}}]}`
	if total, e := managedACPUsageReceipt([]byte(usage), "session", "opencode-go/model"); e != nil || total != 24 {
		t.Fatal("native completed usage lost", total, e)
	}
	for _, raw := range []string{strings.Replace(usage, `"sessionID":"session"`, `"sessionID":"foreign"`, 1), strings.Replace(usage, `"input":10`, `"input":-1`, 1), strings.Replace(usage, `"modelID":"model"`, `"modelID":"foreign"`, 1), `{"info":{"id":"session"},"messages":[]}`, `{"info":{"id":"session"},"used":24,"size":1000}`} {
		if _, e := managedACPUsageReceipt([]byte(raw), "session", "opencode-go/model"); e == nil {
			t.Fatal("malformed/context usage counted as cumulative tokens")
		}
	}
	if _, e := managedACPEnvelope(AgentJob{Auth: []byte(`{"apiKey":"native-provider-credential-123456"}`), Model: "opencode-go/model", Reasoning: "unnegotiated"}); e == nil {
		t.Fatal("unsupported variant fabricated")
	}
}

package runner

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestReviewPrivateEnvelopeAndEvents(t *testing.T) {
	b, e := reviewEnvelope(AgentJob{Auth: []byte(`{"apiKey":"qualification-not-a-real-key"}`), Model: "opencode-go/deepseek-v4-pro", Instructions: "untrusted diff"})
	if e != nil {
		t.Fatal(e)
	}
	r := tar.NewReader(bytes.NewReader(b))
	count := 0
	for {
		h, e := r.Next()
		if e == io.EOF {
			break
		}
		if e != nil || h.Mode != 0600 || h.Uid != 1000 {
			t.Fatal("private envelope")
		}
		data, _ := io.ReadAll(r)
		if h.Name == ".config/opencode/opencode.json" && !json.Valid(data) {
			t.Fatal("config")
		}
		count++
	}
	if count != 2 {
		t.Fatal(count)
	}
	events := `{"type":"text","part":{"text":"{\"summary\":\"Clean\",\"findings\":[]}"}}
{"type":"step_finish","part":{"reason":"stop","tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":10,"write":0}}}}`
	v, e := parseReviewEvents(strings.NewReader(events), 1000)
	if e != nil || v.State != "succeeded" || v.Tokens != 135 {
		t.Fatal(v.State, e)
	}
	for _, bad := range []string{events + "garbage", `{"type":"tool_use"}`, `{"type":"error"}`, `{"type":"text","part":{"text":"No completion"}}`} {
		if _, e := parseReviewEvents(strings.NewReader(bad), 1000); e == nil {
			t.Fatal("accepted unsafe native events")
		}
	}
	v, e = parseReviewEvents(strings.NewReader(events), 100)
	if e != nil || v.State != "budget_exceeded" || v.Summary != "" {
		t.Fatal("budget boundary")
	}
	if _, e = reviewEnvelope(AgentJob{Auth: []byte(`{"apiKey":"qualification-not-a-real-key"}`), Model: "other/deepseek-v4-pro"}); e == nil {
		t.Fatal("wrong provider")
	}
}

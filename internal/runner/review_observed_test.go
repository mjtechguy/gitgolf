package runner

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

const observedReview = `{"type":"step_start","sessionID":"native-session","part":{"id":"start","messageID":"native-message"}}
{"type":"text","sessionID":"native-session","part":{"id":"native-part","messageID":"native-message","text":"{\"summary\":\"Clean\",\"findings\":[]}"}}
{"type":"step_finish","sessionID":"native-session","part":{"id":"finish","messageID":"native-message","reason":"stop","tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":10,"write":0}}}}
`

func TestReviewObservedIdentityAndPrivacy(t *testing.T) {
	observed := []AgentObservation{}
	out, err := parseObservedReviewEvents(t.Context(), strings.NewReader(observedReview), 1000, func(_ context.Context, v AgentObservation) error { observed = append(observed, v); return nil })
	if err != nil || out.State != "succeeded" || out.ConversationUnavailable || out.Tokens != 135 || len(observed) != 5 {
		t.Fatal("native review observation failed")
	}
	for i, v := range observed {
		if v.Sequence != int64(i+1) || v.ThreadID != "native-session" {
			t.Fatal("invented or unordered session")
		}
		if v.Kind != "thread_started" && v.TurnID != "native-message" {
			t.Fatal("invented turn")
		}
	}
	if observed[2].ItemID != "native-part" {
		t.Fatal("lost native message identity")
	}
	legacy := `{"type":"text","part":{"text":"safe summary"}}
{"type":"step_finish","part":{"reason":"stop","tokens":{"input":1,"output":1}}}`
	calls := 0
	out, err = parseObservedReviewEvents(t.Context(), strings.NewReader(legacy), 1000, func(context.Context, AgentObservation) error { calls++; return nil })
	if err != nil || out.State != "succeeded" || !out.ConversationUnavailable || calls != 0 {
		t.Fatal("missing IDs fabricated or broke native result")
	}
	for _, bad := range []string{strings.Replace(observedReview, `"native-message"`, `"foreign"`, 1), strings.Replace(observedReview, `"input":100`, `"input":-100`, 1), strings.Replace(observedReview, `"native-part"`, `"bad id"`, 1), observedReview + `{"type":"tool_use"}`} {
		if _, err = parseObservedReviewEvents(t.Context(), strings.NewReader(bad), 1000, func(context.Context, AgentObservation) error { return nil }); err == nil {
			t.Fatal("unsafe native projection accepted")
		}
	}
}
func TestReviewJournalAcknowledgementPrecedesProcessCompletion(t *testing.T) {
	ctx, stop := context.WithTimeout(t.Context(), 3*time.Second)
	defer stop()
	input, writer := io.Pipe()
	defer input.Close()
	defer writer.Close()
	lines := strings.Split(strings.TrimSpace(observedReview), "\n")
	encoded, _ := json.Marshal(lines)
	script := "import sys,json\nrows=json.loads(" + stringMustJSON(string(encoded)) + ")\nsys.stdin.readline()\nprint(rows[0],flush=True)\nprint(rows[1],flush=True)\nsys.stdin.readline()\nprint(rows[2],flush=True)\n"
	e := &Executor{config: Config{DockerBinary: "/usr/bin/python3"}}
	go func() { io.WriteString(writer, "captured request\n") }()
	ack := false
	out, err := e.reviewObservedCommand(ctx, input, AgentJob{TokenBudget: 1000, Observe: func(_ context.Context, v AgentObservation) error {
		if v.Kind == "assistant_message" {
			ack = true
			_, err := io.WriteString(writer, "durably acknowledged\n")
			writer.Close()
			return err
		}
		return nil
	}}, "-u", "-c", script)
	if err != nil || out.State != "succeeded" || !ack {
		t.Fatal("process completion was required before private acknowledgement")
	}
}
func stringMustJSON(value string) string { b, _ := json.Marshal(value); return string(b) }

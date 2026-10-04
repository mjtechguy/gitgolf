package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

const observationStart = `{"id":1,"result":{}}
{"id":2,"result":{"thread":{"id":"thread"}}}
{"id":3,"result":{"turn":{"id":"turn"}}}
`
const observationEnd = `{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed","error":{"message":"PRIVATE"}}}}
`

func observationItem(method, id, kind, status, text string) string {
	b, _ := json.Marshal(map[string]any{"method": method, "params": map[string]any{"threadId": "thread", "turnId": "turn", "item": map[string]any{"id": id, "type": kind, "status": status, "text": text, "command": "PRIVATE", "cwd": "/PRIVATE", "aggregatedOutput": "PRIVATE", "changes": []any{map[string]string{"path": "PRIVATE", "diff": "PRIVATE"}}}}})
	return string(b) + "\n"
}
func observedProtocol(t *testing.T, events string, callback func(context.Context, AgentObservation) error) (AgentResult, error, string) {
	t.Helper()
	var in bytes.Buffer
	r, e := agentProtocol(context.Background(), &in, strings.NewReader(events), AgentJob{Model: "model", TokenBudget: 1000, Instructions: "expanded PRIVATE instructions", Observe: callback})
	return r, e, in.String()
}
func TestAgentObservationBoundedNativeProjection(t *testing.T) {
	var got []AgentObservation
	stream := observationStart + observationItem("item/started", "cmd", "commandExecution", "inProgress", "") + `{"method":"item/commandExecution/outputDelta","params":{"threadId":"thread","turnId":"turn","delta":"PRIVATE"}}
{"method":"item/reasoning/textDelta","params":{"threadId":"thread","turnId":"turn","delta":"PRIVATE"}}
{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"reason","type":"reasoning","text":"PRIVATE","summary":["PRIVATE"],"content":["PRIVATE"]}}}
{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"a","delta":"PRIVATE"}}
{"id":55,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread","turnId":"turn","itemId":"cmd","command":"PRIVATE","reason":"PRIVATE"}}
` + observationItem("item/completed", "cmd", "commandExecution", "declined", "") + `{"method":"turn/plan/updated","params":{"threadId":"thread","turnId":"turn","explanation":"PRIVATE","plan":[{"step":"Inspect repository","status":"completed"}]}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"thread","tokenUsage":{"total":{"totalTokens":0}}}}
` + observationItem("item/started", "a", "agentMessage", "", "") + `{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"a","type":"agentMessage","phase":"commentary","text":"Checked source"}}}
` + observationItem("item/started", "b", "agentMessage", "", "") + `{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"b","type":"agentMessage","phase":"final_answer","text":"Proposed change"}}}
` + observationEnd
	r, e, in := observedProtocol(t, stream, func(_ context.Context, v AgentObservation) error { got = append(got, v); return nil })
	if e != nil || r.State != "succeeded" || r.Summary != "Proposed change" {
		t.Fatal("completion projection failed")
	}
	want := []string{"thread_started", "turn_started", "tool_started", "approval_declined", "tool_completed", "plan_updated", "usage_updated", "assistant_message", "assistant_message", "turn_completed"}
	if len(got) != len(want) {
		t.Fatalf("events %d, want %d", len(got), len(want))
	}
	for i, v := range got {
		if v.Sequence != int64(i+1) || v.Kind != want[i] {
			t.Fatal("sequence/kind")
		}
	}
	if got[6].TotalTokens == nil || *got[6].TotalTokens != 0 || got[7].Phase != "commentary" || got[8].Phase != "final_answer" {
		t.Fatal("presence or phase lost")
	}
	b, _ := json.Marshal(got)
	if strings.Contains(string(b), "PRIVATE") || !strings.Contains(in, `"decision":"decline"`) || strings.Contains(in, `"decision":"accept"`) {
		t.Fatal("private payload escaped or approval broadened")
	}
}
func TestAgentObservationRejectsUnboundMalformedLifecycle(t *testing.T) {
	start := observationItem("item/started", "tool", "commandExecution", "inProgress", "")
	done := observationItem("item/completed", "tool", "commandExecution", "completed", "")
	message := observationItem("item/started", "a", "agentMessage", "", "") + observationItem("item/completed", "a", "agentMessage", "", "answer")
	tests := map[string]string{
		"foreign thread":             strings.Replace(start, `"threadId":"thread"`, `"threadId":"foreign"`, 1),
		"foreign turn":               strings.Replace(start, `"turnId":"turn"`, `"turnId":"foreign"`, 1),
		"no start":                   done,
		"duplicate start":            start + start,
		"duplicate completion":       start + done + done,
		"changed item type":          start + observationItem("item/completed", "tool", "fileChange", "completed", ""),
		"unfinished successful turn": start,
		"unknown status":             start + observationItem("item/completed", "tool", "commandExecution", "accepted", ""),
		"invalid identity":           observationItem("item/started", "bad id", "commandExecution", "inProgress", ""),
		"invalid text":               strings.Replace(message, `"text":"answer"`, `"text":"a\u0000b"`, 1),
		"invalid phase":              strings.Replace(message, `"text":"answer"`, `"phase":"reasoning","text":"answer"`, 1),
		"duplicate message":          message + observationItem("item/completed", "a", "agentMessage", "", "answer"),
		"foreign approval":           start + `{"id":4,"method":"item/commandExecution/requestApproval","params":{"threadId":"other","turnId":"turn","itemId":"tool"}}` + "\n",
		"unstarted approval":         `{"id":4,"method":"item/fileChange/requestApproval","params":{"threadId":"thread","turnId":"turn","itemId":"tool"}}` + "\n",
		"unknown approval":           `{"id":4,"method":"item/permissions/requestApproval","params":{}}` + "\n",
		"unknown turn status":        "",
	}
	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			end := observationEnd
			if name == "unknown turn status" {
				end = strings.Replace(end, `"status":"completed"`, `"status":"accepted"`, 1)
			}
			r, e, _ := observedProtocol(t, observationStart+body+end, func(context.Context, AgentObservation) error { return nil })
			if e == nil || r.State == "succeeded" {
				t.Fatal("invalid observation accepted")
			}
		})
	}
}
func TestAgentObservationUsagePresenceAndBounds(t *testing.T) {
	for name, usage := range map[string]string{"negative": "-1", "overflow": "9223372036854775808", "null": "null", "text": "\"1\""} {
		t.Run(name, func(t *testing.T) {
			stream := observationStart + `{"method":"thread/tokenUsage/updated","params":{"threadId":"thread","tokenUsage":{"total":{"totalTokens":` + usage + `}}}}` + "\n" + observationEnd
			_, e, _ := observedProtocol(t, stream, func(context.Context, AgentObservation) error { return nil })
			if e == nil {
				t.Fatal("invalid usage accepted")
			}
		})
	}
	var got []AgentObservation
	r, e, _ := observedProtocol(t, observationStart+observationEnd, func(_ context.Context, v AgentObservation) error { got = append(got, v); return nil })
	if e != nil || r.Tokens != 0 {
		t.Fatal("unknown usage failed")
	}
	for _, v := range got {
		if v.TotalTokens != nil || v.Kind == "usage_updated" {
			t.Fatal("unknown fabricated as reported zero")
		}
	}
}
func TestAgentObservationCallbackRefusalStopsProtocol(t *testing.T) {
	var got []AgentObservation
	r, e, in := observedProtocol(t, observationStart+observationEnd, func(_ context.Context, v AgentObservation) error {
		got = append(got, v)
		return errors.New("PRIVATE consumer error")
	})
	if !errors.Is(e, ErrInfrastructure) || r.State == "succeeded" || len(got) != 1 || strings.Contains(in, "turn/start") || strings.Contains(e.Error(), "PRIVATE") {
		t.Fatal("refusal did not stop before native turn")
	}
	calls := 0
	r, e, _ = observedProtocol(t, observationStart+observationItem("item/started", "a", "agentMessage", "", "")+observationItem("item/completed", "a", "agentMessage", "", "answer")+observationEnd, func(_ context.Context, v AgentObservation) error {
		calls++
		if v.Kind == "assistant_message" {
			return errors.New("refused")
		}
		return nil
	})
	if e == nil || r.Summary != "" || calls != 3 || r.State == "succeeded" {
		t.Fatal("unacknowledged content became result")
	}
}
func TestAgentObservationProjectionCaps(t *testing.T) {
	usage := `{"method":"thread/tokenUsage/updated","params":{"threadId":"thread","tokenUsage":{"total":{"totalTokens":0}}}}` + "\n"
	for name, body := range map[string]string{
		"event count":        strings.Repeat(usage, 511),
		"message bytes":      observationItem("item/started", "a", "agentMessage", "", "") + observationItem("item/completed", "a", "agentMessage", "", strings.Repeat("a", 65537)),
		"aggregate escaped":  observationItem("item/started", "a", "agentMessage", "", "") + observationItem("item/completed", "a", "agentMessage", "", strings.Repeat("<", 65536)),
		"plan count":         `{"method":"turn/plan/updated","params":{"threadId":"thread","turnId":"turn","plan":[` + strings.TrimSuffix(strings.Repeat(`{"step":"work","status":"pending"},`, 33), ",") + `]}}` + "\n",
		"plan step":          `{"method":"turn/plan/updated","params":{"threadId":"thread","turnId":"turn","plan":[{"step":"` + strings.Repeat("a", 513) + `","status":"pending"}]}}` + "\n",
		"plan unknown state": `{"method":"turn/plan/updated","params":{"threadId":"thread","turnId":"turn","plan":[{"step":"work","status":"failed"}]}}` + "\n",
	} {
		t.Run(name, func(t *testing.T) {
			_, e, _ := observedProtocol(t, observationStart+body+observationEnd, func(context.Context, AgentObservation) error { return nil })
			if e == nil {
				t.Fatal("cap bypassed")
			}
		})
	}
}

func TestAgentObservationFinalSummaryAndBudget(t *testing.T) {
	stream := observationStart + observationItem("item/started", "final", "agentMessage", "", "") + strings.Replace(observationItem("item/completed", "final", "agentMessage", "", "final reply"), `"text":"final reply"`, `"phase":"final_answer","text":"final reply"`, 1) + observationItem("item/started", "comment", "agentMessage", "", "") + strings.Replace(observationItem("item/completed", "comment", "agentMessage", "", "late note"), `"text":"late note"`, `"phase":"commentary","text":"late note"`, 1) + observationEnd
	r, e, _ := observedProtocol(t, stream, func(context.Context, AgentObservation) error { return nil })
	if e != nil || r.Summary != "final reply" {
		t.Fatal("commentary replaced final reply")
	}
	var got []AgentObservation
	r, e, in := observedProtocol(t, observationStart+`{"method":"thread/tokenUsage/updated","params":{"threadId":"thread","turnId":"turn","tokenUsage":{"total":{"totalTokens":1001}}}}`+"\n"+observationEnd, func(_ context.Context, v AgentObservation) error { got = append(got, v); return nil })
	if e != nil || r.State != "budget_exceeded" || !strings.Contains(in, "turn/interrupt") || len(got) != 3 || got[2].Kind != "usage_updated" {
		t.Fatal("budget observation or interruption lost")
	}
	r, e, _ = observedProtocol(t, observationStart+`{"method":"thread/tokenUsage/updated","params":{"threadId":"thread","turnId":"foreign","tokenUsage":{"total":{"totalTokens":0}}}}`+"\n"+observationEnd, func(context.Context, AgentObservation) error { return nil })
	if e == nil || r.State == "succeeded" {
		t.Fatal("foreign usage turn accepted")
	}
}
func TestAgentObservationCancellationAndTerminalRefusal(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var in bytes.Buffer
	calls := 0
	r, e := agentProtocol(ctx, &in, strings.NewReader(observationStart+observationEnd), AgentJob{Observe: func(context.Context, AgentObservation) error { calls++; cancel(); return nil }})
	if e == nil || calls != 1 || r.State == "succeeded" || strings.Contains(in.String(), "turn/start") {
		t.Fatal("cancelled acknowledgement advanced native execution")
	}
	r, e, _ = observedProtocol(t, observationStart+observationEnd, func(_ context.Context, v AgentObservation) error {
		if v.Kind == "turn_completed" {
			return errors.New("journal unavailable")
		}
		return nil
	})
	if e == nil || r.State == "succeeded" {
		t.Fatal("unacknowledged completion became success")
	}
}
func TestAgentObservationProtocolOrderAndMissingUsage(t *testing.T) {
	for name, stream := range map[string]string{
		"thread before initialize": strings.TrimPrefix(observationStart, "{\"id\":1,\"result\":{}}\n") + observationEnd,
		"duplicate initialize":     strings.Replace(observationStart, "{\"id\":1,\"result\":{}}\n", strings.Repeat("{\"id\":1,\"result\":{}}\n", 2), 1) + observationEnd,
		"duplicate thread":         strings.Replace(observationStart, "{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread\"}}}\n", strings.Repeat("{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread\"}}}\n", 2), 1) + observationEnd,
		"missing usage":            observationStart + `{"method":"thread/tokenUsage/updated","params":{"threadId":"thread","tokenUsage":{"total":{}}}}` + "\n" + observationEnd,
		"malformed json":           observationStart + "{\n" + observationEnd,
	} {
		t.Run(name, func(t *testing.T) {
			r, e, _ := observedProtocol(t, stream, func(context.Context, AgentObservation) error { return nil })
			if e == nil || r.State == "succeeded" {
				t.Fatal("invalid order or malformed observation accepted")
			}
		})
	}
}

func TestAgentObservationCannotChangeBudgetEvidence(t *testing.T) {
	r, e, in := observedProtocol(t, observationStart+`{"method":"thread/tokenUsage/updated","params":{"threadId":"thread","tokenUsage":{"total":{"totalTokens":1001}}}}`+"\n"+observationEnd, func(_ context.Context, v AgentObservation) error {
		if v.TotalTokens != nil {
			*v.TotalTokens = 0
		}
		return nil
	})
	if e != nil || r.Tokens != 1001 || r.State != "budget_exceeded" || !strings.Contains(in, "turn/interrupt") {
		t.Fatal("consumer changed native budget evidence")
	}
}

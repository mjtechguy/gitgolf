package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/internal/runner"
)

type ackTransport func(*http.Request) (*http.Response, error)

func (f ackTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestActionFrameAckDiagnosticAndCoordinates(t *testing.T) {
	for _, tc := range []struct {
		kind, step, scope string
		status            int
	}{{"log", "", "job", 503}, {"log", "ordinary", "step", 409}, {"job_started", "", "job", 403}, {"complete", "", "run", 400}} {
		t.Run(tc.kind+tc.scope, func(t *testing.T) {
			job := strings.Repeat("a", 32)
			if tc.scope == "run" {
				job = ""
			}
			var payload []byte
			c := &coordinator{origin: "https://coordinator.invalid", client: &http.Client{Transport: ackTransport(func(r *http.Request) (*http.Response, error) {
				payload, _ = io.ReadAll(r.Body)
				return &http.Response{StatusCode: tc.status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("private error source credential"))}, nil
			})}}
			a := assignment{AttemptID: strings.Repeat("b", 32)}
			forward := &logForwarder{c: c, a: a}
			err := c.acknowledgeActionFrame(t.Context(), a, forward, runner.ActionFrame{Kind: tc.kind, InstanceID: job, StepID: tc.step, Text: "private raw source credential", EventSequence: 1})
			if !errors.Is(err, errTransport) {
				t.Fatal("Transport error policy lost")
			}
			if tc.kind == "log" && tc.step == "" && (bytes.Contains(payload, []byte(`"stepId"`)) || !bytes.Contains(payload, []byte(job))) {
				t.Fatal("Job coordinate invented or exact job lost")
			}
			var out bytes.Buffer
			reportActionsFailure(&out, err)
			expected := "Golf Actions lifecycle failure: stage=coordinator_preparation\nGolf Actions acknowledgement failure: kind=" + tc.kind + "; scope=" + tc.scope + "; http_status=" + strconv.Itoa(tc.status) + "\n"
			if out.String() != expected {
				t.Fatal("Diagnostic must contain only fixed classifications")
			}
			if forward.sequence != 0 {
				t.Fatal("Failed acknowledgement advanced log sequence")
			}
		})
	}
}
func TestActionFrameAckDiagnosticRejectsUntrustedFields(t *testing.T) {
	for _, cause := range []error{errors.New("private failure source credential"), &coordinatorPostError{status: 1000}} {
		var out bytes.Buffer
		reportActionsFailure(&out, &actionFrameAckError{kind: "source-secret", scope: "source-path", cause: cause})
		if out.String() != "Golf Actions lifecycle failure: stage=coordinator_preparation\nGolf Actions acknowledgement failure: kind=unknown; scope=unknown; http_status=unknown\n" {
			t.Fatal("Untrusted acknowledgement metadata exposed")
		}
	}
}

func TestActionFrameAckAcceptedJobLog(t *testing.T) {
	c := &coordinator{origin: "https://coordinator.invalid", client: &http.Client{Transport: ackTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 204, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}}
	a := assignment{AttemptID: strings.Repeat("b", 32)}
	forward := &logForwarder{c: c, a: a}
	if e := c.acknowledgeActionFrame(t.Context(), a, forward, runner.ActionFrame{Kind: "log", InstanceID: strings.Repeat("a", 32), Text: "job output"}); e != nil {
		t.Fatal("Accepted job frame refused")
	}
	if forward.sequence != 1 || forward.stepID != "" {
		t.Fatal("Accepted job frame coordinate or sequence changed")
	}
}

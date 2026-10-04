package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/workflowinputs"
)

func TestCoordinatorOrigin(t *testing.T) {
	for _, value := range []string{"https://golf.example", "http://127.0.0.1:8080/", "http://localhost:8080", "http://[::1]:8080"} {
		if _, err := coordinatorURL(value); err != nil {
			t.Errorf("valid origin rejected %s", value)
		}
	}
	for _, value := range []string{"http://golf.example", "https://user:pass@golf.example", "https://golf.example/path", "https://golf.example?secret=x", "https://golf.example#x", "file:///tmp/socket", "//golf.example", "https://golf.example/%2f"} {
		if _, err := coordinatorURL(value); err == nil {
			t.Errorf("invalid origin accepted %s", value)
		}
	}
}
func TestPrivateBoundSourceAndCredentialHeaders(t *testing.T) {
	data := []byte("synthetic bounded source bytes")
	digest := sha256.Sum256(data)
	a := assignment{AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("b", 43), SourceSHA256: hex.EncodeToString(digest[:])}
	corrupt := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("k", 43) || r.Header.Get("Golf-Runner-ID") != "worker" || r.Header.Get("Golf-Attempt-Token") != a.AttemptToken || r.Header.Get("Cookie") != "" {
			t.Error("control-plane headers incorrect")
		}
		if corrupt {
			_, _ = w.Write([]byte("wrong"))
		} else {
			_, _ = w.Write(data)
		}
	}))
	defer server.Close()
	c := coordinator{origin: server.URL, id: "worker", key: strings.Repeat("k", 43), client: server.Client()}
	file, err := c.source(context.Background(), a, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(file)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("source file must be private")
	}
	got, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("source differs")
	}
	corrupt = true
	if _, err = c.source(context.Background(), a, t.TempDir()); err == nil {
		t.Fatal("wrong source hash accepted")
	}
}
func TestLogNormalizationSequenceAndJSONBounds(t *testing.T) {
	var combined strings.Builder
	sequence := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || len(body) > 32<<10 {
			t.Error("log JSON too large")
		}
		var value struct {
			Sequence int
			Text     string
		}
		if json.Unmarshal(body, &value) != nil || !utf8.ValidString(value.Text) || strings.ContainsRune(value.Text, 0) || len(value.Text) > 16<<10 || value.Sequence != sequence+1 {
			t.Error("log encoding/sequence invalid")
		}
		sequence = value.Sequence
		combined.WriteString(value.Text)
		w.WriteHeader(204)
	}))
	defer server.Close()
	c := coordinator{origin: server.URL, id: "worker", key: strings.Repeat("k", 43), client: server.Client()}
	a := assignment{AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("b", 43)}
	l := logForwarder{c: &c, a: a}
	ctx := context.Background()
	for _, data := range [][]byte{{0xf0, 0x9f}, {0x8c, 0x8d, ' ', 0xff, 0}, []byte(strings.Repeat("<\t>", 6000)), {0xe2, 0x82}} {
		if err := l.write(ctx, runner.LogChunk{Stream: "stdout", Data: data}, false); err != nil {
			t.Fatal(err)
		}
	}
	if err := l.write(ctx, runner.LogChunk{Stream: "stdout"}, true); err != nil {
		t.Fatal(err)
	}
	expected := "🌍 ��" + strings.Repeat("<\t>", 6000) + "�"
	if combined.String() != expected {
		t.Fatalf("normalization changed complete runes: length %d wanted %d", combined.Len(), len(expected))
	}
	if sequence < 2 {
		t.Fatal("expected bounded chunks")
	}
}
func TestPollValidationAndDenial(t *testing.T) {
	state := "valid"
	a := assignment{RunID: "17", AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("b", 43), JobID: "check", ImageDigest: "alpine@sha256:" + strings.Repeat("c", 64), CommitID: strings.Repeat("d", 40), SourceSHA256: strings.Repeat("e", 64), TimeoutSeconds: 900, LeaseSeconds: 45, JobResources: testResourceBinding()}
	a.Steps = append(a.Steps, struct {
		Name  string
		Run   string
		Shell string
	}{Name: "step", Run: "true", Shell: "sh"})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if state == "denied" {
			w.WriteHeader(403)
			return
		}
		if state == "empty" {
			w.WriteHeader(204)
			return
		}
		if state == "bad" {
			fmt.Fprint(w, `{"attemptId":"../bad"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(a)
	}))
	defer server.Close()
	c := coordinator{origin: server.URL, id: "worker", key: strings.Repeat("k", 43), client: server.Client()}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if result, err := c.poll(ctx); err != nil || result.AttemptID != a.AttemptID {
		t.Fatal("valid poll rejected")
	}
	state = "bad"
	if _, err := c.poll(ctx); err == nil {
		t.Fatal("malformed assignment accepted")
	}
	state = "empty"
	if result, err := c.poll(ctx); err != nil || result != nil {
		t.Fatal("empty poll differs")
	}
	state = "denied"
	if _, err := c.poll(ctx); err != errUnauthorized {
		t.Fatal("enrollment denial ignored")
	}
}

func TestActionsAssignmentRequiresExplicitQualifiedConsumer(t *testing.T) {
	var c coordinator
	a := assignment{TimeoutSeconds: 900, JobResources: testResourceBinding(), EngineCatalog: runner.ActionsCatalog, SourceSHA256: strings.Repeat("a", 64), EventJSON: []byte(`{"ref":"refs/heads/main"}`), ActionsPlan: &runner.ActionPlan{Catalog: runner.ActionsCatalog, ArchiveSHA256: strings.Repeat("a", 64), Jobs: []runner.ActionJob{{InstanceID: strings.Repeat("b", 32)}}}}
	if c.validAssignment(a) {
		t.Fatal("old worker admitted engine graph")
	}
	c.actions = &runner.ActionsExecutor{}
	if !c.validAssignment(a) {
		t.Fatal("explicit graph consumer rejected bound assignment")
	}
	changed := a
	changed.EngineCatalog = "future-unknown"
	if c.validAssignment(changed) {
		t.Fatal("unknown engine accepted")
	}
	changed = a
	changed.SourceSHA256 = strings.Repeat("c", 64)
	if c.validAssignment(changed) {
		t.Fatal("source digest drift accepted")
	}
	changed = a
	changed.Steps = []struct{ Name, Run, Shell string }{{Run: "true"}}
	if c.validAssignment(changed) {
		t.Fatal("mixed shell/graph assignment accepted")
	}
}

func TestActionsOperatorDiagnosticCannotExposeErrorOrExecutionData(t *testing.T) {
	var output bytes.Buffer
	reportActionsFailure(&output, errors.New("private command source and credential"))
	if output.String() != "Golf Actions lifecycle failure: stage=coordinator_preparation\n" {
		t.Fatal("untrusted diagnostic escaped")
	}
	output.Reset()
	reportActionsFailure(&output, nil)
	if output.Len() != 0 {
		t.Fatal("successful execution emitted failure")
	}
	e, err := runner.New(runner.Config{WorkerID: "owned", ApprovedImages: []string{"alpine@sha256:" + strings.Repeat("a", 64)}})
	if err != nil {
		t.Fatal(err)
	}
	helper, err := runner.NewActions(e, os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	_, err = helper.Execute(t.Context(), "invalid", runner.ActionExecutionInput{}, func(context.Context, runner.ActionFrame) error { return nil })
	reportActionsFailure(&output, err)
	if output.String() != "Golf Actions lifecycle failure: stage=input_validation\n" || !errors.Is(err, runner.ErrInvalidJob) {
		t.Fatal("fixed classification or policy lost")
	}
}

func testResourceBinding() *runner.JobResourceBinding {
	return &runner.JobResourceBinding{Profile: runner.JobLimitsProfile, Limits: runner.DefaultJobLimits(), InstanceVersion: "0", PlacementVersion: "0", Bound: true}
}
func TestResourceConsumerCapabilityAndNoLegacyAdoption(t *testing.T) {
	c := coordinator{origin: "http://localhost"}
	raw, _ := json.Marshal(c.pollCapabilities())
	var caps struct{ Capabilities []string }
	if json.Unmarshal(raw, &caps) != nil || len(caps.Capabilities) != 1 || caps.Capabilities[0] != runner.JobLimitsCapability {
		t.Fatal("shell consumer missing resource declaration")
	}
	a := assignment{TimeoutSeconds: 900, JobResources: testResourceBinding()}
	a.Steps = []struct{ Name, Run, Shell string }{{Run: "true", Shell: "sh"}}
	if !c.validAssignment(a) {
		t.Fatal("bound shell refused")
	}
	a.JobResources = nil
	if c.validAssignment(a) {
		t.Fatal("missing snapshot adopted")
	}
	a.JobResources = testResourceBinding()
	a.TimeoutSeconds = 899
	if c.validAssignment(a) {
		t.Fatal("timeout does not echo snapshot")
	}
}

func typedManualAssignment(t *testing.T) assignment {
	t.Helper()
	schema, err := workflowinputs.Parse([]byte("on:\n  workflow_dispatch:\n    inputs:\n      message: {type: string, required: true}\n      count: {type: number, default: 0}\n"))
	if err != nil {
		t.Fatal("schema fixture")
	}
	values, err := workflowinputs.Validate(schema, []workflowinputs.Value{{Name: "message", Type: workflowinputs.String, String: "private <>& 世界"}})
	if err != nil {
		t.Fatal("typed fixture")
	}
	commit := strings.Repeat("a", 40)
	event, _ := json.Marshal(map[string]any{"ref": commit, "after": commit, "inputs": map[string]string{"message": "private <>& 世界", "count": "0"}})
	return assignment{RunID: "owned", AttemptID: strings.Repeat("b", 32), AttemptToken: strings.Repeat("c", 64), CommitID: commit, SourceSHA256: strings.Repeat("d", 64), EngineCatalog: runner.ActionsInputsCatalog, TimeoutSeconds: 900, LeaseSeconds: 90, JobResources: testResourceBinding(), EventJSON: event, ActionsPlan: &runner.ActionPlan{Catalog: runner.ActionsInputsCatalog, EngineCommit: runner.ActionsEngineCommit, Event: "workflow_dispatch", Ref: commit, ArchiveSHA256: strings.Repeat("d", 64), ManualInputsContract: runner.ManualInputsCapability, ManualInputsSchemaSHA256: schema.SHA256, WorkflowPath: ".github/workflows/main.yml", WorkflowBlobID: strings.Repeat("e", 40), Jobs: []runner.ActionJob{{InstanceID: strings.Repeat("f", 32)}}}, ManualInputs: &runner.ActionManualInputs{Contract: runner.ManualInputsCapability, SchemaSHA256: schema.SHA256, SubmittedSHA256: values.SubmittedSHA256, EffectiveSHA256: values.EffectiveSHA256, Submitted: values.Submitted, Effective: values.Effective}}
}

func hasManualCapabilities(t *testing.T, c *coordinator) bool {
	t.Helper()
	body, _ := json.Marshal(c.pollCapabilities())
	var result struct{ Catalogs, Capabilities []string }
	if json.Unmarshal(body, &result) != nil {
		t.Fatal("capabilities fixture")
	}
	return slices.Contains(result.Catalogs, runner.ActionsInputsCatalog) && slices.Contains(result.Capabilities, runner.ManualInputsCapability)
}

func TestManualAssignmentRequiresActualCurrentVerifiedTLS(t *testing.T) {
	a := typedManualAssignment(t)
	sendAssignment := false
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !sendAssignment {
			w.WriteHeader(204)
			return
		}
		json.NewEncoder(w).Encode(a)
	}))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	server.StartTLS()
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "ca.crt")
	if os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600) != nil {
		t.Fatal("CA fixture")
	}
	config, err := runnerTLSConfig(server.URL, ca)
	if err != nil {
		t.Fatal("CA configuration")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = config
	defer transport.CloseIdleConnections()
	c := coordinator{origin: server.URL, id: "owned", key: strings.Repeat("z", 64), client: &http.Client{Transport: transport}, actions: &runner.ActionsExecutor{}}
	if hasManualCapabilities(t, &c) || c.validAssignment(a) {
		t.Fatal("configuration alone claimed verified TLS")
	}
	if got, err := c.poll(t.Context()); err != nil || got != nil {
		t.Fatal("first legacy poll failed")
	}
	if !hasManualCapabilities(t, &c) || !c.validAssignment(a) {
		t.Fatal("actual verified TLS failed to authorize typed consumer")
	}
	sendAssignment = true
	if got, err := c.poll(t.Context()); err != nil || got == nil || got.ManualInputs.EffectiveSHA256 != a.ManualInputs.EffectiveSHA256 {
		t.Fatal("verified typed assignment rejected")
	}
	// A response from a now-unverified transport must not inherit the previous
	// positive observation or consume private input assignments.
	transport.CloseIdleConnections()
	transport.TLSClientConfig = transport.TLSClientConfig.Clone()
	transport.TLSClientConfig.InsecureSkipVerify = true
	if hasManualCapabilities(t, &c) {
		t.Fatal("changed insecure transport advertised typed consumer")
	}
	if got, err := c.poll(t.Context()); got != nil || !errors.Is(err, errTransport) || c.verifiedTLS.Load() {
		t.Fatal("prior verified response survived current insecure response")
	}
	// Transport verification also refuses a trusted certificate for another name.
	transport.CloseIdleConnections()
	transport.TLSClientConfig = config
	c.origin = strings.Replace(server.URL, "127.0.0.1", "localhost", 1)
	if got, err := c.poll(t.Context()); got != nil || !errors.Is(err, errTransport) || c.verifiedTLS.Load() {
		t.Fatal("wrong hostname accepted")
	}
	transport.CloseIdleConnections()
	transport.TLSClientConfig, err = runnerTLSConfig(server.URL, "")
	if err != nil {
		t.Fatal("untrusted TLS fixture")
	}
	c.origin = server.URL
	if got, err := c.poll(t.Context()); got != nil || !errors.Is(err, errTransport) || hasManualCapabilities(t, &c) {
		t.Fatal("missing CA accepted typed assignment")
	}
	transport.CloseIdleConnections()
	transport.TLSClientConfig = config
	// An arbitrary response TLS field is not enough: current transport config,
	// chain validation, exact hostname and TLS1.3 all remain required.
	c.origin = server.URL
	fake := &http.Response{TLS: &tls.ConnectionState{Version: tls.VersionTLS12, PeerCertificates: []*x509.Certificate{server.Certificate()}, VerifiedChains: [][]*x509.Certificate{{server.Certificate()}}}}
	if c.verifiedResponseTLS(fake) {
		t.Fatal("TLS1.2 claimed typed capability")
	}
	fake.TLS.Version = tls.VersionTLS13
	fake.TLS.VerifiedChains = nil
	if c.verifiedResponseTLS(fake) {
		t.Fatal("unverified peer claimed typed capability")
	}
	c.origin = "http://127.0.0.1:8080"
	c.verifiedTLS.Store(true)
	if hasManualCapabilities(t, &c) || c.validAssignment(a) {
		t.Fatal("HTTP inherited prior TLS observation")
	}
}

func TestManualTLSNoCAAndOldProtocolNeverAdvertiseInputs(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, MaxVersion: tls.VersionTLS12}
	server.StartTLS()
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "ca.crt")
	if os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600) != nil {
		t.Fatal("CA fixture")
	}
	for _, caFile := range []string{"", ca} {
		config, err := runnerTLSConfig(server.URL, caFile)
		if err != nil {
			t.Fatal("TLS fixture")
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		transport.TLSClientConfig = config
		c := coordinator{origin: server.URL, id: "owned", key: strings.Repeat("z", 64), client: &http.Client{Transport: transport}, actions: &runner.ActionsExecutor{}}
		if got, err := c.poll(t.Context()); got != nil || !errors.Is(err, errTransport) || hasManualCapabilities(t, &c) {
			transport.CloseIdleConnections()
			t.Fatal("unqualified TLS advertised private input consumer")
		}
		transport.CloseIdleConnections()
	}
}

func TestManualAssignmentCatalogSeparation(t *testing.T) {
	a := typedManualAssignment(t)
	c := coordinator{origin: "https://golf.invalid", client: &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13}}}, actions: &runner.ActionsExecutor{}}
	c.verifiedTLS.Store(true)
	if !c.validAssignment(a) {
		t.Fatal("bound fixture refused")
	}
	for _, change := range []func(*assignment){
		func(v *assignment) { v.ManualInputs = nil }, func(v *assignment) { v.EngineCatalog = runner.ActionsCatalog }, func(v *assignment) { v.ActionsPlan.ManualInputsContract = "other" }, func(v *assignment) { v.ManualInputs.EffectiveSHA256 = strings.Repeat("f", 64) },
	} {
		body, _ := json.Marshal(a)
		var v assignment
		json.Unmarshal(body, &v)
		change(&v)
		if c.validAssignment(v) {
			t.Fatal("mismatched input/catalog accepted")
		}
	}
	shell := assignment{JobResources: testResourceBinding(), TimeoutSeconds: 900, ManualInputs: a.ManualInputs}
	shell.Steps = []struct{ Name, Run, Shell string }{{Run: "true"}}
	if c.validAssignment(shell) {
		t.Fatal("shell adopted typed envelope")
	}
}

func TestManualEngineRequestKeepsOriginalEnvelopeAndSelectedCatalog(t *testing.T) {
	a := typedManualAssignment(t)
	images := map[string]string{"linux": "alpine@sha256:" + strings.Repeat("b", 64)}
	archive := []byte("owned immutable archive")
	input := actionsExecutionInput(a, archive, images)
	if input.Input.Catalog != a.EngineCatalog || input.Plan.Catalog != a.EngineCatalog || input.Input.ManualInputsContract != a.ManualInputs.Contract || input.Input.ManualInputsSchemaSHA256 != a.ManualInputs.SchemaSHA256 || input.ManualInputs != a.ManualInputs || input.CommitID != a.CommitID || !bytes.Equal(input.EventJSON, a.EventJSON) || !bytes.Equal(input.Input.Archive, archive) || input.JobResources != a.JobResources {
		t.Fatal("worker substituted input/catalog/source binding")
	}
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal("engine serialization failed")
	}
	var recovered runner.ActionExecutionInput
	if json.Unmarshal(body, &recovered) != nil || runner.ValidateActionManualInputs(recovered.Plan, recovered.ManualInputs, recovered.EventJSON, recovered.CommitID) != nil {
		t.Fatal("engine transfer lost canonical typed input envelope")
	}
}

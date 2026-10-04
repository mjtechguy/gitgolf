package runner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/internal/workflowinputs"
)

func TestActualActionsDaemonIsolationBeforeSource(t *testing.T) {
	id := strings.Repeat("a", 64)
	image := "sha256:" + strings.Repeat("b", 64)
	attempt := strings.Repeat("c", 32)
	owner := strings.Repeat("d", 32)
	volume := "golf-source-" + attempt + "-" + owner
	valid := func() actionsDaemonInspect {
		var r actionsDaemonInspect
		r.ID = id
		r.Image = image
		r.Config.Labels = map[string]string{managedLabel: "true", workerLabel: "worker", attemptLabel: attempt, ownerLabel: owner}
		r.Config.Env = []string{"PATH=/usr/bin", "DOCKER_TLS_CERTDIR="}
		r.Config.Entrypoint = []string{"dockerd-entrypoint.sh"}
		r.Config.Cmd = []string{"dockerd", "--host=unix:///var/run/docker.sock", "--iptables=false", "--ip-masq=false", "--bridge=none"}
		r.HostConfig.NetworkMode = "none"
		r.HostConfig.Privileged = true
		r.HostConfig.Memory = 1 << 30
		r.HostConfig.MemorySwap = 1 << 30
		r.HostConfig.NanoCpus = 2000000000
		pids := int64(512)
		r.HostConfig.PidsLimit = &pids
		r.HostConfig.Tmpfs = map[string]string{"/golf": "rw,size=134217728,mode=0755"}
		r.Mounts = append(r.Mounts, struct{ Type, Name, Destination string }{"volume", volume, "/var/lib/docker"})
		return r
	}
	if !validActionsDaemon(valid(), id, image, volume, "worker", attempt, owner) {
		t.Fatal("exact disposable daemon refused")
	}
	for name, change := range map[string]func(*actionsDaemonInspect){
		"wrongowner":      func(r *actionsDaemonInspect) { r.Config.Labels[ownerLabel] = "other" },
		"hostnetwork":     func(r *actionsDaemonInspect) { r.HostConfig.NetworkMode = "host" },
		"unboundedmemory": func(r *actionsDaemonInspect) { r.HostConfig.Memory = 0 },
		"publishedsocket": func(r *actionsDaemonInspect) {
			r.HostConfig.PortBindings = map[string]json.RawMessage{"2375/tcp": json.RawMessage(`[]`)}
		},
		"tcpdaemon":        func(r *actionsDaemonInspect) { r.Config.Cmd = append(r.Config.Cmd, "--host=tcp://0.0.0.0:2375") },
		"foreignmount":     func(r *actionsDaemonInspect) { r.Mounts[0].Name = "retained" },
		"hostbind":         func(r *actionsDaemonInspect) { r.HostConfig.Binds = []string{"/:/host"} },
		"runnercredential": func(r *actionsDaemonInspect) { r.Config.Env = append(r.Config.Env, "GOLF_RUNNER_KEY=private") },
		"externalendpoint": func(r *actionsDaemonInspect) { r.Config.Env = append(r.Config.Env, "DOCKER_HOST=tcp://other") },
	} {
		t.Run(name, func(t *testing.T) {
			r := valid()
			change(&r)
			if validActionsDaemon(r, id, image, volume, "worker", attempt, owner) {
				t.Fatal("unsafe actual daemon admitted before source")
			}
		})
	}
}

func TestApprovedRegistryDigestSurvivesTagRemovalWithoutLosingIdentity(t *testing.T) {
	expected := "alpine:3.23@sha256:" + strings.Repeat("a", 64)
	if !RegistryDigestMatches(expected, "alpine@sha256:"+strings.Repeat("a", 64)) {
		t.Fatal("tag-free Docker receipt refused")
	}
	if RegistryDigestMatches(expected, "alpine@sha256:"+strings.Repeat("b", 64)) || RegistryDigestMatches(expected, "alpine:latest") {
		t.Fatal("tag/different content accepted")
	}
}

func TestRestartRefusesResidualEngineResourcesWithoutDeletingThem(t *testing.T) {
	for _, residual := range []string{"", "container", "volume"} {
		t.Run(residual, func(t *testing.T) {
			directory := t.TempDir()
			binary := filepath.Join(directory, "docker-fixture")
			trace := filepath.Join(directory, "trace")
			script := "#!/bin/sh\nprintf '%s\n' \"$*\" >> '" + trace + "'\ncase \"$1\" in " + residual + ") printf 'residual-resource\n';; esac\n"
			if residual == "" {
				script = "#!/bin/sh\nprintf '%s\n' \"$*\" >> '" + trace + "'\n"
			}
			if os.WriteFile(binary, []byte(script), 0700) != nil {
				t.Fatal("fixture")
			}
			e, err := New(Config{WorkerID: "owned", DockerBinary: binary, ApprovedImages: []string{"alpine@sha256:" + strings.Repeat("a", 64)}})
			if err != nil {
				t.Fatal(err)
			}
			err = e.RequireCleanWorker(context.Background())
			if (residual == "" && err != nil) || (residual != "" && !errors.Is(err, ErrCleanup)) {
				t.Fatal("restart safety", err)
			}
			commands, err := os.ReadFile(trace)
			if err != nil || strings.Contains(string(commands), "rm") || strings.Contains(string(commands), "create") || !strings.Contains(string(commands), "label=io.golf.runner.worker=owned") {
				t.Fatal("restart mutated or guessed resource authority")
			}
		})
	}
}

func TestActionsLifecycleDiagnosticRetainsPolicyAndNeverFormatsPrivateCause(t *testing.T) {
	private := errors.New("private native response containing a command and credential")
	for _, phase := range []string{"daemon_receipt_validation", "durable_frame_ack", "container_cleanup", "volume_cleanup"} {
		err := &actionsStageError{phase, errors.Join(ErrInfrastructure, private)}
		if !errors.Is(err, ErrInfrastructure) || !errors.Is(err, private) || ActionsFailureStage(err) != phase || strings.Contains(err.Error(), private.Error()) {
			t.Fatal("classification changed failure policy or exposed cause")
		}
	}
	forged := &actionsStageError{"private command and credential", ErrCleanup}
	if ActionsFailureStage(forged) != "unknown" || strings.Contains(forged.Error(), "credential") || !errors.Is(forged, ErrCleanup) {
		t.Fatal("nonallowlisted diagnostic escaped")
	}
}

func TestActionsActualPreparationFailureHasOnlyFixedStage(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "fake-docker")
	// This substituted CLI cannot execute Docker or repository code.
	if err := os.WriteFile(binary, []byte("#!/bin/sh\ncase \"$1\" in image) printf 'private invalid native receipt\\n';; esac\n"), 0700); err != nil {
		t.Fatal(err)
	}
	e, err := New(Config{WorkerID: "owned", DockerBinary: binary, ApprovedImages: []string{"alpine@sha256:" + strings.Repeat("a", 64)}})
	if err != nil {
		t.Fatal(err)
	}
	a, err := NewActions(e, binary)
	if err != nil {
		t.Fatal(err)
	}
	archive := []byte("controlled source not executed")
	sum := sha256.Sum256(archive)
	input := ActionExecutionInput{Input: ActionPlanInput{Catalog: ActionsCatalog, Archive: archive}, Plan: ActionPlan{Catalog: ActionsCatalog, ArchiveSHA256: hex.EncodeToString(sum[:])}, TimeoutSeconds: 1}
	result, err := a.Execute(t.Context(), strings.Repeat("b", 32), input, func(context.Context, ActionFrame) error { t.Fatal("source reached observer"); return nil })
	if !errors.Is(err, ErrInfrastructure) || ActionsFailureStage(err) != "daemon_image_validation" || result.ExitCode != 255 || strings.Contains(err.Error(), "private invalid") {
		t.Fatal("actual preparation failure misclassified")
	}
	input.Plan.ArchiveSHA256 = "wrong"
	_, err = a.Execute(t.Context(), strings.Repeat("b", 32), input, func(context.Context, ActionFrame) error { return nil })
	if !errors.Is(err, ErrInvalidJob) || ActionsFailureStage(err) != "input_validation" {
		t.Fatal("invalid source was reclassified as infrastructure")
	}
}

func TestHelperTransferStreamsBoundedBinaryIntoOwnedExecutableNamespaceAndChecksFullDigest(t *testing.T) {
	for _, mode := range []string{"valid", "changed_digest", "transfer_failure", "empty"} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			helper := filepath.Join(directory, "helper")
			captured := filepath.Join(directory, "captured")
			binary := filepath.Join(directory, "fake-docker")
			body := bytes.Repeat([]byte{'x', 0, 0xff, '\n'}, 33<<10)
			if mode == "empty" {
				body = nil
			}
			if err := os.WriteFile(helper, body, 0700); err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256(body)
			digest := hex.EncodeToString(sum[:])
			if mode == "changed_digest" {
				digest = strings.Repeat("f", 64)
			}
			quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
			transfer := "cat > " + quote(captured)
			if mode == "transfer_failure" {
				transfer = "exit 1"
			}
			// Substituted CLI: binary bytes are stdin, never command text; fixed
			// audited path/command is asserted, and no Docker/source is executed.
			script := "#!/bin/sh\n[ \"$1\" = exec ] || exit 2\nif [ \"$2\" = -i ]; then\n [ \"$4\" = /bin/sh ] && [ \"$5\" = -c ] && [ \"$6\" = 'umask 077; cat > /usr/local/bin/golf-actions-engine && chmod 0555 /usr/local/bin/golf-actions-engine' ] || exit 3\n " + transfer + "\nelse\n [ \"$3\" = sha256sum ] && [ \"$4\" = /usr/local/bin/golf-actions-engine ] || exit 4\n printf '%s  /usr/local/bin/golf-actions-engine\\n' '" + digest + "'\nfi\n"
			if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			e, err := New(Config{WorkerID: "owned", DockerBinary: binary, ApprovedImages: []string{"alpine@sha256:" + strings.Repeat("a", 64)}})
			if err != nil {
				t.Fatal(err)
			}
			a, err := NewActions(e, helper)
			if err != nil {
				t.Fatal(err)
			}
			phase, err := a.transferHelper(t.Context(), strings.Repeat("b", 64))
			expectedPhase := map[string]string{"valid": "helper_remote_hash", "changed_digest": "helper_remote_hash", "transfer_failure": "helper_transfer", "empty": "helper_local_hash"}[mode]
			if phase != expectedPhase || (err == nil) != (mode == "valid") || (err != nil && !errors.Is(err, ErrInfrastructure)) {
				t.Fatal("transfer/verification policy differs", phase)
			}
			if mode == "valid" || mode == "changed_digest" {
				actual, err := os.ReadFile(captured)
				if err != nil || !bytes.Equal(actual, body) {
					t.Fatal("stdin binary copy changed/truncated or used wrong path")
				}
			} else if _, err := os.Stat(captured); !os.IsNotExist(err) {
				t.Fatal("refused helper leaked a copy")
			}
		})
	}
}

func TestActionsHelperDiagnosticAcceptsOnlyCompleteClosedLine(t *testing.T) {
	valid := ActionsEngineFailureDiagnostic("engine_job_mounts")
	for _, raw := range []string{"", "engine_job_mounts", strings.TrimSuffix(valid, "\n"), valid + "\n", valid + "private stderr", "private stderr\n" + valid, "GOLF_ACTIONS_FAILURE_STAGE=private_token\n", strings.ReplaceAll(valid, "\n", "\r\n"), strings.Repeat("x", 129)} {
		if parseActionsEngineFailure([]byte(raw)) != "" {
			t.Fatal("untrusted/ambiguous stderr became a diagnostic")
		}
	}
	if parseActionsEngineFailure([]byte(valid)) != "engine_job_mounts" {
		t.Fatal("exact trusted line refused")
	}
	var output actionsEngineDiagnostic
	for _, piece := range []string{valid[:12], valid[12:]} {
		if _, err := output.Write([]byte(piece)); err != nil {
			t.Fatal(err)
		}
	}
	if parseActionsEngineFailure(output.data) != "engine_job_mounts" {
		t.Fatal("pipe chunking changed classification")
	}
	output.Write(bytes.Repeat([]byte{'x'}, 129))
	output.Write([]byte(valid))
	if !output.invalid || len(output.data) != 0 || parseActionsEngineFailure(output.data) != "" {
		t.Fatal("overflow resurrected an earlier/later diagnostic")
	}
	classified := &actionsStageError{"engine_job_mounts", ErrInfrastructure}
	if ActionsFailureStage(classified) != "engine_job_mounts" || !errors.Is(classified, ErrInfrastructure) {
		t.Fatal("inner fixed code changed runner failure policy")
	}
}

func manualInputExecutionFixture(t *testing.T) ActionExecutionInput {
	t.Helper()
	schema, err := workflowinputs.Parse([]byte(`on:
  workflow_dispatch:
    inputs:
      message: {type: string, required: true}
      enabled: {type: boolean, default: false}
      count: {type: number, default: 0}
`))
	if err != nil {
		t.Fatal("schema fixture")
	}
	values, err := workflowinputs.Validate(schema, []workflowinputs.Value{{Name: "message", Type: workflowinputs.String, String: "private <>& 世界"}})
	if err != nil {
		t.Fatal("value fixture")
	}
	archive := []byte("owned source fixture not executed")
	sum := sha256.Sum256(archive)
	commit := strings.Repeat("a", 40)
	plan := ActionPlan{Catalog: ActionsInputsCatalog, EngineCommit: ActionsEngineCommit, WorkflowPath: ".github/workflows/main.yml", WorkflowBlobID: strings.Repeat("b", 40), ArchiveSHA256: hex.EncodeToString(sum[:]), Event: "workflow_dispatch", Ref: commit, ManualInputsContract: ManualInputsCapability, ManualInputsSchemaSHA256: schema.SHA256, Jobs: []ActionJob{{InstanceID: strings.Repeat("c", 32)}}}
	event, _ := json.Marshal(map[string]any{"ref": commit, "after": commit, "inputs": map[string]string{"message": "private <>& 世界", "enabled": "false", "count": "0"}})
	return ActionExecutionInput{Input: ActionPlanInput{Catalog: plan.Catalog, WorkflowPath: plan.WorkflowPath, WorkflowBlobID: plan.WorkflowBlobID, Archive: archive, Event: plan.Event, Ref: plan.Ref, ManualInputsContract: plan.ManualInputsContract, ManualInputsSchemaSHA256: plan.ManualInputsSchemaSHA256}, Plan: plan, CommitID: commit, EventJSON: event, TimeoutSeconds: 1, ManualInputs: &ActionManualInputs{Contract: ManualInputsCapability, SchemaSHA256: schema.SHA256, SubmittedSHA256: values.SubmittedSHA256, EffectiveSHA256: values.EffectiveSHA256, Submitted: values.Submitted, Effective: values.Effective}}
}

func TestVersionedManualInputEnvelopeRejectsPrivateDrift(t *testing.T) {
	original := manualInputExecutionFixture(t)
	if ValidateActionManualInputs(original.Plan, original.ManualInputs, original.EventJSON, original.CommitID) != nil {
		t.Fatal("bound typed envelope refused")
	}
	for name, change := range map[string]func(*ActionExecutionInput){
		"missing": func(v *ActionExecutionInput) { v.ManualInputs = nil }, "legacy_envelope": func(v *ActionExecutionInput) { v.Plan.Catalog = ActionsCatalog },
		"unknown_catalog": func(v *ActionExecutionInput) { v.Plan.Catalog = "future" }, "wrong_engine": func(v *ActionExecutionInput) { v.Plan.EngineCommit = strings.Repeat("f", 40) },
		"contract": func(v *ActionExecutionInput) { v.ManualInputs.Contract = "other" }, "schema": func(v *ActionExecutionInput) { v.ManualInputs.SchemaSHA256 = strings.Repeat("f", 64) },
		"submitted_digest": func(v *ActionExecutionInput) { v.ManualInputs.SubmittedSHA256 = strings.Repeat("f", 64) }, "effective_digest": func(v *ActionExecutionInput) { v.ManualInputs.EffectiveSHA256 = strings.Repeat("f", 64) },
		"null_submitted": func(v *ActionExecutionInput) { v.ManualInputs.Submitted = nil }, "null_effective": func(v *ActionExecutionInput) { v.ManualInputs.Effective = nil },
		"unsorted": func(v *ActionExecutionInput) {
			v.ManualInputs.Effective[0], v.ManualInputs.Effective[1] = v.ManualInputs.Effective[1], v.ManualInputs.Effective[0]
		},
		"noncanonical_number": func(v *ActionExecutionInput) { v.ManualInputs.Effective[0].Number = "0.0" },
		"value":               func(v *ActionExecutionInput) { v.ManualInputs.Effective[2].String = "changed-private" },
		"push":                func(v *ActionExecutionInput) { v.Plan.Event = "push" }, "commit": func(v *ActionExecutionInput) { v.CommitID = strings.Repeat("d", 40) },
		"branch": func(v *ActionExecutionInput) { v.Plan.Ref = "refs/heads/main" },
		"event_type": func(v *ActionExecutionInput) {
			v.EventJSON = bytes.Replace(v.EventJSON, []byte(`"enabled":"false"`), []byte(`"enabled":false`), 1)
		},
		"event_duplicate": func(v *ActionExecutionInput) {
			v.EventJSON = bytes.Replace(v.EventJSON, []byte(`"inputs":{`), []byte(`"inputs":{},"inputs":{`), 1)
		},
		"event_input_duplicate": func(v *ActionExecutionInput) {
			v.EventJSON = bytes.Replace(v.EventJSON, []byte(`"count":"0"`), []byte(`"count":"wrong","count":"0"`), 1)
		},
		"event_extra": func(v *ActionExecutionInput) {
			v.EventJSON = bytes.Replace(v.EventJSON, []byte(`"inputs":{`), []byte(`"inputs":{"extra":"private",`), 1)
		},
		"event_source": func(v *ActionExecutionInput) {
			v.EventJSON = bytes.Replace(v.EventJSON, []byte(original.CommitID), []byte(strings.Repeat("d", 40)), 1)
		},
	} {
		t.Run(name, func(t *testing.T) {
			body, _ := json.Marshal(original)
			var changed ActionExecutionInput
			if json.Unmarshal(body, &changed) != nil {
				t.Fatal("fixture clone")
			}
			change(&changed)
			err := ValidateActionManualInputs(changed.Plan, changed.ManualInputs, changed.EventJSON, changed.CommitID)
			if !errors.Is(err, ErrInvalidJob) || strings.Contains(err.Error(), "private") {
				t.Fatal("bad envelope accepted or private error leaked")
			}
		})
	}
	for _, plan := range []ActionPlan{{Catalog: ActionsCatalog}, {Catalog: ActionsCatalog, Event: "push"}} {
		if ValidateActionManualInputs(plan, nil, nil, "") != nil {
			t.Fatal("legacy absent envelope changed")
		}
		plan.ManualInputsContract = ManualInputsCapability
		if ValidateActionManualInputs(plan, nil, nil, "") == nil {
			t.Fatal("legacy new fields accepted")
		}
	}
}

func TestManualEnvelopeRejectedBeforeDockerOrSourceTransfer(t *testing.T) {
	dir := t.TempDir()
	trace := filepath.Join(dir, "trace")
	binary := filepath.Join(dir, "docker-fixture")
	if os.WriteFile(binary, []byte("#!/bin/sh\nprintf 'called\\n' >> '"+trace+"'\n"), 0700) != nil {
		t.Fatal("fixture binary")
	}
	e, err := New(Config{WorkerID: "owned", DockerBinary: binary, ApprovedImages: []string{"alpine@sha256:" + strings.Repeat("b", 64)}})
	if err != nil {
		t.Fatal(err)
	}
	executor, err := NewActions(e, binary)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*ActionExecutionInput){
		func(v *ActionExecutionInput) { v.ManualInputs = nil }, func(v *ActionExecutionInput) { v.Input.Catalog = ActionsCatalog }, func(v *ActionExecutionInput) { v.Input.ManualInputsSchemaSHA256 = strings.Repeat("f", 64) }, func(v *ActionExecutionInput) { v.Input.Ref = strings.Repeat("f", 40) },
	} {
		input := manualInputExecutionFixture(t)
		change(&input)
		_, err := executor.Execute(t.Context(), strings.Repeat("a", 32), input, func(context.Context, ActionFrame) error { t.Fatal("unexpected frame"); return nil })
		if !errors.Is(err, ErrInvalidJob) || ActionsFailureStage(err) != "input_validation" {
			t.Fatal("private envelope reached executor")
		}
	}
	if _, err := os.Stat(trace); !os.IsNotExist(err) {
		t.Fatal("invalid envelope touched Docker")
	}
}

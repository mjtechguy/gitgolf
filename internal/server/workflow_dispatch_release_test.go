package server

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

const releaseWorkflowFixture = `on:
  workflow_dispatch:
    inputs:
      text: {type: string, required: true}
      flag: {type: boolean, default: false}
      count: {type: number, default: 2.5}
      mode: {type: choice, options: [a, b], default: a}
jobs:
  build:
    runs-on: linux
    steps: [{run: 'printf ok'}]
`

func releasePureFixture(t *testing.T) (workflowRunRecord, runner.ActionPlan, *runner.ActionManualInputs, []byte) {
	t.Helper()
	data := []byte(releaseWorkflowFixture)
	schema, err := parseWorkflowDispatchInputs(data)
	if err != nil {
		t.Fatal("release declaration fixture")
	}
	values, err := validateWorkflowDispatchInputs(schema, []workflowDispatchInputValue{{Name: "text", Type: workflowDispatchString, String: "literal <>& 世界 ${{ inputs.count }}"}})
	if err != nil {
		t.Fatal("release value fixture")
	}
	source := workflowRunTar(t, []*tar.Header{{Name: runWorkflowPath, Typeflag: tar.TypeReg, Mode: 0644}}, [][]byte{data})
	run := workflowRunRecord{RepositoryID: 7, OwnerID: 42, RepositoryOwner: "alice", RepositoryName: "example", CommitID: strings.Repeat("a", 40), WorkflowPath: runWorkflowPath, BlobID: workflowTestBlob(data), SourceSHA256: sourceArchiveHash(source), EngineCatalog: runner.ActionsInputsCatalog, InputContract: runner.ManualInputsCapability, SchemaSHA256: schema.SHA256, SubmittedSHA256: values.SubmittedSHA256, EffectiveSHA256: values.EffectiveSHA256}
	plan := runner.ActionPlan{Catalog: runner.ActionsInputsCatalog, EngineCommit: runner.ActionsEngineCommit, Event: "workflow_dispatch", Ref: run.CommitID, WorkflowPath: run.WorkflowPath, WorkflowBlobID: run.BlobID, ArchiveSHA256: run.SourceSHA256, ManualInputsContract: run.InputContract, ManualInputsSchemaSHA256: run.SchemaSHA256}
	inputs := &runner.ActionManualInputs{Contract: run.InputContract, SchemaSHA256: run.SchemaSHA256, SubmittedSHA256: run.SubmittedSHA256, EffectiveSHA256: run.EffectiveSHA256, Submitted: values.Submitted, Effective: values.Effective}
	return run, plan, inputs, source
}

func TestWorkflowManualReleaseStoredSourceSchema(t *testing.T) {
	run, _, _, source := releasePureFixture(t)
	schema, err := workflowDispatchStoredSourceSchema(run, source)
	if err != nil || schema.SHA256 != run.SchemaSHA256 || len(schema.Definitions) != 4 {
		t.Fatal("exact retained source schema refused")
	}
	for name, change := range map[string]func(*workflowRunRecord){
		"archive_digest":  func(r *workflowRunRecord) { r.SourceSHA256 = strings.Repeat("b", 64) },
		"blob":            func(r *workflowRunRecord) { r.BlobID = strings.Repeat("b", 40) },
		"schema":          func(r *workflowRunRecord) { r.SchemaSHA256 = strings.Repeat("b", 64) },
		"path":            func(r *workflowRunRecord) { r.WorkflowPath = ".github/workflows/other.yml" },
		"legacy_contract": func(r *workflowRunRecord) { r.InputContract = "" },
		"legacy_catalog":  func(r *workflowRunRecord) { r.EngineCatalog = runner.ActionsCatalog },
	} {
		t.Run(name, func(t *testing.T) {
			changed := run
			change(&changed)
			if _, err := workflowDispatchStoredSourceSchema(changed, source); !errors.Is(err, errCredentialUnavailable) {
				t.Fatal("tampered retained source identity accepted")
			}
		})
	}
	for name, makeSource := range map[string]func() ([]byte, string){
		"duplicate": func() ([]byte, string) {
			data := []byte(releaseWorkflowFixture)
			return workflowRunTar(t, []*tar.Header{{Name: runWorkflowPath, Typeflag: tar.TypeReg}, {Name: runWorkflowPath, Typeflag: tar.TypeReg}}, [][]byte{data, data}), run.BlobID
		},
		"symlink": func() ([]byte, string) {
			return workflowRunTar(t, []*tar.Header{{Name: runWorkflowPath, Typeflag: tar.TypeSymlink, Linkname: "elsewhere"}}, [][]byte{nil}), run.BlobID
		},
		"changed_type": func() ([]byte, string) {
			data := []byte(strings.Replace(releaseWorkflowFixture, "type: boolean, default: false", "type: string, default: 'false'", 1))
			return workflowRunTar(t, []*tar.Header{{Name: runWorkflowPath, Typeflag: tar.TypeReg}}, [][]byte{data}), workflowTestBlob(data)
		},
		"invalid_declaration": func() ([]byte, string) {
			data := []byte(strings.Replace(releaseWorkflowFixture, "type: boolean", "type: unknown", 1))
			return workflowRunTar(t, []*tar.Header{{Name: runWorkflowPath, Typeflag: tar.TypeReg}}, [][]byte{data}), workflowTestBlob(data)
		},
		"lfs": func() ([]byte, string) {
			data := []byte("version https://git-lfs.github.com/spec/v1\noid sha256:" + strings.Repeat("a", 64) + "\nsize 1\n")
			return workflowRunTar(t, []*tar.Header{{Name: runWorkflowPath, Typeflag: tar.TypeReg}}, [][]byte{data}), workflowTestBlob(data)
		},
		"truncated": func() ([]byte, string) { return append([]byte{}, source[:600]...), run.BlobID },
	} {
		t.Run(name, func(t *testing.T) {
			data, blob := makeSource()
			changed := run
			changed.SourceSHA256 = sourceArchiveHash(data)
			changed.BlobID = blob
			if _, err := workflowDispatchStoredSourceSchema(changed, data); !errors.Is(err, errCredentialUnavailable) {
				t.Fatal("malformed or changed stored declaration accepted")
			}
		})
	}
}

func cloneReleaseInputs(t *testing.T, inputs *runner.ActionManualInputs) *runner.ActionManualInputs {
	t.Helper()
	data, err := json.Marshal(inputs)
	var out runner.ActionManualInputs
	if err != nil || json.Unmarshal(data, &out) != nil {
		t.Fatal("envelope fixture clone")
	}
	return &out
}
func TestWorkflowManualReleaseCanonicalEvent(t *testing.T) {
	run, plan, inputs, _ := releasePureFixture(t)
	body, err := workflowActionEventJSON(run, plan, inputs)
	if err != nil {
		t.Fatal("exact canonical event refused")
	}
	var event struct {
		Ref        string            `json:"ref"`
		After      string            `json:"after"`
		Inputs     map[string]string `json:"inputs"`
		Repository struct {
			ID       int64  `json:"id"`
			Name     string `json:"name"`
			FullName string `json:"full_name"`
			Owner    struct {
				ID    int64  `json:"id"`
				Login string `json:"login"`
			}
		} `json:"repository"`
	}
	if json.Unmarshal(body, &event) != nil || event.Ref != run.CommitID || event.After != run.CommitID || event.Repository.ID != 7 || event.Repository.Owner.ID != 42 || event.Repository.Name != "example" || event.Repository.FullName != "alice/example" || event.Repository.Owner.Login != "alice" || len(event.Inputs) != 4 || event.Inputs["flag"] != "false" || event.Inputs["count"] != "2.5" || event.Inputs["mode"] != "a" || event.Inputs["text"] != "literal <>& 世界 ${{ inputs.count }}" {
		t.Fatal("event changed native identity or effective string meanings")
	}
	for name, change := range map[string]func(*runner.ActionManualInputs){
		"contract":            func(v *runner.ActionManualInputs) { v.Contract = "other" },
		"schema":              func(v *runner.ActionManualInputs) { v.SchemaSHA256 = strings.Repeat("b", 64) },
		"submitted_digest":    func(v *runner.ActionManualInputs) { v.SubmittedSHA256 = strings.Repeat("b", 64) },
		"effective_digest":    func(v *runner.ActionManualInputs) { v.EffectiveSHA256 = strings.Repeat("b", 64) },
		"submitted_plaintext": func(v *runner.ActionManualInputs) { v.Submitted[0].String = "different" },
		"effective_boolean": func(v *runner.ActionManualInputs) {
			for i := range v.Effective {
				if v.Effective[i].Type == workflowDispatchBoolean {
					v.Effective[i].Boolean = true
				}
			}
		},
		"number_noncanonical": func(v *runner.ActionManualInputs) {
			for i := range v.Effective {
				if v.Effective[i].Type == workflowDispatchNumber {
					v.Effective[i].Number = "2.50"
				}
			}
		},
		"type":      func(v *runner.ActionManualInputs) { v.Submitted[0].Type = workflowDispatchBoolean },
		"order":     func(v *runner.ActionManualInputs) { v.Effective[0], v.Effective[1] = v.Effective[1], v.Effective[0] },
		"duplicate": func(v *runner.ActionManualInputs) { v.Effective = append(v.Effective, v.Effective[0]) },
	} {
		t.Run(name, func(t *testing.T) {
			changed := cloneReleaseInputs(t, inputs)
			change(changed)
			if _, err := workflowActionEventJSON(run, plan, changed); !errors.Is(err, errCredentialUnavailable) {
				t.Fatal("changed private envelope accepted")
			}
		})
	}
	for name, change := range map[string]func(*runner.ActionPlan){"ref": func(p *runner.ActionPlan) { p.Ref = strings.Repeat("b", 40) }, "catalog": func(p *runner.ActionPlan) { p.Catalog = runner.ActionsCatalog }, "engine": func(p *runner.ActionPlan) { p.EngineCommit = strings.Repeat("b", 40) }} {
		t.Run(name, func(t *testing.T) {
			p := plan
			change(&p)
			if _, err := workflowActionEventJSON(run, p, inputs); !errors.Is(err, errCredentialUnavailable) {
				t.Fatal("changed plan accepted")
			}
		})
	}
	if _, err := workflowActionEventJSON(run, plan, nil); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("v2 omitted its private envelope")
	}
	legacy := runner.ActionPlan{Catalog: runner.ActionsCatalog, Ref: "refs/heads/main"}
	if data, err := workflowActionEventJSON(run, legacy, nil); err != nil || bytes.Contains(data, []byte(`"inputs"`)) {
		t.Fatal("legacy event acquired typed inputs")
	}
}

func releaseTypedAdmission(t *testing.T) (*workflowRunFixture, *golfv1.WorkflowRun) {
	t.Helper()
	f, m := typedPreparedFixture(t, true)
	response, err := f.server.DispatchWorkflow(f.context(t), workflowRunRequest(f, m))
	if err != nil {
		t.Fatal("typed release admission", err)
	}
	return f, response.Msg.Run
}
func releasePollBody() map[string]any {
	return map[string]any{"catalogs": []string{runner.ActionsInputsCatalog}, "capabilities": []string{runner.JobLimitsCapability, runner.ManualInputsCapability}}
}

func TestWorkflowManualReleaseSecureWorkerPostgres(t *testing.T) {
	f, admitted := releaseTypedAdmission(t)
	for _, tc := range []struct {
		name    string
		version uint16
		body    any
	}{
		{"http", 0, releasePollBody()}, {"tls12", tls.VersionTLS12, releasePollBody()},
		{"old_catalog", tls.VersionTLS13, map[string]any{"catalogs": []string{runner.ActionsCatalog}, "capabilities": []string{runner.JobLimitsCapability, runner.ManualInputsCapability}}},
		{"missing_manual_capability", tls.VersionTLS13, map[string]any{"catalogs": []string{runner.ActionsInputsCatalog}, "capabilities": []string{runner.JobLimitsCapability}}},
		{"missing_resources", tls.VersionTLS13, map[string]any{"catalogs": []string{runner.ActionsInputsCatalog}, "capabilities": []string{runner.ManualInputsCapability}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := executionWorkerCall(f, engineLease{}, "poll", tc.body, tc.version)
			if response.Code != 204 || bytes.Contains(response.Body.Bytes(), []byte("private")) {
				t.Fatal("unqualified worker received private parameters", response.Code)
			}
		})
	}
	row, err := f.server.loadWorkflowRun(t.Context(), admitted.Id)
	if err != nil || row.State != "queued" || row.AttemptID != "" {
		t.Fatal("old worker consumed original admission")
	}
	response := executionWorkerCall(f, engineLease{}, "poll", releasePollBody(), tls.VersionTLS13)
	var assignment struct {
		RunID, AttemptID, AttemptToken, CommitID, SourceSHA256, EngineCatalog string
		ActionsPlan                                                           runner.ActionPlan
		ManualInputs                                                          *runner.ActionManualInputs
		EventJSON                                                             []byte
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &assignment) != nil || assignment.ManualInputs == nil || assignment.RunID != admitted.Id || assignment.CommitID != admitted.CommitId || assignment.SourceSHA256 != admitted.SourceSha256 || assignment.EngineCatalog != runner.ActionsInputsCatalog || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("secure exact typed assignment refused", response.Code)
	}
	if err := runner.ValidateActionManualInputs(assignment.ActionsPlan, assignment.ManualInputs, assignment.EventJSON, assignment.CommitID); err != nil || assignment.ManualInputs.SubmittedSHA256 != admitted.SubmittedSha256 || assignment.ManualInputs.EffectiveSHA256 != admitted.EffectiveSha256 || assignment.ManualInputs.SchemaSHA256 != admitted.SchemaSha256 {
		t.Fatal("release digests or event lost their original binding")
	}
	if next := executionWorkerCall(f, engineLease{}, "poll", releasePollBody(), tls.VersionTLS13); next.Code != 204 || next.Body.Len() != 0 {
		t.Fatal("poll released original inputs twice", next.Code)
	}
	row, err = f.server.loadWorkflowRun(t.Context(), admitted.Id)
	hash := sha256.Sum256([]byte(assignment.AttemptToken))
	if err != nil || row.State != "running" || row.AttemptID != assignment.AttemptID || !bytes.Equal(row.LeaseTokenHash, hash[:]) {
		t.Fatal("private release preceded authoritative attempt commit")
	}
	if err = f.server.runnerManualInputReleaseFence(t.Context(), row, "fixture", assignment.AttemptID, hash[:]); err != nil {
		t.Fatal("current exact release fence refused", err)
	}
	if err = f.server.runnerManualInputReleaseFence(t.Context(), row, "fixture", strings.Repeat("0", 32), hash[:]); err == nil {
		t.Fatal("wrong attempt passed release fence")
	}
	if err = f.server.runnerManualInputReleaseFence(t.Context(), row, "fixture", assignment.AttemptID, bytes.Repeat([]byte{0}, 32)); err == nil {
		t.Fatal("wrong lease passed release fence")
	}
	changed := row
	changed.EffectiveSHA256 = strings.Repeat("f", 64)
	if err = f.server.runnerManualInputReleaseFence(t.Context(), changed, "fixture", assignment.AttemptID, hash[:]); err == nil {
		t.Fatal("changed value identity passed release fence")
	}
}

// Inject only supported Golf authority-state fixture changes AFTER the durable
// attempt claim, during final native re-observation. No native mutation is faked.
func TestWorkflowManualReleaseLateAuthorityPostgres(t *testing.T) {
	for _, name := range []string{"native_writer", "session", "policy", "worker", "cancel"} {
		t.Run(name, func(t *testing.T) {
			f, admitted := releaseTypedAdmission(t)
			original := f.server.client.Transport
			changed := false
			f.server.client.Transport = creationRoundTripper(func(req *http.Request) (*http.Response, error) {
				response, err := original.RoundTrip(req)
				if err != nil || changed {
					return response, err
				}
				var claimed bool
				if err = f.server.db.QueryRow(`SELECT state='running' FROM golf_workflow_runs WHERE id=$1`, admitted.Id).Scan(&claimed); err != nil {
					t.Fatal("late-fence fixture read", err)
				}
				if !claimed {
					return response, nil
				}
				changed = true
				switch name {
				case "native_writer":
					f.mu.Lock()
					f.permission = "read"
					f.mu.Unlock()
				case "session":
					if err = f.server.logoutSession(t.Context(), f.session.Value); err != nil {
						t.Fatal("late logout fixture", err)
					}
				case "policy":
					_, err = f.server.db.Exec(`UPDATE golf_execution_policies SET manual_dispatch_enabled=false,revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE forge_url=$1 AND scope='instance'`, f.server.config.GiteaURL)
				case "worker":
					_, err = f.server.db.Exec(`INSERT INTO golf_runner_controls(forge_url,runner_id,state,version) VALUES($1,'fixture','revoked',1)`, f.server.config.GiteaURL)
				case "cancel":
					_, err = f.server.db.Exec(`UPDATE golf_workflow_runs SET cancel_requested=true,version=version+1 WHERE id=$1`, admitted.Id)
				}
				if err != nil {
					t.Fatal("late authority fixture update", err)
				}
				return response, nil
			})
			response := executionWorkerCall(f, engineLease{}, "poll", releasePollBody(), tls.VersionTLS13)
			if !changed || response.Code != 403 || bytes.Contains(response.Body.Bytes(), []byte("private")) || bytes.Contains(response.Body.Bytes(), []byte("manualInputs")) {
				t.Fatal("late revoked authority released private parameters", response.Code)
			}
			row, err := f.server.loadWorkflowRun(t.Context(), admitted.Id)
			if err != nil || row.State != "cancelled" || row.AttemptID == "" {
				t.Fatal("late refusal erased or revived the original claimed attempt", err)
			}
		})
	}
}

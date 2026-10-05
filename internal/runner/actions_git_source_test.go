package runner

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func stagingExecutor(t *testing.T, binary string) *ActionsExecutor {
	t.Helper()
	e, err := New(Config{WorkerID: "owned", DockerBinary: binary, ApprovedImages: []string{"alpine@sha256:" + strings.Repeat("b", 64)}})
	if err != nil {
		t.Fatal(err)
	}
	a, err := NewActions(e, binary)
	if err != nil {
		t.Fatal(err)
	}
	return a
}
func stageQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

func TestActionsGitSourceFixedFileStreamAndClosedReceipt(t *testing.T) {
	body := bytes.Repeat([]byte{'x', 0, 255, '\n'}, 40<<10)
	sum := sha256.Sum256(body)
	expected := hex.EncodeToString(sum[:])
	m := &GitSourceManifest{Profile: GitSourceProfile, MetadataSHA256: expected}
	for _, mode := range []string{"valid", "copy_failure", "wrong_sha", "suffix", "duplicate", "foreign_path", "cancel_copy", "cancel_hash"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			capture := filepath.Join(dir, "captured.tar")
			binary := filepath.Join(dir, "docker")
			ready := filepath.Join(dir, "cancel-ready")
			copyCommand := "/bin/cat > " + stageQuote(capture)
			if mode == "copy_failure" {
				copyCommand = "exit 7"
			}
			if mode == "cancel_copy" {
				copyCommand = ": > " + stageQuote(ready) + "; exec /bin/sleep 60"
			}
			receipt := expected + "  " + GitSourceMetadataPath + "\n"
			switch mode {
			case "wrong_sha":
				receipt = strings.Repeat("0", 64) + "  " + GitSourceMetadataPath + "\n"
			case "suffix":
				receipt = expected + "  " + GitSourceMetadataPath + " private\n"
			case "duplicate":
				receipt += receipt
			case "foreign_path":
				receipt = expected + "  /golf/foreign.tar\n"
			}
			hashCommand := "printf '%s' " + stageQuote(receipt)
			if mode == "cancel_hash" {
				hashCommand = ": > " + stageQuote(ready) + "; exec /bin/sleep 60"
			}
			script := "#!/bin/sh\nif [ \"$1\" = container ]; then\n [ \"$2\" = cp ] && [ \"$3\" = '-' ] && [ \"$4\" = '" + strings.Repeat("c", 64) + ":/golf' ] || exit 2\n " + copyCommand + "\nelif [ \"$1\" = exec ]; then\n [ \"$2\" = '" + strings.Repeat("c", 64) + "' ] && [ \"$3\" = sha256sum ] && [ \"$4\" = /golf/git-source.tar ] || exit 3\n " + hashCommand + "\nelse exit 4; fi\n"
			if os.WriteFile(binary, []byte(script), 0700) != nil {
				t.Fatal("fixture")
			}
			a := stagingExecutor(t, binary)
			ctx := context.Background()
			var cancelled chan time.Time
			if strings.HasPrefix(mode, "cancel_") {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(t.Context())
				defer cancel()
				cancelled = make(chan time.Time, 1)
				go func() {
					timeout := time.NewTimer(5 * time.Second)
					defer timeout.Stop()
					poll := time.NewTicker(time.Millisecond)
					defer poll.Stop()
					for {
						select {
						case <-poll.C:
							if _, e := os.Stat(ready); e == nil {
								cancelled <- time.Now()
								cancel()
								return
							}
						case <-timeout.C:
							cancelled <- time.Time{}
							cancel()
							return
						case <-ctx.Done():
							return
						}
					}
				}()
			}
			phase, err := a.transferGitSource(ctx, strings.Repeat("c", 64), m, body)
			wantPhase := "git_source_remote_hash"
			if mode == "copy_failure" || mode == "cancel_copy" {
				wantPhase = "git_source_transfer"
			}
			if phase != wantPhase || (err == nil) != (mode == "valid") || (err != nil && !errors.Is(err, ErrInfrastructure)) {
				t.Fatalf("wrong fixed-file result %s %v", phase, err)
			}
			if cancelled != nil {
				signaled := <-cancelled
				if signaled.IsZero() {
					t.Fatal("fixture did not enter its selected cancellation phase")
				}
				if ctx.Err() == nil || time.Since(signaled) > 3*time.Second {
					t.Fatal("copy/producer/hash cancellation not bounded")
				}
			}
			if mode == "valid" || mode == "wrong_sha" || mode == "suffix" || mode == "duplicate" || mode == "foreign_path" || mode == "cancel_hash" {
				raw, err := os.ReadFile(capture)
				if err != nil {
					t.Fatal(err)
				}
				reader := tar.NewReader(bytes.NewReader(raw))
				header, err := reader.Next()
				if err != nil || header.Name != "git-source.tar" || header.Typeflag != tar.TypeReg || header.Size != int64(len(body)) || header.Mode != 0444 || header.Uid != 0 || header.Gid != 0 || header.Linkname != "" || len(header.PAXRecords) != 0 {
					t.Fatal("fixed staging file grammar changed")
				}
				copied, err := io.ReadAll(reader)
				if err != nil || !bytes.Equal(copied, body) {
					t.Fatal("metadata changed or became shell text")
				}
				if _, err = reader.Next(); err != io.EOF {
					t.Fatal("extra staging path")
				}
			}
		})
	}
}

func TestActionsGitSourceBindingsBeforeDockerAndLegacyBoundary(t *testing.T) {
	manifest, prepared, archive := sourceEnvelopeFixture(t, "sha1")
	input := ActionExecutionInput{GitSource: manifest, Input: ActionPlanInput{Catalog: ActionsCatalog, WorkflowPath: manifest.WorkflowPath, WorkflowBlobID: manifest.WorkflowBlobID, Archive: archive, Event: "workflow_dispatch", Ref: manifest.CommitID}, Plan: ActionPlan{Catalog: ActionsCatalog, ArchiveSHA256: manifest.ArchiveSHA256, WorkflowPath: manifest.WorkflowPath, WorkflowBlobID: manifest.WorkflowBlobID, Event: "workflow_dispatch", Ref: manifest.CommitID}, CommitID: manifest.CommitID, TimeoutSeconds: 900, JobResources: &JobResourceBinding{Profile: JobLimitsProfile, Limits: DefaultJobLimits(), Bound: true, InstanceVersion: "0", PlacementVersion: "0"}}
	for _, mode := range []string{"legacy_manifest", "missing_manifest", "missing_metadata", "missing_binding", "unbound", "profile", "archive", "plan_workflow", "blob", "metadata", "too_large", "valid_git", "legacy_nil"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			trace := filepath.Join(dir, "calls")
			binary := filepath.Join(dir, "docker")
			script := "#!/bin/sh\nprintf '%s\\n' \"$1\" >> " + stageQuote(trace) + "\nif [ \"$1\" = image ]; then printf 'private invalid image receipt'; fi\n"
			os.WriteFile(binary, []byte(script), 0700)
			a := stagingExecutor(t, binary)
			in := input
			m := *manifest
			in.GitSource = &m
			binding := *input.JobResources
			in.JobResources = &binding
			metadata := prepared.Metadata
			switch mode {
			case "missing_manifest":
				in.GitSource = nil
			case "missing_metadata":
				metadata = nil
			case "missing_binding":
				in.JobResources = nil
			case "unbound":
				in.JobResources.Bound = false
			case "profile":
				in.GitSource.Profile = "other"
			case "archive":
				in.Plan.ArchiveSHA256 = strings.Repeat("0", 64)
			case "plan_workflow":
				in.Plan.WorkflowPath = "README.md"
			case "blob":
				in.GitSource.WorkflowBlobID = in.CommitID
			case "metadata":
				metadata = append([]byte(nil), metadata...)
				metadata[0] ^= 1
			case "too_large":
				metadata = make([]byte, GitSourceMetadataLimit+1)
			case "legacy_nil":
				in.GitSource = nil
			}
			observer := func(context.Context, ActionFrame) error {
				t.Fatal("refused/stopped fixture emitted progress")
				return nil
			}
			var result Result
			var err error
			if mode == "legacy_manifest" || mode == "legacy_nil" {
				result, err = a.Execute(t.Context(), strings.Repeat("a", 32), in, observer)
			} else {
				result, err = a.ExecuteGit(t.Context(), strings.Repeat("a", 32), in, metadata, observer)
			}
			if mode == "valid_git" || mode == "legacy_nil" {
				if !errors.Is(err, ErrInfrastructure) || ActionsFailureStage(err) != "daemon_image_validation" {
					t.Fatalf("valid bound input never reached unchanged lifecycle: %v", err)
				}
				if _, statErr := os.Stat(trace); statErr != nil {
					t.Fatal("lifecycle fixture not reached")
				}
			} else {
				if !errors.Is(err, ErrInvalidJob) || ActionsFailureStage(err) != "input_validation" {
					t.Fatalf("invalid source binding accepted: %s %v", mode, err)
				}
				if _, statErr := os.Stat(trace); !os.IsNotExist(statErr) {
					t.Fatal("invalid metadata source reached Docker")
				}
			}
			if result.ExitCode != 255 || strings.Contains(err.Error(), "private") {
				t.Fatal("success or private diagnostic invented")
			}
		})
	}
}

func TestActionsGitSourceStagingGuardsWithoutEffects(t *testing.T) {
	dir := t.TempDir()
	trace := filepath.Join(dir, "calls")
	binary := filepath.Join(dir, "docker")
	os.WriteFile(binary, []byte("#!/bin/sh\nprintf called > "+stageQuote(trace)+"\n"), 0700)
	a := stagingExecutor(t, binary)
	body := []byte("binary metadata")
	sum := sha256.Sum256(body)
	manifest := &GitSourceManifest{Profile: GitSourceProfile, MetadataSHA256: hex.EncodeToString(sum[:])}
	for _, tc := range []struct {
		id       string
		manifest *GitSourceManifest
		body     []byte
	}{{"foreign", manifest, body}, {strings.Repeat("c", 64), nil, body}, {strings.Repeat("c", 64), manifest, nil}, {strings.Repeat("c", 64), manifest, []byte("changed")}} {
		if phase, err := a.transferGitSource(t.Context(), tc.id, tc.manifest, tc.body); phase != "git_source_transfer" || !errors.Is(err, ErrInfrastructure) {
			t.Fatal("unbound staging accepted")
		}
	}
	if _, err := os.Stat(trace); !os.IsNotExist(err) {
		t.Fatal("invalid staging reached native CLI")
	}
	for _, phase := range []string{"git_source_transfer", "git_source_remote_hash"} {
		if ActionsFailureStage(&actionsStageError{phase, ErrInfrastructure}) != phase {
			t.Fatal("new phase not closed diagnostic")
		}
	}
}

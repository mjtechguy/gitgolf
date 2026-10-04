package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/mjtechguy/golf-git/internal/runner"
)

var errActionsEngine = errors.New("selected Actions engine profile is unavailable or does not admit this workflow")
var errActionsProfile = errors.New("workflow is outside the selected Actions profile")
var actionSHA = regexp.MustCompile(`^[a-f0-9]{64}$`)

func sourceArchiveHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s *Server) actionsEngineConfigured() bool {
	return s.config.ActionsEngineCatalog == runner.ActionsCatalog && s.config.ActionsEngineBinary != ""
}
func (s *Server) validateActionsEngineConfig() error {
	if s.config.ActionsEngineCatalog == "" && s.config.ActionsEngineBinary == "" {
		return nil
	}
	if !s.actionsEngineConfigured() || !filepath.IsAbs(s.config.ActionsEngineBinary) || filepath.Clean(s.config.ActionsEngineBinary) != s.config.ActionsEngineBinary || len(s.runnerImages) == 0 || len(s.runnerKeys) == 0 {
		return errors.New("Actions engine requires explicit qualified profile, absolute helper path and enrolled image/worker maps")
	}
	info, err := os.Stat(s.config.ActionsEngineBinary)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0111 == 0 {
		return errors.New("Actions helper must be an installed executable")
	}
	return nil
}

type actionOutput struct {
	bytes.Buffer
	limit int
}

func (b *actionOutput) Write(data []byte) (int, error) {
	if b.Len()+len(data) > b.limit {
		return 0, errActionsEngine
	}
	return b.Buffer.Write(data)
}

// Planning never executes source. Its process receives no backend credentials,
// Docker endpoint, inherited proxy or filesystem workdir from the repository.
func (s *Server) planActions(ctx context.Context, path, blob, event, ref string, archive []byte) (*runner.ActionPlan, error) {
	if !s.actionsEngineConfigured() {
		return nil, errActionsEngine
	}
	input := runner.ActionPlanInput{Catalog: runner.ActionsCatalog, WorkflowPath: path, WorkflowBlobID: blob, Archive: archive, Event: event, Ref: ref, Images: s.runnerImages}
	body, err := json.Marshal(input)
	if err != nil || len(body) > 24<<20 {
		return nil, errActionsEngine
	}
	body = append(body, '\n')
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.config.ActionsEngineBinary, "plan")
	cmd.Stdin = bytes.NewReader(body)
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp"}
	cmd.Dir = "/"
	cmd.Stderr = io.Discard
	output := actionOutput{limit: 256 << 10}
	cmd.Stdout = &output
	if e := cmd.Run(); e != nil {
		if exited, ok := e.(*exec.ExitError); ok {
			if exited.ExitCode() == 2 {
				return nil, errWorkflowTriggerNotMatched
			}
			if exited.ExitCode() == 3 {
				return nil, errActionsProfile
			}
		}
		return nil, errActionsEngine
	}
	decoder := json.NewDecoder(bytes.NewReader(output.Bytes()))
	decoder.DisallowUnknownFields()
	var plan runner.ActionPlan
	if decoder.Decode(&plan) != nil || decoder.Decode(new(any)) != io.EOF || validateActionPlan(plan, input) != nil {
		return nil, errActionsEngine
	}
	return &plan, nil
}
func validateActionPlan(plan runner.ActionPlan, input runner.ActionPlanInput) error {
	if plan.Catalog != runner.ActionsCatalog || plan.EngineCommit != runner.ActionsEngineCommit || plan.WorkflowPath != input.WorkflowPath || plan.WorkflowBlobID != input.WorkflowBlobID || plan.Event != input.Event || plan.Ref != input.Ref || plan.ArchiveSHA256 != sourceArchiveHash(input.Archive) || !actionSHA.MatchString(plan.ActionsSHA256) || len(plan.Jobs) < 1 || len(plan.Jobs) > 12 {
		return errActionsEngine
	}
	if len(plan.LocalActions) > 8 {
		return errActionsEngine
	}
	deps := map[string]string{}
	for _, d := range plan.LocalActions {
		if !validSourcePath(d.MetadataPath) || !(strings.HasSuffix(d.MetadataPath, "/action.yml") || strings.HasSuffix(d.MetadataPath, "/action.yaml")) || !actionSHA.MatchString(d.MetadataSHA256) || deps[d.MetadataPath] != "" {
			return errActionsEngine
		}
		deps[d.MetadataPath] = d.MetadataSHA256
	}
	encoded, _ := json.Marshal(deps)
	if sourceArchiveHash(encoded) != plan.ActionsSHA256 {
		return errActionsEngine
	}
	ids := map[string]bool{}
	jobIDs := map[string]bool{}
	steps := 0
	for _, j := range plan.Jobs {
		if !attemptIdentifier.MatchString(j.InstanceID) || ids[j.InstanceID] || !workflowJobID.MatchString(j.JobID) || !boundedActionLabel(j.Name) || len(j.Matrix) > 8 || len(j.Needs) > 8 || len(j.Steps) < 1 || len(j.Steps) > 32 {
			return errActionsEngine
		}
		ids[j.InstanceID] = true
		jobIDs[j.JobID] = true
		allowed := false
		for _, image := range input.Images {
			allowed = allowed || image == j.Image
		}
		if !allowed {
			return errActionsEngine
		}
		seen := map[string]bool{}
		for _, step := range j.Steps {
			if !actionStepID(step.ID) || seen[step.ID] || !boundedActionLabel(step.Name) {
				return errActionsEngine
			}
			seen[step.ID] = true
		}
		steps += len(j.Steps)
		for _, v := range j.Matrix {
			if !workflowJobID.MatchString(v.Name) || len(v.Name) > 64 || len(v.Value) > 1024 || !json.Valid([]byte(v.Value)) {
				return errActionsEngine
			}
		}
	}
	if steps > 128 {
		return errActionsEngine
	}
	for _, j := range plan.Jobs {
		for _, need := range j.Needs {
			if !jobIDs[need] || need == j.JobID {
				return errActionsEngine
			}
		}
	}
	return nil
}
func boundedActionLabel(s string) bool {
	return len(s) > 0 && len(s) <= 255 && runnerLogText(s) && strings.IndexFunc(s, unicode.IsControl) < 0
}
func actionStepID(s string) bool {
	return len(s) > 0 && len(s) <= 64 && strings.IndexFunc(s, func(r rune) bool {
		return !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-')
	}) < 0
}

// Local action metadata is admission authority. Git archive export-subst or
// mutable archive metadata cannot replace its independently exact Git bytes.
func (s *Server) verifyActionSources(ctx context.Context, base string, token forgeCredential, commit string, plan *runner.ActionPlan) error {
	for _, d := range plan.LocalActions {
		entry, _, err := s.sourceObjectAtPath(ctx, base, token, commit, d.MetadataPath)
		if err != nil {
			return err
		}
		if entry.Type != "file" || entry.Path != d.MetadataPath || entry.Size < 0 || entry.Size > maxWorkflowBytes {
			return errActionsProfile
		}
		body, err := s.sourceBlob(ctx, base, token, entry)
		if err != nil {
			return err
		}
		if workflowLFSPointer(body) || sourceArchiveHash(body) != d.MetadataSHA256 {
			return errActionsProfile
		}
	}
	return nil
}

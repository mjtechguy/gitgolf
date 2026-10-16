package server

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/workflowpath"
	"go.yaml.in/yaml/v3"
)

const workflowCatalog = "golf.workflow.inspect.v3"
const maxWorkflowBytes = 64 << 10
const maxWorkflowTotalBytes = 512 << 10
const maxWorkflowFiles = 20
const maxWorkflowDiagnostics = 32

var workflowJobID = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,254}$`)
var workflowImage = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$`)

func workflowDiagnostic(code, message string, node *yaml.Node) *golfv1.WorkflowDiagnostic {
	result := &golfv1.WorkflowDiagnostic{Code: code, Message: message}
	if node != nil {
		result.Line, result.Column = uint32(node.Line), uint32(node.Column)
	}
	return result
}

type workflowInspector struct{ config *golfv1.WorkflowConfiguration }

func (v workflowInspector) reject(state golfv1.WorkflowInspectionState, code, message string, node *yaml.Node) {
	if v.config.State != golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_INVALID {
		v.config.State = state
	}
	if len(v.config.Diagnostics) < maxWorkflowDiagnostics {
		v.config.Diagnostics = append(v.config.Diagnostics, workflowDiagnostic(code, message, node))
	} else {
		v.config.Diagnostics[maxWorkflowDiagnostics-1] = workflowDiagnostic("diagnostic_limit", "Additional findings are omitted after the 32-diagnostic limit; this configuration is not accepted by the inspection subset.", nil)
	}
}
func (v workflowInspector) invalid(code, message string, node *yaml.Node) {
	v.reject(golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_INVALID, code, message, node)
}
func (v workflowInspector) unsupported(code, message string, node *yaml.Node) {
	v.reject(golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_UNSUPPORTED, code, message, node)
}
func workflowString(node *yaml.Node) bool {
	return node != nil && node.Kind == yaml.ScalarNode && node.Tag == "!!str" && strings.TrimSpace(node.Value) != ""
}

// GitLab setup and script entries share one shell; indirection stays unsupported.
func workflowScript(node *yaml.Node) ([]string, bool) {
	if workflowString(node) {
		return []string{node.Value}, true
	}
	if node == nil || node.Kind != yaml.SequenceNode || len(node.Content) > 50 {
		return nil, false
	}
	commands := make([]string, 0, len(node.Content))
	for _, command := range node.Content {
		if !workflowString(command) {
			return nil, false
		}
		commands = append(commands, command.Value)
	}
	return commands, true
}
func workflowField(node *yaml.Node, name string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i < len(node.Content); i += 2 {
		if node.Content[i].Value == name {
			return node.Content[i+1]
		}
	}
	return nil
}
func (v workflowInspector) fields(node *yaml.Node, allowed ...string) {
	for i := 0; i < len(node.Content); i += 2 {
		key := node.Content[i]
		found := false
		for _, name := range allowed {
			found = found || key.Value == name
		}
		if !found {
			v.unsupported("unsupported_key", "This field is outside the inspection subset; its semantics are not evaluated.", key)
		}
	}
}
func (v workflowInspector) label(node *yaml.Node) string {
	if node == nil {
		return ""
	}
	if !workflowString(node) || len(node.Value) > 255 {
		v.unsupported("metadata_shape", "Inspection metadata requires a nonempty string of at most 255 UTF-8 bytes.", node)
		return ""
	}
	return node.Value
}

// Node decoding preserves locations and never expands aliases into Go values.
// The input is already byte-bounded; traversal adds explicit node/depth limits.
func (v workflowInspector) safeYAML(node *yaml.Node, depth int, count *int) bool {
	*count++
	if depth > 32 || *count > 4096 {
		v.invalid("yaml_complexity", "YAML exceeds the depth-32 or 4096-node inspection limit.", node)
		return false
	}
	if node.Kind == yaml.AliasNode || node.Anchor != "" || node.Style&yaml.TaggedStyle != 0 || node.Tag == "!!merge" {
		v.unsupported("yaml_indirection", "YAML anchors, aliases, merge keys and explicit tags are not supported; nothing is expanded or fetched.", node)
		return false
	}
	if strings.IndexFunc(node.Value, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) != -1 {
		v.invalid("decoded_control", "Decoded YAML values contain unsupported control characters.", node)
		return false
	}
	if strings.Contains(node.Value, "${{") {
		v.unsupported("expression", "Expressions are not evaluated by this inspection subset.", node)
	}
	if node.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i < len(node.Content); i += 2 {
			key := node.Content[i]
			if !workflowString(key) {
				v.invalid("mapping_key", "Configuration mapping keys must be nonempty strings.", key)
				return false
			}
			if seen[key.Value] {
				v.invalid("duplicate_key", "Duplicate YAML mapping keys are not accepted.", key)
				return false
			}
			seen[key.Value] = true
		}
	}
	for _, child := range node.Content {
		if !v.safeYAML(child, depth+1, count) {
			return false
		}
	}
	return true
}

func inspectWorkflow(config *golfv1.WorkflowConfiguration, data []byte) {
	config.State = golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET
	v := workflowInspector{config}
	if len(data) > maxWorkflowBytes || !utf8.Valid(data) || strings.IndexFunc(string(data), func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) != -1 {
		v.invalid("text_encoding", "Configuration must be UTF-8 text without unsupported controls and at most 64 KiB.", nil)
		return
	}
	decoder := yaml.NewDecoder(strings.NewReader(string(data)))
	var document, extra yaml.Node
	if err := decoder.Decode(&document); err != nil || len(document.Content) != 1 {
		v.invalid("yaml_syntax", "Configuration must contain one nonempty YAML document; parsing failed.", nil)
		return
	}
	if err := decoder.Decode(&extra); err != io.EOF {
		v.invalid("yaml_documents", "Only one YAML document is accepted.", nil)
		return
	}
	count := 0
	if !v.safeYAML(&document, 0, &count) {
		return
	}
	root := document.Content[0]
	if root.Kind != yaml.MappingNode || len(root.Content) == 0 {
		v.invalid("root_mapping", "Workflow configuration must be a nonempty mapping.", root)
		return
	}
	if config.Format == golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS {
		v.actions(root)
	} else {
		v.gitlab(root)
	}
}

func (v workflowInspector) actions(root *yaml.Node) {
	v.fields(root, "name", "on", "jobs")
	v.config.Name = v.label(workflowField(root, "name"))
	on := workflowField(root, "on")
	switch {
	case workflowString(on):
		v.config.Events = []string{v.label(on)}
		if on.Value != "workflow_dispatch" && on.Value != "push" {
			v.unsupported("event", "Only input-free workflow_dispatch and bounded branch push declarations are checked; inspection does not activate a trigger.", on)
		}
	case on != nil && on.Kind == yaml.MappingNode && len(on.Content) > 0:
		if len(on.Content) > 100 {
			v.invalid("event_limit", "Configuration exceeds the 50-event inspection limit.", on)
		}
		for i := 0; i < len(on.Content) && i < 100; i += 2 {
			key, value := on.Content[i], on.Content[i+1]
			v.config.Events = append(v.config.Events, v.label(key))
			switch key.Value {
			case "push":
				v.push(value)
			case "workflow_dispatch":
				if !(value.Tag == "!!null" || value.Kind == yaml.MappingNode && len(value.Content) == 0) {
					v.unsupported("event", "Only input-free workflow_dispatch is checked; inputs are not evaluated.", value)
				}
			default:
				v.unsupported("event", "Only input-free workflow_dispatch and bounded branch push declarations are checked; other events are not evaluated.", key)
			}
		}
	case on != nil && on.Kind == yaml.SequenceNode:
		if len(on.Content) < 1 || len(on.Content) > 2 {
			v.unsupported("event", "Event lists require one or two distinct literal push or workflow_dispatch declarations.", on)
		}
		seen := map[string]bool{}
		for i, value := range on.Content {
			if i >= 2 {
				break
			}
			v.config.Events = append(v.config.Events, v.label(value))
			if !workflowString(value) || (value.Value != "push" && value.Value != "workflow_dispatch") || seen[value.Value] {
				v.unsupported("event", "Event lists require one or two distinct literal push or workflow_dispatch declarations.", value)
			}
			seen[value.Value] = true
		}
	default:
		v.invalid("event_shape", "An Actions workflow requires a valid on declaration.", on)
	}
	jobs := workflowField(root, "jobs")
	if jobs == nil || jobs.Kind != yaml.MappingNode || len(jobs.Content) == 0 {
		v.invalid("jobs_shape", "An Actions workflow requires a nonempty jobs mapping.", jobs)
		return
	}
	if len(jobs.Content) > 100 {
		v.invalid("job_limit", "Configuration exceeds the 50-job inspection limit.", jobs)
		return
	}
	if len(jobs.Content) != 2 {
		v.unsupported("job_graph", "Only one job is checked; dependencies, parallelism and graph scheduling remain unavailable.", jobs)
	}
	for i := 0; i < len(jobs.Content); i += 2 {
		key, job := jobs.Content[i], jobs.Content[i+1]
		if !workflowJobID.MatchString(key.Value) || job.Kind != yaml.MappingNode {
			v.invalid("job_shape", "An Actions job needs a valid job ID and mapping.", key)
			continue
		}
		summary := &golfv1.WorkflowJobSummary{Id: key.Value, Name: v.label(workflowField(job, "name"))}
		v.config.Jobs = append(v.config.Jobs, summary)
		v.fields(job, "name", "runs-on", "steps")
		if workflowField(job, "uses") != nil {
			v.unsupported("reusable_workflow", "Reusable workflows are not resolved or executed.", job)
			continue
		}
		if !workflowString(workflowField(job, "runs-on")) {
			v.unsupported("runner_shape", "Inspection requires a literal runs-on label; no runner or hosted image equivalence is provided.", job)
		}
		steps := workflowField(job, "steps")
		if steps == nil || steps.Kind != yaml.SequenceNode || len(steps.Content) == 0 {
			v.invalid("steps_shape", "A shell job requires a nonempty steps sequence.", steps)
			continue
		}
		summary.StepCount = uint32(len(steps.Content))
		if len(steps.Content) > 50 {
			v.unsupported("step_limit", "The shell execution profile accepts at most 50 steps.", steps)
		}
		for _, step := range steps.Content {
			if step.Kind != yaml.MappingNode {
				v.invalid("step_shape", "Each Actions step must be a mapping.", step)
				continue
			}
			v.fields(step, "name", "run", "shell")
			if workflowField(step, "uses") != nil {
				v.unsupported("action_dependency", "Action dependencies are not fetched, inspected or executed.", step)
				continue
			}
			if !workflowString(workflowField(step, "run")) {
				v.invalid("run_shape", "A shell step requires a nonempty run string.", step)
			}
			v.label(workflowField(step, "name"))
			if shell := workflowField(step, "shell"); shell != nil && (!workflowString(shell) || shell.Value != "sh" && shell.Value != "bash") {
				v.unsupported("shell", "Only literal sh or bash shell names are checked; execution remains unavailable.", shell)
			}
		}
	}
}

func (v workflowInspector) push(node *yaml.Node) {
	if node.Tag == "!!null" || node.Kind == yaml.MappingNode && len(node.Content) == 0 {
		return
	}
	if node.Kind != yaml.MappingNode {
		v.unsupported("push_shape", "Push requires an empty declaration or a mapping containing only an exact branches list.", node)
		return
	}
	v.fields(node, "branches")
	branches := workflowField(node, "branches")
	if branches == nil || branches.Kind != yaml.SequenceNode || len(branches.Content) == 0 || len(branches.Content) > 50 {
		v.unsupported("push_branches", "Push branches must be a nonempty list of at most 50 exact branch names.", branches)
		return
	}
	seen := map[string]bool{}
	for _, branch := range branches.Content {
		if !workflowString(branch) || !validRef("refs/heads/"+branch.Value) || strings.HasPrefix(branch.Value, "-") ||
			strings.ContainsAny(branch.Value, "*?[]+!\\") || seen[branch.Value] {
			v.unsupported("push_branch_literal", "Push branches require distinct literal Git branch names; glob, negation and escape patterns are not supported.", branch)
		}
		seen[branch.Value] = true
	}
}

func (v workflowInspector) gitlab(root *yaml.Node) {
	stages := []string{"test"}
	if node := workflowField(root, "stages"); node != nil {
		stages = nil
		if node.Kind != yaml.SequenceNode || len(node.Content) == 0 {
			v.invalid("stages_shape", "GitLab stages must be a nonempty sequence of names.", node)
		} else {
			for _, stage := range node.Content {
				stages = append(stages, v.label(stage))
			}
			if len(stages) != 1 {
				v.unsupported("stages", "Only one stage is checked; stage scheduling is unavailable.", node)
			}
		}
	}
	for i := 0; i < len(root.Content); i += 2 {
		key, job := root.Content[i], root.Content[i+1]
		if key.Value == "stages" {
			continue
		}
		switch key.Value {
		case "include", "default", "variables", "workflow", "spec", "image", "services", "before_script", "after_script", "cache", "types":
			v.unsupported("gitlab_global", "Global defaults, variables, includes, rules and inherited configuration are not resolved or evaluated.", key)
			continue
		}
		if strings.HasPrefix(key.Value, ".") {
			v.unsupported("hidden_job", "Hidden/template jobs and inheritance are not expanded.", key)
			continue
		}
		if job.Kind != yaml.MappingNode || len(key.Value) > 255 {
			v.invalid("job_shape", "A GitLab job needs a name of at most 255 bytes and a mapping.", key)
			continue
		}
		if len(v.config.Jobs) == 50 {
			v.invalid("job_limit", "Configuration exceeds the 50-job inspection limit.", key)
			break
		}
		summary := &golfv1.WorkflowJobSummary{Id: key.Value, Name: key.Value, Stage: "test"}
		if stage := workflowField(job, "stage"); stage != nil {
			summary.Stage = v.label(stage)
		}
		v.config.Jobs = append(v.config.Jobs, summary)
		v.fields(job, "stage", "image", "before_script", "script", "artifacts")
		if node := workflowField(job, "artifacts"); node != nil {
			if _, e := workflowArtifactPaths(node); e != nil {
				v.unsupported("artifacts_shape", "Artifacts require only one to eight distinct literal relative paths; globs, links, reports, expiry and other modes are unavailable.", node)
			}
		}
		found := false
		for _, stage := range stages {
			found = found || stage == summary.Stage
		}
		if !found {
			v.unsupported("stage_reference", "This job's stage is outside the declared single-stage inspection shape.", job)
		}
		image := workflowField(job, "image")
		if !workflowString(image) || !workflowImage.MatchString(image.Value) {
			v.unsupported("image_pin", "Inspection requires a literal image with a lowercase sha256 digest; no image is pulled or approved.", image)
		}
		script := workflowField(job, "script")
		commands, valid := workflowScript(script)
		if !valid || len(commands) == 0 {
			if workflowField(job, "trigger") != nil || workflowField(job, "extends") != nil || workflowField(root, "include") != nil {
				v.unsupported("indirect_script", "Trigger, included and inherited scripts are not resolved.", job)
			} else if script != nil && script.Kind == yaml.SequenceNode && len(script.Content) > 0 {
				v.unsupported("script_shape", "Only a string or flat list of up to 50 nonempty script strings is checked.", script)
			} else {
				v.invalid("script_shape", "A GitLab shell job requires a nonempty script string or sequence.", job)
			}
		} else {
			summary.StepCount = uint32(len(commands))
		}
		if before := workflowField(job, "before_script"); before != nil {
			setup, valid := workflowScript(before)
			if !valid {
				v.unsupported("before_script_shape", "Job before_script requires a literal string or flat list of up to 50 strings; inheritance and nested lists are unavailable.", before)
			} else {
				summary.StepCount += uint32(len(setup))
			}
		}
		if summary.StepCount > 50 {
			v.unsupported("step_limit", "The shell execution profile accepts at most 50 before_script and script entries combined.", job)
		}
	}
	if len(v.config.Jobs) != 1 {
		v.unsupported("job_graph", "Only one visible job is checked; jobs are not expanded from includes or templates.", root)
	}
}

// Metadata first, at an already resolved immutable commit. Never follows a
// symlink, submodule, LFS target, include, action URL or provider metadata URL.
func (s *Server) workflowContents(ctx context.Context, token forgeCredential, base, commit, requestedPath string, content bool) (contentsEnvelope, error) {
	entry, entries, err := s.sourceObjectAtPath(ctx, base, token, commit, requestedPath)
	if err != nil {
		return contentsEnvelope{}, err
	}
	if entries != nil {
		result := contentsEnvelope{Directory: make([]forgeContents, 0, len(entries))}
		for _, item := range entries {
			result.Directory = append(result.Directory, forgeContents{sourceEntry: item})
		}
		return result, nil
	}
	file := &forgeContents{sourceEntry: entry}
	// Inspection discovers and budgets metadata before fetching any blobs.
	// Unsupported modes and oversize files remain metadata-only in either mode.
	if content && entry.Type == "file" && entry.Size <= maxWorkflowBytes {
		data, err := s.sourceBlob(ctx, base, token, entry)
		if err != nil {
			return contentsEnvelope{}, err
		}
		file.Encoding, file.Content = "base64", base64.StdEncoding.EncodeToString(data)
		if workflowLFSPointer(data) {
			// Keep a real OID when reported by pointer bytes; never invent metadata.
			for _, line := range strings.Split(string(data), "\n") {
				id, ok := strings.CutPrefix(strings.TrimSuffix(line, "\r"), "oid sha256:")
				if ok && len(id) == 64 && objectID.MatchString(id) {
					file.LFSOID = id
					break
				}
			}
		}
	}
	return contentsEnvelope{File: file}, nil
}

func workflowLFSPointer(data []byte) bool {
	return strings.HasPrefix(string(data), "version https://git-lfs.github.com/spec/v1\n") || strings.HasPrefix(string(data), "version https://git-lfs.github.com/spec/v1\r\n")
}

func workflowMissing(err error) bool {
	var upstream forgeError
	return errors.Is(err, errResourceNotFound) || errors.As(err, &upstream) && upstream.status == http.StatusNotFound
}

// Select the first actual directory at the immutable commit, even if empty or
// containing only unsupported files. A failed permission/provider read is never
// interpreted as absence. Parent symlinks and submodules are never followed.
func (s *Server) actionsWorkflowDirectory(ctx context.Context, token forgeCredential, base, commit string) (string, []forgeContents, []*golfv1.WorkflowDiagnostic, error) {
	directories, err := workflowpath.Directories(s.config.ForgeWorkflowDirs)
	if err != nil {
		return "", nil, nil, errWorkflowExecutionUnsupported
	}
	var diagnostics []*golfv1.WorkflowDiagnostic
	var selected string
	var entries []forgeContents
	for _, directory := range directories {
		parent, _, _ := strings.Cut(directory, "/")
		root, err := s.workflowContents(ctx, token, base, commit, parent, false)
		if workflowMissing(err) {
			continue
		}
		if err != nil {
			return "", nil, nil, err
		}
		if root.File != nil {
			diagnostics = append(diagnostics, workflowDiagnostic("actions_location", parent+" is not an ordinary directory; no target is followed.", nil))
			continue
		}
		for _, entry := range root.Directory {
			if entry.Name != "workflows" {
				continue
			}
			if entry.Type != "dir" {
				diagnostics = append(diagnostics, workflowDiagnostic("actions_location", directory+" is not an ordinary directory; no target is followed.", nil))
				break
			}
			if selected != "" {
				diagnostics = append(diagnostics, workflowDiagnostic("actions_shadowed", directory+" is shadowed by the selected "+selected+" directory; its workflows will not execute.", nil))
				break
			}
			contents, err := s.workflowContents(ctx, token, base, commit, directory, false)
			if err != nil {
				return "", nil, nil, err
			}
			if contents.File != nil {
				return "", nil, nil, errInvalidForgeResponse
			}
			if s.config.ForgeKind != "forgejo" {
				return directory, contents.Directory, diagnostics, nil
			}
			selected, entries = directory, contents.Directory
			break
		}
	}
	return selected, entries, diagnostics, nil
}

func workflowBlobMatches(data []byte, expected string) bool {
	object := append([]byte("blob "+strconv.Itoa(len(data))+"\x00"), data...)
	if len(expected) == 40 {
		digest := sha1.Sum(object)
		return hex.EncodeToString(digest[:]) == expected
	}
	digest := sha256.Sum256(object)
	return len(expected) == 64 && hex.EncodeToString(digest[:]) == expected
}

// Only the native owner identity/kind is needed for required-scope ceilings.
// This projection does not require native write/admin permission and exposes no
// selected repository inventory. The enclosing read boundary checks the caller.
type workflowOwnerBinding struct {
	ownerID      int64
	organization bool
}

func (s *Server) workflowOwner(ctx context.Context, token forgeCredential, base string, repo Repository) (workflowOwnerBinding, error) {
	var row struct {
		Repository
		Owner *User `json:"owner"`
	}
	if _, err := s.forge(ctx, http.MethodGet, base, token, nil, &row); err != nil {
		return workflowOwnerBinding{}, err
	}
	owner, _, ok := strings.Cut(repo.FullName, "/")
	if !ok || row.ID != repo.ID || !strings.EqualFold(row.FullName, repo.FullName) || row.Owner == nil || row.Owner.ID <= 0 || !validOrganizationName(row.Owner.Login) || !strings.EqualFold(row.Owner.Login, owner) {
		return workflowOwnerBinding{}, errInvalidForgeResponse
	}
	organization, err := s.repositoryOwnerKind(ctx, token, *row.Owner)
	return workflowOwnerBinding{row.Owner.ID, organization}, err
}

// This is a policy observation, not executable authority. A single read-only
// database snapshot covers all paths and both event kinds; source/native policy
// changes after it are re-admitted by the separate execution writers.
func (s *Server) observeWorkflowPolicies(ctx context.Context, repositoryID int64, owner workflowOwnerBinding, result *golfv1.InspectWorkflowsResponse) error {
	if s.db == nil {
		return errStorageUnavailable
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	states, epochs, err := s.readExecutionPolicyStates(ctx, tx, repositoryID, owner.ownerID, owner.organization, false)
	if err != nil {
		return err
	}
	// Complete/close the read before releasing any known flags. Commit failure
	// leaves the entire observation unknown; no partial row results are returned.
	if err = tx.Commit(); err != nil {
		return errStorageUnavailable
	}
	data, err := json.Marshal(epochs)
	if err != nil {
		return errStorageUnavailable
	}
	digest := sha256.Sum256(data)
	result.PolicyRevision = hex.EncodeToString(digest[:])
	for _, config := range result.Configurations {
		manual := executionPoliciesAllow(states, repositoryID, owner.ownerID, owner.organization, "manual", config.Path)
		push := executionPoliciesAllow(states, repositoryID, owner.ownerID, owner.organization, "push", config.Path)
		config.ManualPolicyAllowed, config.PushPolicyAllowed = &manual, &push
	}
	return nil
}

func (s *Server) InspectWorkflows(ctx context.Context, req *connect.Request[golfv1.InspectWorkflowsRequest]) (*connect.Response[golfv1.InspectWorkflowsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated {
		return nil, rpcError(errApiCredentialReadOnly)
	}
	if !validRef(req.Msg.Ref) {
		return nil, rpcError(invalid("Select a branch, tag or full commit ID, not a revision expression."))
	}
	var expectedID int64
	if req.Msg.RepositoryId != "" {
		expectedID, err = strconv.ParseInt(req.Msg.RepositoryId, 10, 64)
		if err != nil || expectedID <= 0 || strconv.FormatInt(expectedID, 10) != req.Msg.RepositoryId {
			return nil, rpcError(invalid("Select a positive canonical repository ID."))
		}
	}
	result := &golfv1.InspectWorkflowsResponse{CatalogVersion: workflowCatalog, ExecutionAvailable: len(s.runnerKeys) > 0 && len(s.runnerImages) > 0}
	result.ExecutionCatalog = workflowExecutionCatalog
	if s.actionsEngineConfigured() {
		result.ExecutionCatalog = s.config.ActionsEngineCatalog
		result.ExecutionEngineCommit = runner.ActionsEngineCommit
	}
	err = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), func(base string, repo Repository) error {
		if expectedID > 0 && repo.ID != expectedID {
			return errIssueTargetChanged
		}
		if repo.Empty {
			return errEmptyRepository
		}
		owner, err := s.workflowOwner(ctx, token, base, repo)
		if err != nil {
			return err
		}
		commits, _, err := s.readCommits(ctx, base, token, req.Msg.Ref, 1, 1)
		if err != nil {
			return err
		}
		if len(commits) != 1 || objectID.MatchString(req.Msg.Ref) && commits[0].SHA != req.Msg.Ref {
			return errInvalidForgeResponse
		}
		result.RepositoryId, result.CommitId = strconv.FormatInt(repo.ID, 10), commits[0].SHA
		var candidates []forgeContents
		_, entries, diagnostics, err := s.actionsWorkflowDirectory(ctx, token, base, result.CommitId)
		if err != nil {
			return err
		}
		result.Diagnostics = append(result.Diagnostics, diagnostics...)
		for _, entry := range entries {
			if entry.Type == "dir" {
				result.Diagnostics = append(result.Diagnostics, workflowDiagnostic("actions_nested_location", "Nested workflow directories are unsupported by Golf's direct-file profile; use a direct workflow filename.", nil))
				break
			}
		}
		for _, entry := range entries {
			if entry.Type == "dir" {
				continue
			} else if strings.HasSuffix(entry.Name, ".yml") || strings.HasSuffix(entry.Name, ".yaml") {
				candidates = append(candidates, entry)
			}
		}
		gitlab, err := s.workflowContents(ctx, token, base, result.CommitId, ".gitlab-ci.yml", false)
		if err != nil && !workflowMissing(err) {
			return err
		}
		if err == nil {
			if gitlab.File == nil {
				result.Diagnostics = append(result.Diagnostics, workflowDiagnostic("gitlab_location", ".gitlab-ci.yml is a directory; no configuration is read from it.", nil))
			} else {
				candidates = append(candidates, *gitlab.File)
			}
		}
		if len(candidates) > maxWorkflowFiles {
			return errForgeResponseTooLarge
		}
		sort.Slice(candidates, func(i, j int) bool { return candidates[i].Path < candidates[j].Path })
		total := int64(0)
		for _, candidate := range candidates {
			if candidate.Type == "file" && candidate.LFSOID == "" && candidate.Size <= maxWorkflowBytes {
				total += candidate.Size
			}
		}
		if total > maxWorkflowTotalBytes {
			return errForgeResponseTooLarge
		}
		var engineArchive []byte
		for _, candidate := range candidates {
			config := &golfv1.WorkflowConfiguration{Path: candidate.Path, BlobId: candidate.SHA, ByteSize: uint64(candidate.Size), Format: golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS}
			if candidate.Path == ".gitlab-ci.yml" {
				config.Format = golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI
			}
			result.Configurations = append(result.Configurations, config)
			if !executionWorkflowPath(candidate.Path) {
				workflowInspector{config}.unsupported("workflow_path", "This filename is outside Golf's literal workflow path profile; select a direct ASCII filename without globs or traversal.", nil)
				continue
			}
			if candidate.Type != "file" || candidate.LFSOID != "" || candidate.Size > maxWorkflowBytes {
				workflowInspector{config}.unsupported("source_unavailable", "Only ordinary non-LFS files of at most 64 KiB are inspected; no target is followed.", nil)
				continue
			}
			content, err := s.workflowContents(ctx, token, base, result.CommitId, candidate.Path, true)
			if err != nil {
				return err
			}
			if content.File == nil || content.File.sourceEntry != candidate.sourceEntry || content.File.Encoding != "base64" {
				return errInvalidForgeResponse
			}
			if content.File.LFSOID != "" {
				workflowInspector{config}.unsupported("lfs", "Git LFS configurations are not downloaded or inspected.", nil)
				continue
			}
			if len(content.File.Content) > base64.StdEncoding.EncodedLen(maxWorkflowBytes)+2048 {
				return errForgeResponseTooLarge
			}
			data, err := base64.StdEncoding.DecodeString(content.File.Content)
			if err != nil || int64(len(data)) != candidate.Size || len(data) > maxWorkflowBytes || !workflowBlobMatches(data, candidate.SHA) {
				return errInvalidForgeResponse
			}
			if workflowLFSPointer(data) {
				workflowInspector{config}.unsupported("lfs", "Git LFS pointers are not downloaded or inspected.", nil)
				continue
			}
			var manualSchema *workflowDispatchInputSchema
			if config.Format == golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS {
				if parsed, e := parseWorkflowDispatchInputs(data); e == nil {
					manualSchema = &parsed
					config.ManualInputs = workflowDispatchDefinitionsWire(parsed)
					config.ManualInputsSchemaSha256 = parsed.SHA256
				}
			}
			if s.actionsEngineConfigured() && config.Format == golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS {
				if engineArchive == nil {
					engineArchive, err = s.workflowSource(ctx, token, base, result.CommitId, "", "", nil)
					if err != nil {
						return err
					}
				}
				var plan *runner.ActionPlan
				var e error
				if s.config.ActionsEngineCatalog == runner.ActionsInputsCatalog && manualSchema != nil && len(manualSchema.Definitions) > 0 {
					plan, e = s.planActionsInput(ctx, runner.ActionPlanInput{Catalog: runner.ActionsInputsCatalog, WorkflowPath: candidate.Path, WorkflowBlobID: candidate.SHA, Archive: engineArchive, Event: "inspect", Ref: result.CommitId, Images: s.runnerImages, ManualInputsContract: runner.ManualInputsCapability, ManualInputsSchemaSHA256: manualSchema.SHA256})
				} else {
					plan, e = s.planActions(ctx, candidate.Path, candidate.SHA, "inspect", "", engineArchive)
				}
				if e == nil {
					e = s.verifyActionSources(ctx, base, token, result.CommitId, plan)
				}
				if e != nil {
					if !errors.Is(e, errActionsProfile) {
						// Planner/provider downtime and authority failures are not
						// semantic incompatibility. Do not cache a false refusal.
						return e
					}
					inspectWorkflow(config, data)
					if config.State != golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_INVALID {
						config.State = golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_UNSUPPORTED
					}
					if len(config.Diagnostics) >= maxWorkflowDiagnostics {
						config.Diagnostics = config.Diagnostics[:maxWorkflowDiagnostics-1]
					}
					config.Diagnostics = append(config.Diagnostics, workflowDiagnostic("engine_profile", "Selected profile "+s.config.ActionsEngineCatalog+" does not admit this source. Use supported syntax or native provider CI; no execution or dependency download occurred.", nil))
				} else {
					config.State = golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET
					config.Events = plan.Events
					if plan.Catalog == runner.ActionsInputsCatalog && manualSchema != nil && len(manualSchema.Definitions) > 0 {
						for _, event := range plan.Events {
							if event == "push" {
								config.Diagnostics = append(config.Diagnostics, workflowDiagnostic("manual_inputs_push_unsupported", "Typed parameters support manual dispatch only; automatic push execution of this input-declaring workflow is not supported by the current catalog.", nil))
							}
						}
					}
					seen := map[string]bool{}
					for _, job := range plan.Jobs {
						if seen[job.JobID] {
							continue
						}
						seen[job.JobID] = true
						config.Jobs = append(config.Jobs, &golfv1.WorkflowJobSummary{Id: job.JobID, Name: job.Name, StepCount: uint32(len(job.Steps))})
					}
				}
			} else {
				inspectWorkflow(config, data)
			}
		}
		if err := s.observeWorkflowPolicies(ctx, repo.ID, owner, result); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			result.Diagnostics = append(result.Diagnostics, workflowDiagnostic("policy_unavailable", "Execution policy observations are unavailable. Inspect current policies before attempting execution.", nil))
		}
		after, err := s.workflowOwner(ctx, token, base, repo)
		if err != nil {
			return err
		}
		if after != owner {
			return errIssueTargetChanged
		}
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

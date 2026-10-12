// Package actionsengine admits and executes one explicit pinned Linux profile.
// It delegates graph/expression semantics to act, not to a Golf reimplementation.
package actionsengine

import (
	"archive/tar"
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/workflowinputs"
	"github.com/nektos/act/pkg/model"
	"github.com/rhysd/actionlint"
	"gopkg.in/yaml.v3"
)

var ErrProfile = errors.New("workflow is outside the selected Actions engine profile")
var ErrEvent = errors.New("workflow does not match the selected event")
var keyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`)
var digestPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$`)
var fullObjectPattern = regexp.MustCompile(`^([a-f0-9]{40}|[a-f0-9]{64})$`)

type file struct {
	body      []byte
	mode      int64
	directory bool
}

func sourceFiles(archive []byte) (map[string]file, error) { return archiveFiles(archive, false) }

func archiveFiles(archive []byte, actionLinks bool) (map[string]file, error) {
	if len(archive) == 0 || len(archive) > 16<<20 {
		return nil, ErrProfile
	}
	input := bytes.NewReader(archive)
	tr := tar.NewReader(input)
	files := map[string]file{}
	var total int64
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, ErrProfile
		}
		name := strings.TrimSuffix(h.Name, "/")
		if !safePath(name) || (h.Linkname != "" && (!actionLinks || h.Typeflag != tar.TypeSymlink || len(h.Linkname) > 1024 || strings.HasPrefix(h.Linkname, "/") || !safePath(path.Clean(path.Join(path.Dir(name), h.Linkname))))) || !ordinaryPAX(h) || (h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA && h.Typeflag != tar.TypeDir && (!actionLinks || h.Typeflag != tar.TypeSymlink)) || h.Size < 0 || h.Size > 8<<20 || h.Typeflag == tar.TypeDir && h.Size != 0 || len(files) >= 4096 {
			return nil, ErrProfile
		}
		if _, exists := files[name]; exists {
			return nil, ErrProfile
		}
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if old, exists := files[parent]; exists && !old.directory {
				return nil, ErrProfile
			}
		}
		if h.Typeflag != tar.TypeDir {
			for previous := range files {
				if strings.HasPrefix(previous, name+"/") {
					return nil, ErrProfile
				}
			}
		}
		total += h.Size
		if total > 16<<20 {
			return nil, ErrProfile
		}
		body, err := io.ReadAll(io.LimitReader(tr, h.Size+1))
		if err != nil || int64(len(body)) != h.Size {
			return nil, ErrProfile
		}
		mode := h.Mode & 0777
		if h.Typeflag == tar.TypeSymlink {
			if h.Size != 0 {
				return nil, ErrProfile
			}
			body = []byte(h.Linkname)
			mode = 0120000
		}
		files[name] = file{body, mode, h.Typeflag == tar.TypeDir}
	}
	padding, err := io.ReadAll(input)
	if err != nil || len(bytes.Trim(padding, "\x00")) != 0 {
		return nil, ErrProfile
	}
	return files, nil
}

// The server normalizer can emit a canonical PAX path for UTF-8/long names.
// No arbitrary extended metadata, links or independent path interpretation.
func ordinaryPAX(h *tar.Header) bool {
	return len(h.PAXRecords) == 0 || len(h.PAXRecords) == 1 && h.PAXRecords["path"] == h.Name
}
func safePath(value string) bool {
	if value == "" || value == "." || len(value) > 1024 || path.Clean(value) != value || strings.HasPrefix(value, "/") || strings.Contains(value, "\\") || !utf8.ValidString(value) || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." || part == ".git" {
			return false
		}
	}
	return true
}
func field(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}
func mapping(n *yaml.Node, allowed ...string) bool {
	if n == nil || n.Kind != yaml.MappingNode {
		return false
	}
	for i := 0; i < len(n.Content); i += 2 {
		found := false
		for _, key := range allowed {
			found = found || n.Content[i].Value == key
		}
		if !found {
			return false
		}
	}
	return true
}
func scalar(n *yaml.Node) bool {
	return n != nil && n.Kind == yaml.ScalarNode && n.Tag == "!!str" && utf8.ValidString(n.Value)
}
func tree(data []byte) (*yaml.Node, error) {
	if len(data) == 0 || len(data) > 64<<10 || !utf8.Valid(data) {
		return nil, ErrProfile
	}
	d := yaml.NewDecoder(bytes.NewReader(data))
	var doc, extra yaml.Node
	if d.Decode(&doc) != nil || len(doc.Content) != 1 || d.Decode(&extra) != io.EOF {
		return nil, ErrProfile
	}
	nodes := 0
	var bounded func(*yaml.Node, int) bool
	bounded = func(n *yaml.Node, depth int) bool {
		nodes++
		if nodes > 4096 || depth > 24 || n.Kind == yaml.AliasNode || n.Anchor != "" || n.Style&yaml.TaggedStyle != 0 || n.Tag == "!!merge" || len(n.Value) > 16<<10 || strings.IndexFunc(n.Value, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) >= 0 {
			return false
		}
		if n.Kind == yaml.MappingNode {
			seen := map[string]bool{}
			if len(n.Content)%2 != 0 {
				return false
			}
			for i := 0; i < len(n.Content); i += 2 {
				key := n.Content[i]
				if !scalar(key) || key.Value == "" || seen[key.Value] {
					return false
				}
				seen[key.Value] = true
			}
		}
		for _, child := range n.Content {
			if !bounded(child, depth+1) {
				return false
			}
		}
		return true
	}
	if !bounded(&doc, 0) {
		return nil, ErrProfile
	}
	return doc.Content[0], nil
}
func env(n *yaml.Node) bool {
	if n == nil {
		return true
	}
	if n.Kind != yaml.MappingNode || len(n.Content) > 128 {
		return false
	}
	for i := 0; i < len(n.Content); i += 2 {
		key := n.Content[i].Value
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`).MatchString(key) || strings.HasPrefix(key, "GOLF_") || strings.HasPrefix(key, "DOCKER_") || strings.HasPrefix(key, "GITHUB_") || strings.HasPrefix(key, "RUNNER_") || strings.HasPrefix(key, "ACT_") || !scalar(n.Content[i+1]) {
			return false
		}
	}
	return true
}
func defaults(n *yaml.Node) bool {
	if n == nil {
		return true
	}
	if !mapping(n, "run") {
		return false
	}
	run := field(n, "run")
	return mapping(run, "shell") && scalar(field(run, "shell")) && (field(run, "shell").Value == "sh" || field(run, "shell").Value == "bash")
}
func staticMatrix(n *yaml.Node) bool {
	if n == nil {
		return true
	}
	if !mapping(n, "fail-fast", "max-parallel", "matrix") {
		return false
	}
	if v := field(n, "fail-fast"); v != nil && (v.Tag != "!!bool" || (v.Value != "true" && v.Value != "false")) {
		return false
	}
	if v := field(n, "max-parallel"); v != nil {
		count, err := strconv.Atoi(v.Value)
		if v.Tag != "!!int" || err != nil || count < 1 || count > 2 {
			return false
		}
	}
	m := field(n, "matrix")
	if m == nil {
		return true
	}
	if m.Kind != yaml.MappingNode || len(m.Content) > 16 {
		return false
	}
	product, includes := 1, 0
	for i := 0; i < len(m.Content); i += 2 {
		key, values := m.Content[i].Value, m.Content[i+1]
		if !keyPattern.MatchString(key) || values.Kind != yaml.SequenceNode || len(values.Content) > 8 {
			return false
		}
		if key == "include" || key == "exclude" {
			if len(values.Content) > 8 {
				return false
			}
			for _, value := range values.Content {
				if value.Kind != yaml.MappingNode || len(value.Content) > 16 {
					return false
				}
				for j := 0; j < len(value.Content); j += 2 {
					if !keyPattern.MatchString(value.Content[j].Value) || !matrixScalar(value.Content[j+1]) {
						return false
					}
				}
			}
			if key == "include" {
				includes = len(values.Content)
			}
		} else {
			if len(values.Content) == 0 || product > 12/len(values.Content) {
				return false
			}
			product *= len(values.Content)
			for _, v := range values.Content {
				if !matrixScalar(v) {
					return false
				}
			}
		}
	}
	return product+includes <= 12
}
func matrixScalar(n *yaml.Node) bool {
	return n.Kind == yaml.ScalarNode && (n.Tag == "!!str" || n.Tag == "!!bool" || n.Tag == "!!int") && len(n.Value) <= 255 && !strings.Contains(n.Value, "${{")
}

// Plan derives identities from the actual pinned planner/matrix implementation.
// Expansion is prebounded before GetMatrixes, and duplicate indistinguishable
// instances refuse rather than making callback identity ambiguous.
func Plan(input protocol.ActionPlanInput) (protocol.ActionPlan, error) {
	p, _, _, err := admit(input)
	return p, err
}
func admit(input protocol.ActionPlanInput) (protocol.ActionPlan, *model.Plan, map[string]file, error) {
	out := protocol.ActionPlan{}
	typed := input.Catalog == protocol.ActionsInputsCatalog
	agents := input.Catalog == protocol.ActionsAgentCatalog
	remote := input.Catalog == protocol.ActionsRemoteCatalog
	if (input.Catalog != protocol.ActionsCatalog && !typed && !agents && !remote) || agents && input.Event == "push" || !safePath(input.WorkflowPath) || !fullObjectPattern.MatchString(input.WorkflowBlobID) || (input.Event != "workflow_dispatch" && input.Event != "push" && input.Event != "inspect") || input.Event == "push" && (!strings.HasPrefix(input.Ref, "refs/heads/") || !safePath(strings.TrimPrefix(input.Ref, "refs/heads/"))) || len(input.Images) < 1 || len(input.Images) > 20 {
		return out, nil, nil, ErrProfile
	}
	for label, image := range input.Images {
		if (!keyPattern.MatchString(label) && (!remote || !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`).MatchString(label))) || !digestPattern.MatchString(image) {
			return out, nil, nil, ErrProfile
		}
	}
	remoteActions, remoteErr := admitRemoteActions(input)
	if remoteErr != nil {
		return out, nil, nil, remoteErr
	}
	files, err := archiveFiles(input.Archive, remote)
	if remote && protocol.ValidateGitSourceArchive(input.Archive) != nil {
		return out, nil, nil, ErrProfile
	}
	if err != nil {
		return out, nil, nil, err
	}
	workflow, ok := files[input.WorkflowPath]
	if !ok || workflow.directory || workflow.mode == 0120000 || !blobMatches(workflow.body, input.WorkflowBlobID) {
		return out, nil, nil, ErrProfile
	}
	root, err := tree(workflow.body)
	if err != nil || !mapping(root, "name", "on", "env", "defaults", "jobs", "permissions") || !env(field(root, "env")) || !defaults(field(root, "defaults")) {
		return out, nil, nil, ErrProfile
	}
	if permissions := field(root, "permissions"); permissions != nil {
		if !remote || !mapping(permissions, "contents") || !scalar(field(permissions, "contents")) || field(permissions, "contents").Value != "read" {
			return out, nil, nil, ErrProfile
		}
	}
	if typed {
		if input.ManualInputsContract != protocol.ManualInputsCapability || !fullObjectPattern.MatchString(input.Ref) || (input.Event != "workflow_dispatch" && input.Event != "inspect") {
			return out, nil, nil, ErrProfile
		}
		schema, e := workflowinputs.Parse(workflow.body)
		if e != nil || schema.SHA256 != input.ManualInputsSchemaSHA256 {
			return out, nil, nil, ErrProfile
		}
	} else if input.ManualInputsContract != "" || input.ManualInputsSchemaSHA256 != "" {
		return out, nil, nil, ErrProfile
	}
	// V1 keeps its original refusal. V2 validates actual expression ASTs and
	// their source positions, permitting only the bounded input namespaces.
	if err = validateExpressions(root, false, typed); err != nil {
		return out, nil, nil, err
	}
	matched, err := eventMatches(field(root, "on"), input.Event, input.Ref, typed, remote)
	if err != nil {
		return out, nil, nil, err
	}
	if !matched && input.Event != "inspect" {
		return out, nil, nil, ErrEvent
	}
	jobs := field(root, "jobs")
	if jobs == nil || jobs.Kind != yaml.MappingNode || len(jobs.Content) < 2 || len(jobs.Content) > 16 {
		return out, nil, nil, ErrProfile
	}
	dependencies := map[string]string{}
	aggregateSteps := 0
	expandedSteps := map[string]int{}
	for i := 0; i < len(jobs.Content); i += 2 {
		id, j := jobs.Content[i].Value, jobs.Content[i+1]
		if !keyPattern.MatchString(id) || !mapping(j, "name", "needs", "runs-on", "steps", "strategy", "env", "outputs", "if", "defaults", "timeout-minutes") || !env(field(j, "env")) || !defaults(field(j, "defaults")) || !staticMatrix(field(j, "strategy")) {
			return out, nil, nil, ErrProfile
		}
		if strategy := field(j, "strategy"); field(strategy, "matrix") != nil {
			failFast := field(strategy, "fail-fast")
			// Native shared-matrix aggregate output/cancellation semantics are
			// not part of this first per-instance completion contract.
			if failFast == nil || failFast.Tag != "!!bool" || failFast.Value != "false" || field(j, "outputs") != nil {
				return out, nil, nil, ErrProfile
			}
		}
		if timeout := field(j, "timeout-minutes"); timeout != nil {
			if !remote || timeout.Tag != "!!int" {
				return out, nil, nil, ErrProfile
			}
			minutes, e := strconv.Atoi(timeout.Value)
			if e != nil || minutes < 1 || minutes > 15 {
				return out, nil, nil, ErrProfile
			}
		}
		label := field(j, "runs-on")
		if !scalar(label) || input.Images[label.Value] == "" || strings.Contains(label.Value, "${{") {
			return out, nil, nil, ErrProfile
		}
		steps := field(j, "steps")
		if steps == nil || steps.Kind != yaml.SequenceNode || len(steps.Content) < 1 || len(steps.Content) > 32 {
			return out, nil, nil, ErrProfile
		}
		aggregateSteps += len(steps.Content)
		if aggregateSteps > 64 {
			return out, nil, nil, ErrProfile
		}
		expanded := 0
		if err = validateSteps(steps, files, dependencies, nil, 0, false, typed, agents, &expanded, remoteActions); err != nil {
			return out, nil, nil, err
		}
		expandedSteps[id] = expanded
	}
	w, err := model.ReadWorkflow(bytes.NewReader(workflow.body), true)
	if err != nil {
		return out, nil, nil, ErrProfile
	}
	planner, err := model.NewSingleWorkflowPlanner(input.WorkflowPath, bytes.NewReader(workflow.body))
	if err != nil {
		return out, nil, nil, ErrProfile
	}
	plan, err := planner.PlanAll()
	if input.Event != "inspect" {
		plan, err = planner.PlanEvent(input.Event)
	}
	if err != nil || len(plan.Stages) == 0 {
		return out, nil, nil, ErrProfile
	}
	seen := map[string]bool{}
	runtimeNames := map[string]bool{}
	totalSteps := 0
	for _, stage := range plan.Stages {
		sort.Slice(stage.Runs, func(i, j int) bool { return stage.Runs[i].JobID < stage.Runs[j].JobID })
		for _, run := range stage.Runs {
			job := w.Jobs[run.JobID]
			variants, e := job.GetMatrixes()
			if e != nil || len(variants) > 12 {
				return out, nil, nil, ErrProfile
			}
			// The native Cartesian product traverses maps. Admission order must not
			// depend on process-local map iteration; tuple identity is canonical.
			sort.Slice(variants, func(i, j int) bool {
				a, _ := json.Marshal(variants[i])
				b, _ := json.Marshal(variants[j])
				return string(a) < string(b)
			})
			for variantIndex, matrix := range variants {
				encoded, e := json.Marshal(matrix)
				if e != nil {
					return out, nil, nil, ErrProfile
				}
				h := sha256.Sum256(append([]byte(run.JobID+"\x00"), encoded...))
				instance := hex.EncodeToString(h[:16])
				if seen[instance] {
					return out, nil, nil, ErrProfile
				}
				seen[instance] = true
				name := job.Name
				if name == "" {
					name = run.JobID
				}
				if len(name) > 255 || strings.Contains(name, "${{") {
					return out, nil, nil, ErrProfile
				}
				nativeName := name
				if len(variants) > 1 {
					nativeName += "-" + strconv.Itoa(variantIndex+1)
				}
				// Pinned act's container/volume namespace is derived from display
				// names after this sanitization, not from native job IDs.
				runtimeName := regexp.MustCompile(`[^a-zA-Z0-9]`).ReplaceAllString("act-"+w.Name+"/"+nativeName, "-")
				runtimeName = strings.ReplaceAll(runtimeName, "--", "-")
				if runtimeNames[runtimeName] {
					return out, nil, nil, ErrProfile
				}
				runtimeNames[runtimeName] = true
				entry := protocol.ActionJob{InstanceID: instance, JobID: run.JobID, Name: name, Image: input.Images[job.RawRunsOn.Value], Needs: job.Needs()}
				if timeout := field(field(jobs, run.JobID), "timeout-minutes"); timeout != nil {
					minutes, _ := strconv.Atoi(timeout.Value)
					entry.TimeoutSeconds = uint32(minutes * 60)
				}
				for key, value := range matrix {
					b, e := json.Marshal(value)
					if e != nil {
						return out, nil, nil, ErrProfile
					}
					entry.Matrix = append(entry.Matrix, protocol.ActionMatrixEntry{Name: key, Value: string(b)})
				}
				sort.Slice(entry.Matrix, func(i, j int) bool { return entry.Matrix[i].Name < entry.Matrix[j].Name })
				stepIDs := map[string]bool{}
				for index, step := range job.Steps {
					sid := step.ID
					if sid == "" {
						sid = strconv.Itoa(index)
					}
					if !stepIdentifier(sid) || stepIDs[sid] {
						return out, nil, nil, ErrProfile
					}
					stepIDs[sid] = true
					sname := step.Name
					if sname == "" {
						sname = "Step " + strconv.Itoa(index+1)
					}
					if len(sname) > 255 || strings.Contains(sname, "${{") {
						return out, nil, nil, ErrProfile
					}
					prompt := ""
					if step.Uses == protocol.WorkflowAgentAction {
						prompt = step.With["prompt"]
					}
					entry.Steps = append(entry.Steps, protocol.ActionStep{ID: sid, Name: sname, AgentPrompt: prompt})
				}
				totalSteps += expandedSteps[run.JobID]
				if totalSteps > 128 || len(out.Jobs) >= 12 {
					return out, nil, nil, ErrProfile
				}
				out.Jobs = append(out.Jobs, entry)
			}
		}
	}
	for name, sum := range dependencies {
		out.LocalActions = append(out.LocalActions, protocol.ActionDependency{MetadataPath: name, MetadataSHA256: sum})
	}
	sort.Slice(out.LocalActions, func(i, j int) bool { return out.LocalActions[i].MetadataPath < out.LocalActions[j].MetadataPath })
	depJSON, _ := json.Marshal(dependencies)
	if remote {
		for _, action := range remoteActions {
			out.RemoteActions = append(out.RemoteActions, action.identity)
		}
		sort.Slice(out.RemoteActions, func(i, j int) bool { return out.RemoteActions[i].Uses < out.RemoteActions[j].Uses })
		depJSON, _ = json.Marshal(struct {
			Local  map[string]string               `json:"local"`
			Remote []protocol.ActionRemoteIdentity `json:"remote"`
		}{dependencies, out.RemoteActions})
	}
	depSHA := sha256.Sum256(depJSON)
	archiveSHA := sha256.Sum256(input.Archive)
	out.Catalog = input.Catalog
	out.ManualInputsContract = input.ManualInputsContract
	out.ManualInputsSchemaSHA256 = input.ManualInputsSchemaSHA256
	out.EngineCommit = protocol.ActionsEngineCommit
	out.WorkflowPath = input.WorkflowPath
	out.WorkflowBlobID = input.WorkflowBlobID
	out.ArchiveSHA256 = hex.EncodeToString(archiveSHA[:])
	out.Events = planner.GetEvents()
	sort.Strings(out.Events)
	out.Event = input.Event
	out.Ref = input.Ref
	out.ActionsSHA256 = hex.EncodeToString(depSHA[:])
	return out, plan, files, nil
}
func stepIdentifier(s string) bool {
	return keyPattern.MatchString(s) || regexp.MustCompile(`^(0|[1-9][0-9]{0,2})$`).MatchString(s)
}
func blobMatches(data []byte, id string) bool {
	input := append([]byte(fmt.Sprintf("blob %d\x00", len(data))), data...)
	if len(id) == 40 {
		h := sha1.Sum(input)
		return hex.EncodeToString(h[:]) == id
	}
	h := sha256.Sum256(input)
	return hex.EncodeToString(h[:]) == id
}

func eventMatches(n *yaml.Node, event, ref string, typed bool, remote bool) (bool, error) {
	if n == nil {
		return false, ErrProfile
	}
	if scalar(n) {
		if n.Value != "push" && n.Value != "workflow_dispatch" {
			return false, ErrProfile
		}
		return n.Value == event, nil
	}
	if n.Kind == yaml.SequenceNode {
		matched := false
		seen := map[string]bool{}
		for _, v := range n.Content {
			if !scalar(v) || (v.Value != "push" && v.Value != "workflow_dispatch" && (!remote || v.Value != "pull_request")) || seen[v.Value] {
				return false, ErrProfile
			}
			seen[v.Value] = true
			matched = matched || v.Value == event
		}
		return matched, nil
	}
	if !mapping(n, "push", "workflow_dispatch") {
		return false, ErrProfile
	}
	declaration := field(n, event)
	for i := 0; i < len(n.Content); i += 2 {
		e, v := n.Content[i].Value, n.Content[i+1]
		if v.Kind == yaml.ScalarNode && v.Tag == "!!null" {
			continue
		}
		if e == "workflow_dispatch" {
			if !typed && (!mapping(v) || len(v.Content) != 0) {
				return false, ErrProfile
			}
			continue
		}
		if !mapping(v, "branches") {
			return false, ErrProfile
		}
		if branches := field(v, "branches"); branches != nil {
			if branches.Kind != yaml.SequenceNode || len(branches.Content) < 1 || len(branches.Content) > 20 {
				return false, ErrProfile
			}
			for _, b := range branches.Content {
				if !scalar(b) || !safePath(b.Value) || strings.ContainsAny(b.Value, "*?[]!+{") {
					return false, ErrProfile
				}
			}
		}
	}
	if declaration == nil {
		return false, nil
	}
	if event == "push" {
		if branches := field(declaration, "branches"); branches != nil {
			for _, b := range branches.Content {
				if ref == "refs/heads/"+b.Value {
					return true, nil
				}
			}
			return false, nil
		}
	}
	return true, nil
}
func validateExpressions(n *yaml.Node, composite, typed bool) error {
	if typed {
		return validateTypedExpressions(n, composite, nil)
	}
	if strings.Contains(n.Value, "${{") {
		for _, bad := range []string{"github", "runner", "secrets", "vars", "strategy"} {
			if regexp.MustCompile(`\b` + bad + `\b`).MatchString(n.Value) {
				return ErrProfile
			}
		}
		if !composite && regexp.MustCompile(`\binputs\b`).MatchString(n.Value) {
			return ErrProfile
		}
	}
	for _, c := range n.Content {
		if err := validateExpressions(c, composite, false); err != nil {
			return err
		}
	}
	return nil
}

func expressionPosition(parts []string, composite bool) bool {
	if composite {
		if len(parts) == 3 && ((parts[0] == "inputs" && parts[2] == "default") || (parts[0] == "outputs" && parts[2] == "value")) {
			return true
		}
		if len(parts) >= 4 && parts[0] == "runs" && parts[1] == "steps" {
			return len(parts) == 4 && (parts[3] == "run" || parts[3] == "if") || len(parts) == 5 && (parts[3] == "env" || parts[3] == "with")
		}
		return false
	}
	if len(parts) == 2 && parts[0] == "env" {
		return true
	}
	if len(parts) >= 3 && parts[0] == "jobs" {
		if len(parts) == 3 && parts[2] == "if" || len(parts) == 4 && (parts[2] == "env" || parts[2] == "outputs") {
			return true
		}
		if len(parts) >= 5 && parts[2] == "steps" {
			return len(parts) == 5 && (parts[4] == "run" || parts[4] == "if") || len(parts) == 6 && (parts[4] == "env" || parts[4] == "with")
		}
	}
	return false
}

func validateTypedExpressions(n *yaml.Node, composite bool, parts []string) error {
	// Dispatch declarations are literal data independently admitted by Parse;
	// they are not evaluator positions. No submitted values enter this walk.
	if !composite && len(parts) == 3 && parts[0] == "on" && parts[1] == "workflow_dispatch" && parts[2] == "inputs" {
		return nil
	}
	if n.Kind == yaml.MappingNode {
		for i := 0; i < len(n.Content); i += 2 {
			if strings.Contains(n.Content[i].Value, "${{") || validateTypedExpressions(n.Content[i+1], composite, append(append([]string{}, parts...), n.Content[i].Value)) != nil {
				return ErrProfile
			}
		}
		return nil
	}
	if n.Kind == yaml.SequenceNode {
		for i, child := range n.Content {
			if validateTypedExpressions(child, composite, append(append([]string{}, parts...), strconv.Itoa(i))) != nil {
				return ErrProfile
			}
		}
		return nil
	}
	value := n.Value
	if len(parts) > 0 && parts[len(parts)-1] == "if" && !strings.Contains(value, "${{") && strings.TrimSpace(value) != "" {
		if !expressionPosition(parts, composite) {
			return ErrProfile
		}
		value = "${{ " + value + " }}"
	}
	for {
		index := strings.Index(value, "${{")
		if index < 0 {
			return nil
		}
		if !expressionPosition(parts, composite) {
			return ErrProfile
		}
		remaining := value[index+3:]
		lexer := actionlint.NewExprLexer(remaining)
		node, err := actionlint.NewExprParser().Parse(lexer)
		if err != nil || lexer.Offset() < 2 || lexer.Offset() > len(remaining) || !strings.HasSuffix(remaining[:lexer.Offset()], "}}") || !inputExpressionAST(node) {
			return ErrProfile
		}
		value = remaining[lexer.Offset():]
	}
}

func inputExpressionAST(root actionlint.ExprNode) bool {
	parents := map[actionlint.ExprNode]actionlint.ExprNode{}
	count := 0
	actionlint.VisitExprNode(root, func(node, parent actionlint.ExprNode, entering bool) {
		if entering {
			parents[node] = parent
			count++
		}
	})
	if count > 512 {
		return false
	}
	valid := true
	actionlint.VisitExprNode(root, func(node, _ actionlint.ExprNode, entering bool) {
		if !entering {
			return
		}
		switch n := node.(type) {
		case *actionlint.VariableNode:
			switch n.Name {
			case "inputs", "env", "job", "steps", "matrix", "needs":
			case "github":
				var properties []string
				for top := node; parents[top] != nil; {
					switch parent := parents[top].(type) {
					case *actionlint.ObjectDerefNode:
						if parent.Receiver != top {
							break
						}
						properties = append(properties, strings.ToLower(parent.Property))
						top = parent
						continue
					case *actionlint.IndexAccessNode:
						index, ok := parent.Index.(*actionlint.StringNode)
						if parent.Operand != top || !ok {
							break
						}
						properties = append(properties, strings.ToLower(index.Value))
						top = parent
						continue
					}
					break
				}
				valid = valid && len(properties) >= 2 && properties[0] == "event" && properties[1] == "inputs"
			default:
				valid = false
			}
		case *actionlint.FuncCallNode:
			switch strings.ToLower(n.Callee) {
			case "contains", "startswith", "endswith", "format", "join", "tojson", "fromjson", "hashfiles", "always", "success", "failure", "cancelled":
			default:
				valid = false
			}
		}
	})
	return valid
}
func validateSteps(steps *yaml.Node, files map[string]file, deps map[string]string, stack map[string]bool, depth int, composite, typed, agents bool, budget *int, remoteActions map[string]*admittedRemoteAction) error {
	if depth > 4 {
		return ErrProfile
	}
	if stack == nil {
		stack = map[string]bool{}
	}
	for _, step := range steps.Content {
		*budget++
		if *budget > 128 {
			return ErrProfile
		}
		if !mapping(step, "id", "name", "run", "shell", "env", "if", "uses", "with") || !env(field(step, "env")) {
			return ErrProfile
		}
		run, uses := field(step, "run"), field(step, "uses")
		if (run == nil) == (uses == nil) {
			return ErrProfile
		}
		if run != nil {
			if !scalar(run) || strings.TrimSpace(run.Value) == "" || len(run.Value) > 16<<10 {
				return ErrProfile
			}
			if shell := field(step, "shell"); shell != nil && (!scalar(shell) || (shell.Value != "sh" && shell.Value != "bash")) {
				return ErrProfile
			}
			if composite && field(step, "shell") == nil {
				return ErrProfile
			}
			if field(step, "with") != nil {
				return ErrProfile
			}
			continue
		}
		if scalar(uses) && remoteActions[uses.Value] != nil {
			if field(step, "shell") != nil || !remoteActionInputs(step, remoteActions[uses.Value]) {
				return ErrProfile
			}
			continue
		}
		if scalar(uses) && uses.Value == protocol.WorkflowAgentAction {
			with := field(step, "with")
			prompt := field(with, "prompt")
			if !agents || composite || !mapping(with, "prompt") || !scalar(prompt) || strings.TrimSpace(prompt.Value) == "" || len(prompt.Value) > 2048 || strings.Contains(prompt.Value, "${{") || field(step, "shell") != nil || field(step, "env") != nil {
				return ErrProfile
			}
			continue
		}
		if !scalar(uses) || !strings.HasPrefix(uses.Value, "./") || !safePath(strings.TrimPrefix(uses.Value, "./")) || field(step, "shell") != nil {
			return ErrProfile
		}
		directory := strings.TrimPrefix(uses.Value, "./")
		// Closed literal mount names; ordinary source paths remain UTF-8.
		if !regexp.MustCompile(`^[A-Za-z0-9_./-]+$`).MatchString(directory) {
			return ErrProfile
		}
		if stack[directory] {
			return ErrProfile
		}
		if len(deps) >= 8 && deps[directory+"/action.yml"] == "" && deps[directory+"/action.yaml"] == "" {
			return ErrProfile
		}
		meta, ok := files[directory+"/action.yml"]
		if !ok {
			meta, ok = files[directory+"/action.yaml"]
		}
		if !ok || meta.directory {
			return ErrProfile
		}
		if _, both := files[directory+"/action.yaml"]; both {
			if _, other := files[directory+"/action.yml"]; other {
				return ErrProfile
			}
		}
		root, err := tree(meta.body)
		if err != nil || !mapping(root, "name", "description", "inputs", "outputs", "runs") || validateExpressions(root, true, typed) != nil {
			return ErrProfile
		}
		runs := field(root, "runs")
		if !mapping(runs, "using", "steps") || !scalar(field(runs, "using")) || field(runs, "using").Value != "composite" {
			return ErrProfile
		}
		children := field(runs, "steps")
		if children == nil || children.Kind != yaml.SequenceNode || len(children.Content) < 1 || len(children.Content) > 16 {
			return ErrProfile
		}
		// Strict native action decoding ensures ignored/unknown metadata cannot
		// silently become accepted merely because it appeared in an allowlist.
		var action model.Action
		if yaml.NewDecoder(bytes.NewReader(meta.body)).Decode(&action) != nil {
			return ErrProfile
		}
		for _, key := range []string{"inputs", "outputs"} {
			m := field(root, key)
			if m == nil {
				continue
			}
			if m.Kind != yaml.MappingNode || len(m.Content) > 32 {
				return ErrProfile
			}
			for i := 0; i < len(m.Content); i += 2 {
				if !keyPattern.MatchString(m.Content[i].Value) {
					return ErrProfile
				}
				allowed := []string{"description", "required", "default"}
				if key == "outputs" {
					allowed = []string{"description", "value"}
				}
				if !mapping(m.Content[i+1], allowed...) {
					return ErrProfile
				}
			}
		}
		if with := field(step, "with"); with != nil {
			if with.Kind != yaml.MappingNode || len(with.Content) > 32 {
				return ErrProfile
			}
			for i := 0; i < len(with.Content); i += 2 {
				if !keyPattern.MatchString(with.Content[i].Value) || !scalar(with.Content[i+1]) {
					return ErrProfile
				}
			}
		}
		h := sha256.Sum256(meta.body)
		metadataPath := directory + "/action.yml"
		if _, exists := files[metadataPath]; !exists {
			metadataPath = directory + "/action.yaml"
		}
		deps[metadataPath] = hex.EncodeToString(h[:])
		stack[directory] = true
		err = validateSteps(children, files, deps, stack, depth+1, true, typed, agents, budget, remoteActions)
		delete(stack, directory)
		if err != nil {
			return err
		}
	}
	return nil
}

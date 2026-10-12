package runner

import (
	"strings"

	"github.com/mjtechguy/golf-git/internal/workflowinputs"
)

// These versioned messages contain source and operator-approved public runtime
// identities. Only the execute envelope may carry explicitly brokered repository
// values; it never carries Golf/native controller credentials. The act dependency stays in the
// separately built engine module.
const ActionsCatalog = "golf.workflow.act.v0.2.89.linux.v1"
const ActionsInputsCatalog = "golf.workflow.act.v0.2.89.linux.v2"
const ActionsAgentCatalog = "golf.workflow.act.v0.2.89.linux.agents088.v1"
const ActionsRemoteCatalog = "golf.workflow.act.v0.2.89.linux.remote-node24.v1"
const WorkflowAgentAction = "golf/agent@v1"
const ManualInputsCapability = "golf.workflow.dispatch.inputs.v1"
const ActionsEngineCommit = "4f411281417e88660bea1c1a1749aa71ae0bd60f"
const ActionsDaemonImage = "docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0"

// This identifies known wire catalogs, not configured availability or authority.
func IsActionsCatalog(c string) bool {
	return c == ActionsCatalog || c == ActionsInputsCatalog || c == ActionsAgentCatalog || c == ActionsRemoteCatalog
}

type ActionPlanInput struct {
	RemoteActions            []ActionBundle    `json:"remoteActions,omitempty"`
	ManualInputsContract     string            `json:"manualInputsContract,omitempty"`
	ManualInputsSchemaSHA256 string            `json:"manualInputsSchemaSha256,omitempty"`
	Catalog                  string            `json:"catalog"`
	WorkflowPath             string            `json:"workflowPath"`
	WorkflowBlobID           string            `json:"workflowBlobId"`
	Archive                  []byte            `json:"archive"`
	Event                    string            `json:"event"`
	Ref                      string            `json:"ref"`
	Images                   map[string]string `json:"images"`
}
type ActionMatrixEntry struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
type ActionStep struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	AgentPrompt string `json:"agentPrompt,omitempty"`
}
type ActionJob struct {
	TimeoutSeconds uint32              `json:"timeoutSeconds,omitempty"`
	InstanceID     string              `json:"instanceId"`
	JobID          string              `json:"jobId"`
	Name           string              `json:"name"`
	Image          string              `json:"image"`
	Matrix         []ActionMatrixEntry `json:"matrix"`
	Needs          []string            `json:"needs"`
	Steps          []ActionStep        `json:"steps"`
}
type ActionDependency struct {
	MetadataPath   string `json:"metadataPath"`
	MetadataSHA256 string `json:"metadataSha256"`
}
type ActionPlan struct {
	RemoteActions            []ActionRemoteIdentity `json:"remoteActions,omitempty"`
	ManualInputsContract     string                 `json:"manualInputsContract,omitempty"`
	ManualInputsSchemaSHA256 string                 `json:"manualInputsSchemaSha256,omitempty"`
	Catalog                  string                 `json:"catalog"`
	EngineCommit             string                 `json:"engineCommit"`
	WorkflowPath             string                 `json:"workflowPath"`
	WorkflowBlobID           string                 `json:"workflowBlobId"`
	ArchiveSHA256            string                 `json:"archiveSha256"`
	Event                    string                 `json:"event"`
	Ref                      string                 `json:"ref"`
	Jobs                     []ActionJob            `json:"jobs"`
	Events                   []string               `json:"events"`
	ActionsSHA256            string                 `json:"actionsSha256"`
	LocalActions             []ActionDependency     `json:"localActions"`
}
type ActionExecutionInput struct {
	JobTLSCA             []byte                  `json:"jobTlsCa,omitempty"`
	DependencyAccess     *ActionDependencyAccess `json:"dependencyAccess,omitempty"`
	JobGit               *JobGitContext          `json:"jobGit,omitempty"`
	GitSource            *GitSourceManifest      `json:"gitSource,omitempty"`
	ManualInputs         *ActionManualInputs     `json:"manualInputs,omitempty"`
	JobResources         *JobResourceBinding     `json:"jobResources,omitempty"`
	Input                ActionPlanInput         `json:"input"`
	Plan                 ActionPlan              `json:"plan"`
	EventJSON            []byte                  `json:"eventJson"`
	CommitID             string                  `json:"commitId"`
	TimeoutSeconds       int                     `json:"timeoutSeconds"`
	ResolvedImages       map[string]string       `json:"resolvedImages"`
	ExecutionEnvironment *ExecutionEnvironment   `json:"executionEnvironment,omitempty"`
}

// Values remain private execution data. Schema/values digests bind the exact
// canonical producer contract; event.inputs remains a separate string map.
type ActionManualInputs struct {
	Contract        string                 `json:"contract"`
	SchemaSHA256    string                 `json:"schemaSha256"`
	SubmittedSHA256 string                 `json:"submittedSha256"`
	EffectiveSHA256 string                 `json:"effectiveSha256"`
	Submitted       []workflowinputs.Value `json:"submitted"`
	Effective       []workflowinputs.Value `json:"effective"`
}

// Source stdout always has Kind=log and can never set observation fields.
// Sequence identifies the duplex acknowledgement, EventSequence the durable
// graph observation. States are engine outcomes, not invented process exits.
type ActionFrame struct {
	Sequence      int    `json:"sequence"`
	EventSequence int    `json:"eventSequence,omitempty"`
	Kind          string `json:"kind"`
	InstanceID    string `json:"instanceId,omitempty"`
	StepID        string `json:"stepId,omitempty"`
	State         string `json:"state,omitempty"`
	Text          string `json:"text,omitempty"`
}
type ActionAck struct {
	Sequence int               `json:"sequence"`
	JobGit   *JobGitCredential `json:"jobGit,omitempty"`
}

// Docker drops tags from RepoDigests. Manifest content identity, not a display
// tag or alias, binds the operator-approved image before content-ID transfer.
func RegistryDigestMatches(reference, observed string) bool {
	_, expected, ok := strings.Cut(reference, "@")
	_, actual, found := strings.Cut(observed, "@")
	return ok && found && expected == actual && len(expected) == 71 && strings.HasPrefix(expected, "sha256:")
}

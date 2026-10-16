package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const runnerLeaseSeconds = 45
const runnerMaxLogBytes = 256 << 10

var runnerIdentifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)
var attemptIdentifier = regexp.MustCompile(`^[a-f0-9]{32}$`)

// Operator-enrolled worker credentials are control-plane credentials. Neither
// these keys nor the per-attempt capability is ever passed into a container.
func (s *Server) configureRunners() error {
	s.runnerKeys = map[string][32]byte{}
	s.runnerImages = map[string]string{}
	if s.config.RunnerKeysJSON == "" && s.config.RunnerImagesJSON == "" {
		return nil
	}
	var keys map[string]string
	if json.Unmarshal([]byte(s.config.RunnerKeysJSON), &keys) != nil || len(keys) == 0 || len(keys) > 100 || json.Unmarshal([]byte(s.config.RunnerImagesJSON), &s.runnerImages) != nil || len(s.runnerImages) == 0 || len(s.runnerImages) > 20 {
		return errors.New("runner enrollment and image maps must both be bounded JSON objects")
	}
	for id, key := range keys {
		raw, err := base64.RawURLEncoding.DecodeString(key)
		if !runnerIdentifier.MatchString(id) || err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != key {
			return errors.New("runner enrollment requires a valid ID and canonical random 32-byte key")
		}
		s.runnerKeys[id] = sha256.Sum256([]byte(key))
	}
	for label, image := range s.runnerImages {
		if !regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`).MatchString(label) || !workflowImage.MatchString(image) || len(image) > 255 {
			return errors.New("runner images require valid labels and exact repository@sha256 digests")
		}
	}
	return nil
}
func (s *Server) executionImage(plan *workflowExecutionPlan) (string, error) {
	if len(s.runnerKeys) == 0 {
		return "", errRunnerUnavailable
	}
	if plan.Actions != nil {
		if !s.actionsEngineConfigured() || !runner.IsActionsCatalog(plan.Actions.Catalog) || plan.Actions.Catalog == runner.ActionsInputsCatalog && s.config.ActionsEngineCatalog != runner.ActionsInputsCatalog || plan.Actions.Catalog == runner.ActionsAgentCatalog && s.config.ActionsEngineCatalog != runner.ActionsAgentCatalog || len(plan.Actions.Jobs) == 0 {
			return "", errRunnerUnavailable
		}
		for _, job := range plan.Actions.Jobs {
			approved := false
			for _, image := range s.runnerImages {
				approved = approved || image == job.Image
			}
			if !approved {
				return "", errRunnerUnavailable
			}
		}
		return plan.Actions.Jobs[0].Image, nil
	}
	if plan.ImageDigest != "" {
		for _, image := range s.runnerImages {
			if image == plan.ImageDigest {
				return image, nil
			}
		}
	} else if image := s.runnerImages[plan.RunnerLabel]; image != "" {
		return image, nil
	}
	return "", errRunnerUnavailable
}

var errRunnerUnavailable = errors.New("no enrolled runner image supports the execution plan")

func (s *Server) enrolledRunner(r *http.Request) (string, bool) {
	id := r.Header.Get("Golf-Runner-ID")
	expected, ok := s.runnerKeys[id]
	if !ok || len(r.Header.Values("Authorization")) != 1 {
		return "", false
	}
	value := r.Header.Get("Authorization")
	if !strings.HasPrefix(value, "Bearer ") || len(value) != 50 {
		return "", false
	}
	actual := sha256.Sum256([]byte(strings.TrimPrefix(value, "Bearer ")))
	return id, subtle.ConstantTimeCompare(expected[:], actual[:]) == 1
}
func runnerDecode(w http.ResponseWriter, r *http.Request, out any, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(out) != nil || decoder.Decode(new(any)) != io.EOF {
		http.Error(w, "Invalid runner request.", 400)
		return false
	}
	return true
}
func runnerFail(w http.ResponseWriter, status int) {
	http.Error(w, "Runner operation unavailable.", status)
}

// Provider checks run before SQL locks. The later identity/session/policy fence
// serializes Golf revocations; independent provider edits cannot be made atomic.
func (s *Server) runnerRunAuthority(ctx context.Context, run workflowRunRecord) error {
	if s.db == nil {
		return errStorageUnavailable
	}
	if run.Origin == "push" {
		grant, token, err := s.automationRunCredential(ctx, run)
		if err != nil {
			return err
		}
		return s.verifyAutomationDelegation(ctx, grant, token)
	}
	if run.Origin != "manual" {
		return errUnauthenticated
	}
	token, err := s.sessionCredentialHash(ctx, run.SessionHash)
	if err != nil {
		return err
	}
	row, err := database.New(s.db).GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: run.SessionHash, ForgeURL: s.config.ForgeURL})
	if errors.Is(err, sql.ErrNoRows) {
		return errUnauthenticated
	}
	if err != nil {
		return errStorageUnavailable
	}
	caller, err := s.currentUser(ctx, token)
	if err != nil {
		return err
	}
	if caller.ID != row.ForgeUserID {
		return errUnauthenticated
	}
	repo, err := s.executionSelectedRepository(ctx, token, run.RepositoryID)
	if err != nil {
		return err
	}
	if repo.Owner.ID != run.OwnerID || *repo.Archived || *repo.Mirror {
		return errResourceNotFound
	}
	base, _ := repositoryPath(repositoryKey{repo.Owner.Login, repo.Name})
	permission, err := s.repositoryPermission(ctx, token, base, caller)
	if err != nil {
		return err
	}
	if permission != "owner" && permission != "admin" && permission != "write" {
		return forgeError{403}
	}
	org, err := s.repositoryOwnerKind(ctx, token, *repo.Owner)
	if err != nil {
		return err
	}
	if org != run.OrganizationOwned {
		return errResourceNotFound
	}
	return nil
}
func (s *Server) runnerPolicyFence(ctx context.Context, tx *sql.Tx, run workflowRunRecord) error {
	// ponytail: inherited policy row locks serialize admission; qualify shared
	// locks after measuring contention, preserving revocation/result fencing.
	event := "manual"
	if run.Origin == "push" {
		if err := s.lockAutomationRunAuthority(ctx, tx, run); err != nil {
			return err
		}
		event = "push"
	} else if run.Origin == "manual" {
		q := database.New(s.db).WithTx(tx)
		actor, err := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: run.SessionHash, ForgeURL: s.config.ForgeURL})
		if errors.Is(err, sql.ErrNoRows) {
			return errUnauthenticated
		}
		if err != nil {
			return errStorageUnavailable
		}
		if actor.ID != run.UserID {
			return errUnauthenticated
		}
		_, err = q.LockSessionCredential(ctx, database.LockSessionCredentialParams{TokenHash: run.SessionHash, ForgeURL: s.config.ForgeURL})
		if errors.Is(err, sql.ErrNoRows) {
			return errUnauthenticated
		}
		if err != nil {
			return errStorageUnavailable
		}
	} else {
		return errUnauthenticated
	}
	if err := executionLifecycleGate(ctx, tx, run.ForgeURL, run.RepositoryID); err != nil {
		return err
	}
	policy, err := s.readEffectiveExecutionPolicyForEvent(ctx, tx, run.RepositoryID, run.OwnerID, run.OrganizationOwned, event, run.WorkflowPath)
	if err != nil {
		return err
	}
	var epochs []ExecutionPolicyEpoch
	if json.Unmarshal(run.PolicyEpochs, &epochs) != nil || !policy.Allowed || !reflect.DeepEqual(policy.Epochs, epochs) {
		return errExecutionPolicyConflict
	}
	return nil
}

func (s *Server) runnerPoll(w http.ResponseWriter, r *http.Request) {
	id, ok := s.enrolledRunner(r)
	if !ok {
		runnerFail(w, 401)
		return
	}
	var input struct {
		Catalogs     []string `json:"catalogs"`
		Capabilities []string `json:"capabilities"`
	}
	if !runnerDecode(w, r, &input, 1024) {
		return
	}
	secureBroker, resourceConsumer, manualConsumer, artifactConsumer, gitConsumer := false, false, false, false, false
	if len(input.Capabilities) > 6 {
		runnerFail(w, 400)
		return
	}
	seenCaps := map[string]bool{}
	for _, capability := range input.Capabilities {
		if seenCaps[capability] {
			runnerFail(w, 400)
			return
		}
		seenCaps[capability] = true
		switch capability {
		case runner.JobLimitsCapability:
			resourceConsumer = true
		case runner.ExecutionValuesCapability:
			secureBroker = r.TLS != nil && r.TLS.Version >= tls.VersionTLS13
		case runner.ManualInputsCapability:
			manualConsumer = r.TLS != nil && r.TLS.Version >= tls.VersionTLS13
		case runner.GitSourceProfile:
			gitConsumer = r.TLS != nil && r.TLS.Version >= tls.VersionTLS13
		case runner.JobGitCapability:
			if r.TLS == nil || r.TLS.Version < tls.VersionTLS13 {
				runnerFail(w, 400)
				return
			}
		case runner.ArtifactCapability:
			artifactConsumer = r.TLS != nil && r.TLS.Version >= tls.VersionTLS13
		default:
			runnerFail(w, 400)
			return
		}
	}
	// Enrollment alone never authorizes an old executor to adopt new limits.
	if seenCaps[runner.JobGitCapability] && !gitConsumer {
		runnerFail(w, 400)
		return
	}
	if seenCaps[runner.JobGitCapability] {
		if _, e := s.jobGitOrigin(); e != nil {
			runnerFail(w, 403)
			return
		}
	}
	if !resourceConsumer {
		w.WriteHeader(204)
		return
	}
	catalogs := []string{workflowExecutionCatalog}
	if len(input.Catalogs) > 4 {
		runnerFail(w, 400)
		return
	}
	seenCatalogs := map[string]bool{}
	for _, catalog := range input.Catalogs {
		if seenCatalogs[catalog] || catalog != workflowExecutionCatalog && !runner.IsActionsCatalog(catalog) {
			runnerFail(w, 400)
			return
		}
		seenCatalogs[catalog] = true
		if catalog == runner.ActionsRemoteCatalog {
			if !gitConsumer || !seenCaps[runner.JobGitCapability] {
				runnerFail(w, 400)
				return
			}
			if s.actionsEngineConfigured() && s.config.ActionsEngineCatalog == catalog {
				catalogs = append(catalogs, catalog)
			}
		}
		if catalog == runner.ActionsCatalog && s.actionsEngineConfigured() || catalog == runner.ActionsInputsCatalog && s.actionsEngineConfigured() && s.config.ActionsEngineCatalog == runner.ActionsInputsCatalog && manualConsumer || catalog == runner.ActionsAgentCatalog && s.actionsEngineConfigured() && s.config.ActionsEngineCatalog == runner.ActionsAgentCatalog && s.agentACPAvailable(r.Context()) && manualConsumer {
			catalogs = append(catalogs, catalog)
		}
	}
	if s.db == nil {
		runnerFail(w, 503)
		return
	}
	ctx := r.Context()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO golf_runner_presence(forge_url,runner_id) VALUES($1,$2) ON CONFLICT(forge_url,runner_id) DO UPDATE SET last_seen=clock_timestamp()`, s.config.ForgeURL, id); err != nil {
		runnerFail(w, 503)
		return
	}
	// Never replay an expired attempt automatically: a worker may have executed
	// commands before losing contact. Its result credential is fenced permanently.
	_, err := s.db.ExecContext(ctx, `UPDATE golf_workflow_runs SET state='lost',version=version+1,finished_at=clock_timestamp(),reason='Runner lease expired; no automatic retry.',lease_token_hash=NULL WHERE forge_url=$1 AND state='running' AND lease_expires_at<=clock_timestamp()`, s.config.ForgeURL)
	if err != nil {
		runnerFail(w, 503)
		return
	}
	run, err := scanWorkflowRun(s.db.QueryRowContext(ctx, `SELECT `+workflowRunColumns+` FROM golf_workflow_runs WHERE forge_url=$1 AND state='queued' AND engine_catalog=ANY($2) AND ($3 OR NOT EXISTS(SELECT 1 FROM golf_workflow_execution_bindings WHERE run_id=golf_workflow_runs.id)) AND ($5 OR NOT(plan ? 'artifactPaths')) AND golf_runner_pool_candidate(forge_url,id,$4) ORDER BY created_at,id LIMIT 1`, s.config.ForgeURL, catalogs, secureBroker, id, artifactConsumer))
	if errors.Is(err, sql.ErrNoRows) {
		w.WriteHeader(204)
		return
	}
	if err != nil {
		runnerFail(w, 503)
		return
	}
	if err = s.runnerRunAuthority(ctx, run); err != nil {
		if errors.Is(err, errUnauthenticated) || errors.Is(err, errResourceNotFound) || isRunnerAuthorityDenied(err) {
			s.rejectQueuedRun(ctx, run.ID, "Dispatch authority was revoked.")
			w.WriteHeader(204)
		} else {
			runnerFail(w, 503)
		}
		return
	}
	var manualSchema *workflowDispatchInputSchema
	if run.InputContract != "" {
		if !manualConsumer || run.EngineCatalog != runner.ActionsInputsCatalog {
			runnerFail(w, 403)
			return
		}
		// Slow object reads happen before transaction locks. The source binding
		// and typed run identity are immutable; current authority is fenced below.
		source, e := s.workflowSourceObject(ctx, run)
		if e != nil {
			runnerFail(w, 503)
			return
		}
		schema, e := workflowDispatchStoredSourceSchema(run, source)
		if e != nil {
			runnerFail(w, 503)
			return
		}
		manualSchema = &schema
	}
	approval, err := storedExecutionRunBinding(ctx, s.db, run)
	if err == nil && approval != nil {
		var artifactPlan workflowExecutionPlan
		var encoded []byte
		if s.db.QueryRowContext(ctx, `SELECT plan FROM golf_workflow_runs WHERE id=$1`, run.ID).Scan(&encoded) != nil || json.Unmarshal(encoded, &artifactPlan) != nil {
			runnerFail(w, 503)
			return
		}
		if len(artifactPlan.ArtifactPaths) > 0 {
			s.rejectQueuedRun(ctx, run.ID, "Build artifacts do not support private execution inputs.")
			w.WriteHeader(204)
			return
		}
	}
	if err == nil {
		err = s.executionApprovalAuthority(ctx, run, approval)
	}
	if err != nil {
		if errors.Is(err, errExecutionApproval) || isRunnerAuthorityDenied(err) || errors.Is(err, errUnauthenticated) {
			s.rejectQueuedRun(ctx, run.ID, "Execution source approval is no longer authorized.")
			w.WriteHeader(204)
		} else {
			runnerFail(w, 503)
		}
		return
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		runnerFail(w, 503)
		return
	}
	defer tx.Rollback()
	if err = lockExecutionApprovalUsers(ctx, tx, run, approval); err != nil {
		runnerFail(w, 503)
		return
	}
	if err = s.runnerPolicyFence(ctx, tx, run); err != nil {
		tx.Rollback()
		if errors.Is(err, errExecutionPolicyConflict) || errors.Is(err, errUnauthenticated) || errors.Is(err, errExecutionApproval) {
			s.rejectQueuedRun(ctx, run.ID, "Execution policy or dispatch authority changed.")
			w.WriteHeader(204)
		} else {
			runnerFail(w, 503)
		}
		return
	}
	environment, err := s.executionBrokerFence(ctx, tx, run, approval)
	if err != nil {
		tx.Rollback()
		if errors.Is(err, errExecutionApproval) {
			s.rejectQueuedRun(ctx, run.ID, "Execution source approval or value versions changed.")
			w.WriteHeader(204)
		} else {
			runnerFail(w, 503)
		}
		return
	}
	// Candidate selection intentionally held no run lock. Preserve the existing
	// user/lifecycle/policy/broker order, then placement→worker→pool→run. Decrypted
	// broker values remain server RAM only until this claim commits and authority
	// is rechecked; backpressure/refusal never releases an environment.
	allowed, err := s.runnerPoolClaimFence(ctx, tx, run, id)
	if err != nil {
		tx.Rollback()
		if errors.Is(err, errRunnerPoolStale) {
			if err = s.rejectRunnerPoolRun(ctx, run); err != nil {
				runnerFail(w, 503)
				return
			}
			w.WriteHeader(204)
		} else {
			runnerFail(w, 503)
		}
		return
	}
	if !allowed {
		w.WriteHeader(204)
		return
	}
	if err = s.runnerResourceFence(ctx, tx, run); err != nil {
		tx.Rollback()
		if errors.Is(err, errRunnerResourcesStale) {
			if e := s.rejectRunnerResourcesRun(ctx, run); e != nil {
				runnerFail(w, 503)
				return
			}
			w.WriteHeader(204)
		} else {
			runnerFail(w, 503)
		}
		return
	}
	raw := make([]byte, 32)
	if _, err = rand.Read(raw); err != nil {
		runnerFail(w, 503)
		return
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	hash := sha256.Sum256([]byte(token))
	attempt := hex.EncodeToString(raw[:16])
	result, err := tx.ExecContext(ctx, `UPDATE golf_workflow_runs SET state='running',version=version+1,started_at=clock_timestamp(),runner_id=$2,attempt_id=$3,lease_token_hash=$4,lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE id=$1 AND forge_url=$5 AND state='queued'`, run.ID, id, attempt, hash[:], s.config.ForgeURL)
	if err != nil {
		runnerFail(w, 503)
		return
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		w.WriteHeader(204)
		return
	}
	if err = tx.QueryRowContext(ctx, `SELECT plan FROM golf_workflow_runs WHERE id=$1`, run.ID).Scan(&run.Plan); err != nil {
		runnerFail(w, 503)
		return
	}
	var plan workflowExecutionPlan
	if json.Unmarshal(run.Plan, &plan) != nil || !workflowImage.MatchString(plan.ImageDigest) {
		runnerFail(w, 503)
		return
	}
	var manualInputs *runner.ActionManualInputs
	var eventJSON []byte
	if plan.Actions != nil {
		if run.InputContract != "" {
			var nativeActor int64
			if err = tx.QueryRowContext(ctx, `SELECT forge_user_id FROM golf_users WHERE id=$1 AND forge_url=$2`, run.UserID, run.ForgeURL).Scan(&nativeActor); err != nil || manualSchema == nil {
				runnerFail(w, 503)
				return
			}
			values, e := s.loadWorkflowDispatchTypedValues(ctx, tx, run, nativeActor)
			if e != nil {
				runnerFail(w, 503)
				return
			}
			validated, e := validateWorkflowDispatchInputs(*manualSchema, values.Submitted)
			if e != nil || validated.SubmittedSHA256 != run.SubmittedSHA256 || validated.EffectiveSHA256 != run.EffectiveSHA256 {
				runnerFail(w, 503)
				return
			}
			manualInputs = &runner.ActionManualInputs{Contract: run.InputContract, SchemaSHA256: run.SchemaSHA256, SubmittedSHA256: run.SubmittedSHA256, EffectiveSHA256: run.EffectiveSHA256, Submitted: values.Submitted, Effective: values.Effective}
		}
		var e error
		eventJSON, e = workflowActionEventJSON(run, *plan.Actions, manualInputs)
		if e != nil {
			runnerFail(w, 503)
			return
		}
	}
	if err = tx.Commit(); err != nil {
		runnerFail(w, 503)
		return
	}
	if environment != nil {
		if err = s.executionApprovalAuthority(ctx, run, approval); err != nil {
			s.cancelRunnerAttempt(ctx, run.ID, "Execution source approval was revoked.")
			runnerFail(w, 403)
			return
		}
	}
	if err = s.runnerResourceObservation(ctx, run); err != nil {
		if !errors.Is(err, errRunnerResourcesStale) {
			runnerFail(w, 503)
			return
		}
		if e := s.cancelRunnerResourceAttempt(ctx, run.ID); e != nil {
			runnerFail(w, 503)
			return
		}
		runnerFail(w, 403)
		return
	}
	if manualInputs != nil {
		if err = s.runnerManualInputReleaseFence(ctx, run, id, attempt, hash[:]); err != nil {
			if isRunnerAuthorityDenied(err) || errors.Is(err, errUnauthenticated) || errors.Is(err, errResourceNotFound) || errors.Is(err, errExecutionPolicyConflict) || errors.Is(err, errRunnerResourcesStale) || errors.Is(err, errRunnerPoolStale) || errors.Is(err, errWorkflowRunConflict) {
				s.cancelRunnerAttempt(ctx, run.ID, "Manual parameter release authority changed.")
				runnerFail(w, 403)
			} else {
				runnerFail(w, 503)
			}
			return
		}
	}
	if plan.Actions != nil {
		assignment := map[string]any{"runId": run.ID, "attemptId": attempt, "attemptToken": token, "imageDigest": plan.ImageDigest, "commitId": run.CommitID, "sourceSha256": run.SourceSHA256, "timeoutSeconds": run.Resources.TimeoutSeconds, "jobResources": resourceBinding(run), "leaseSeconds": runnerLeaseSeconds, "engineCatalog": plan.Actions.Catalog, "actionsPlan": plan.Actions, "eventJson": eventJSON}
		if gitConsumer {
			assignment["gitSourceProfile"] = runner.GitSourceProfile
		}
		if seenCaps[runner.JobGitCapability] {
			origin, e := s.jobGitOrigin()
			binding := &runner.JobGitContext{Origin: origin, Repository: run.RepositoryOwner + "/" + run.RepositoryName, Actor: "unavailable"}
			if e != nil || !gitConsumer || binding.Validate() != nil {
				runnerFail(w, 403)
				return
			}
			assignment["jobGit"] = binding
		}
		if environment != nil {
			assignment["executionEnvironment"] = environment
		}
		if manualInputs != nil {
			assignment["manualInputs"] = manualInputs
		}
		w.Header().Set("Cache-Control", "no-store")
		respond(w, 200, assignment)
		return
	}
	assignment := map[string]any{"runId": run.ID, "attemptId": attempt, "attemptToken": token, "imageDigest": plan.ImageDigest, "commitId": run.CommitID, "sourceSha256": run.SourceSHA256, "steps": plan.Steps, "jobId": plan.JobID, "timeoutSeconds": run.Resources.TimeoutSeconds, "jobResources": resourceBinding(run), "leaseSeconds": runnerLeaseSeconds}
	if len(plan.ArtifactPaths) > 0 {
		if !artifactConsumer || runner.ValidateArtifactPaths(plan.ArtifactPaths) != nil || plan.Actions != nil || run.InputContract != "" || environment != nil {
			s.cancelRunnerAttempt(ctx, run.ID, "Artifact consumer binding unavailable.")
			runnerFail(w, 403)
			return
		}
		assignment["artifactPaths"] = plan.ArtifactPaths
	}
	w.Header().Set("Cache-Control", "no-store")
	respond(w, 200, assignment)
}
func isRunnerAuthorityDenied(err error) bool {
	var upstream forgeError
	return errors.As(err, &upstream) && (upstream.status == 401 || upstream.status == 403 || upstream.status == 404)
}

// Refuse only the original inspected queued admission; a competing claim,
// cancellation or changed source version is never overwritten by a loser.
func (s *Server) rejectRunnerPoolRun(ctx context.Context, run workflowRunRecord) error {
	_, e := s.db.ExecContext(ctx, `UPDATE golf_workflow_runs SET state='cancelled',version=version+1,finished_at=clock_timestamp(),reason='Runner placement or pool configuration changed; explicitly dispatch new work.' WHERE id=$1::uuid AND forge_url=$2 AND state='queued' AND version=$3 AND repository_id=$4 AND owner_id=$5 AND commit_id=$6 AND blob_id=$7 AND source_sha256=$8 AND runner_pool_id IS NOT DISTINCT FROM $9::uuid AND runner_pool_version IS NOT DISTINCT FROM $10 AND runner_placement_version=$11`, run.ID, s.config.ForgeURL, run.Version, run.RepositoryID, run.OwnerID, run.CommitID, run.BlobID, run.SourceSHA256, run.RunnerPlacement.PoolID, run.RunnerPlacement.PoolVersion, run.RunnerPlacement.PlacementVersion)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

func (s *Server) rejectQueuedRun(ctx context.Context, id, reason string) {
	_, _ = s.db.ExecContext(ctx, `UPDATE golf_workflow_runs SET state='cancelled',version=version+1,finished_at=clock_timestamp(),reason=$2 WHERE id=$1 AND forge_url=$3 AND state='queued'`, id, reason, s.config.ForgeURL)
}

func (s *Server) runnerAttempt(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	id, ok := s.enrolledRunner(r)
	attempt := chi.URLParam(r, "id")
	action := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	if action == "job-git-credential" && !s.jobGitIssuerRoute(r, attempt) {
		runnerFail(w, 403)
		return
	}
	capability := r.Header.Get("Golf-Attempt-Token")
	raw, err := base64.RawURLEncoding.DecodeString(capability)
	if !ok || !attemptIdentifier.MatchString(attempt) || err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != capability || len(r.Header.Values("Golf-Attempt-Token")) != 1 {
		runnerFail(w, 401)
		return
	}
	hash := sha256.Sum256([]byte(capability))
	if s.db == nil {
		runnerFail(w, 503)
		return
	}
	ctx := r.Context()
	run, err := scanWorkflowRun(s.db.QueryRowContext(ctx, `SELECT `+workflowRunColumns+` FROM golf_workflow_runs WHERE forge_url=$1 AND runner_id=$2 AND attempt_id=$3 AND lease_token_hash=$4 AND state='running' AND lease_expires_at>clock_timestamp()`, s.config.ForgeURL, id, attempt, hash[:]))
	if err != nil {
		runnerFail(w, 403)
		return
	}
	if run.InputContract != "" && (run.EngineCatalog != runner.ActionsInputsCatalog || r.TLS == nil || r.TLS.Version < tls.VersionTLS13) {
		runnerFail(w, 403)
		return
	}
	if err = s.runnerRunAuthority(ctx, run); err != nil {
		if isRunnerAuthorityDenied(err) || errors.Is(err, errUnauthenticated) || errors.Is(err, errResourceNotFound) {
			s.cancelRunnerAttempt(ctx, run.ID, "Dispatch authority was revoked.")
			runnerFail(w, 403)
		} else {
			runnerFail(w, 503)
		}
		return
	}
	approval, err := storedExecutionRunBinding(ctx, s.db, run)
	if err != nil {
		runnerFail(w, 403)
		return
	}
	if approval != nil {
		if r.TLS == nil || r.TLS.Version < tls.VersionTLS13 {
			runnerFail(w, 403)
			return
		}
		if err = s.executionApprovalAuthority(ctx, run, approval); err != nil {
			s.cancelRunnerAttempt(ctx, run.ID, "Execution source approval was revoked.")
			runnerFail(w, 403)
			return
		}
	}
	var input struct {
		Sequence            int64  `json:"sequence"`
		EngineConclusion    string `json:"engineConclusion"`
		Text                string `json:"text"`
		JobInstanceID       string `json:"jobInstanceId"`
		StepID              string `json:"stepId"`
		State               string `json:"state"`
		StepIndex           int32  `json:"stepIndex"`
		Kind                string `json:"kind"`
		ExitCode            int32  `json:"exitCode"`
		TimedOut            bool   `json:"timedOut"`
		Cancelled           bool   `json:"cancelled"`
		InfrastructureError bool   `json:"infrastructureError"`
		LogsTruncated       bool   `json:"logsTruncated"`
	}
	var jobGitInput struct {
		JobInstanceID string `json:"jobInstanceId"`
	}
	if action == "job-git-credential" {
		if !runnerDecode(w, r, &jobGitInput, 4<<10) {
			return
		}
	}
	var gitRoute gitTransportRoute
	var gitResponse []byte
	if strings.HasPrefix(r.URL.Path, "/internal/ci/attempt/"+attempt+"/git/") {
		action = "git"
		gitRoute, err = runnerGitRoute(r, attempt, run)
		if err != nil {
			runnerFail(w, 400)
			return
		}
		select {
		case managedGitBuffers <- struct{}{}:
			defer func() { <-managedGitBuffers }()
		default:
			runnerFail(w, 503)
			return
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		gitResponse, err = s.runnerGitRead(ctx, r, run, gitRoute)
		if err != nil {
			status := 503
			if errors.Is(err, errGitProtocol) {
				status = 400
			} else if isRunnerAuthorityDenied(err) || errors.Is(err, errUnauthenticated) || errors.Is(err, errResourceNotFound) {
				s.cancelRunnerAttempt(ctx, run.ID, "Dispatch authority was revoked.")
				status = 403
			}
			runnerFail(w, status)
			return
		}
	}
	var artifact []byte
	if action == "artifact" {
		if r.TLS == nil || r.TLS.Version < tls.VersionTLS13 || approval != nil || run.InputContract != "" {
			runnerFail(w, 403)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, runner.MaxArtifactArchive)
		artifact, err = io.ReadAll(r.Body)
		if err != nil || len(artifact) == 0 {
			runnerFail(w, 400)
			return
		}
	}
	if action != "source" && action != "artifact" && action != "git" && action != "job-git-credential" && !runnerDecode(w, r, &input, 128<<10) {
		return
	}
	if action == "source" {
		run.SourceArchive, err = s.workflowSourceObject(ctx, run)
		if err != nil {
			runnerFail(w, 503)
			return
		}
		if err = s.runnerRunAuthority(ctx, run); err != nil {
			if isRunnerAuthorityDenied(err) || errors.Is(err, errUnauthenticated) || errors.Is(err, errResourceNotFound) {
				s.cancelRunnerAttempt(ctx, run.ID, "Dispatch authority was revoked.")
				runnerFail(w, 403)
			} else {
				runnerFail(w, 503)
			}
			return
		}
	}
	var agentAdmission *workflowAgentAdmission
	if action == "agent" {
		if r.TLS == nil || r.TLS.Version < tls.VersionTLS13 {
			runnerFail(w, 403)
			return
		}
		agentAdmission, err = s.prepareWorkflowAgent(ctx, run, input.JobInstanceID, input.StepID)
		if err != nil {
			runnerFail(w, 403)
			return
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		runnerFail(w, 503)
		return
	}
	defer tx.Rollback()
	if err = lockExecutionApprovalUsers(ctx, tx, run, approval); err != nil {
		runnerFail(w, 503)
		return
	}
	if err = s.runnerPolicyFence(ctx, tx, run); err != nil {
		tx.Rollback()
		if errors.Is(err, errExecutionPolicyConflict) || errors.Is(err, errUnauthenticated) || errors.Is(err, errExecutionApproval) {
			s.cancelRunnerAttempt(ctx, run.ID, "Execution policy or dispatch authority changed.")
			runnerFail(w, 403)
		} else {
			runnerFail(w, 503)
		}
		return
	}
	environment, err := s.executionBrokerFence(ctx, tx, run, approval)
	if err != nil {
		tx.Rollback()
		s.cancelRunnerAttempt(ctx, run.ID, "Execution source approval or value versions changed.")
		runnerFail(w, 403)
		return
	}
	if err = s.lockRunnerPlacement(ctx, tx, run.RepositoryID); err != nil {
		runnerFail(w, 503)
		return
	}
	var state string
	if err = s.lockRunnerControl(ctx, tx, id); err != nil {
		runnerFail(w, 503)
		return
	}
	control, _, err := s.runnerControl(ctx, tx, id)
	if err != nil {
		runnerFail(w, 503)
		return
	}
	if control == "revoked" {
		runnerFail(w, 403)
		return
	}
	if run.RunnerPlacement.PoolID.Valid {
		if err = s.lockRunnerPool(ctx, tx, run.RunnerPlacement.PoolID.String); err != nil {
			runnerFail(w, 503)
			return
		}
	}
	if err = s.runnerResourceFence(ctx, tx, run); err != nil {
		tx.Rollback()
		if errors.Is(err, errRunnerResourcesStale) {
			if e := s.cancelRunnerResourceAttempt(ctx, run.ID); e != nil {
				runnerFail(w, 503)
				return
			}
			runnerFail(w, 403)
		} else {
			runnerFail(w, 503)
		}
		return
	}
	err = tx.QueryRowContext(ctx, `SELECT state FROM golf_workflow_runs WHERE id=$1 AND forge_url=$2 AND runner_id=$3 AND attempt_id=$4 AND lease_token_hash=$5 AND lease_expires_at>clock_timestamp() FOR UPDATE`, run.ID, s.config.ForgeURL, id, attempt, hash[:]).Scan(&state)
	if err != nil || state != "running" {
		runnerFail(w, 403)
		return
	}
	switch action {
	case "agent":
		state, task, e := s.admitWorkflowAgent(ctx, tx, run, agentAdmission)
		if e != nil {
			runnerFail(w, 403)
			return
		}
		if tx.Commit() != nil {
			runnerFail(w, 503)
			return
		}
		if state == "queued" {
			s.releaseAgentAccountOwner(agentAdmission.Account.ID)
		}
		respond(w, 200, map[string]string{"state": state, "taskId": task})
		return
	case "job-git-credential":
		var cancelled bool
		if tx.QueryRowContext(ctx, `SELECT cancel_requested FROM golf_workflow_runs WHERE id=$1`, run.ID).Scan(&cancelled) != nil || cancelled {
			runnerFail(w, 403)
			return
		}
		if err = jobGitRunningJob(ctx, tx, run, jobGitInput.JobInstanceID); err != nil {
			runnerFail(w, 403)
			return
		}
		credential, e := s.mintJobGitCredential(run, jobGitInput.JobInstanceID, time.Now())
		if e != nil || ctx.Err() != nil {
			runnerFail(w, 403)
			return
		}
		if tx.Commit() != nil {
			runnerFail(w, 503)
			return
		}
		respond(w, 200, credential)
		return
	case "git":
		if err = tx.Commit(); err != nil {
			runnerFail(w, 503)
			return
		}
		content := "application/x-git-upload-pack-result"
		if gitRoute.Advertisement {
			content = "application/x-git-upload-pack-advertisement"
		}
		w.Header().Set("Content-Type", content)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Golf-Source-Commit", run.CommitID)
		w.Header().Set("Golf-Workflow-Blob", run.BlobID)
		_, _ = w.Write(gitResponse)
		return
	case "artifact":
		err = s.storeWorkflowArtifact(ctx, tx, run, artifact)
		if errors.Is(err, runner.ErrArtifacts) {
			runnerFail(w, 400)
			return
		}
		if errors.Is(err, errWorkflowRunConflict) {
			runnerFail(w, 409)
			return
		}
	case "source":
		if err = tx.Commit(); err != nil {
			runnerFail(w, 503)
			return
		}
		w.Header().Set("Content-Type", "application/x-tar")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(run.SourceArchive)
		return
	case "heartbeat":
		_, err = tx.ExecContext(ctx, `UPDATE golf_workflow_runs SET lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE id=$1`, run.ID)
	case "logs":
		if input.JobInstanceID != "" || input.StepID != "" {
			plan, e := loadActionPlan(ctx, tx, run.ID)
			if e != nil || !admittedActionJob(plan, input.JobInstanceID, input.StepID) {
				runnerFail(w, 400)
				return
			}
		} else {
			var catalog string
			if tx.QueryRowContext(ctx, `SELECT engine_catalog FROM golf_workflow_runs WHERE id=$1`, run.ID).Scan(&catalog) != nil || catalog != workflowExecutionCatalog {
				runnerFail(w, 400)
				return
			}
		}
		if input.Sequence <= 0 || len(input.Text) == 0 || len(input.Text) > 16<<10 || !runnerLogText(input.Text) {
			runnerFail(w, 400)
			return
		}
		if environment != nil {
			err = s.appendQuarantinedOutput(ctx, tx, run, attempt, input.Sequence, input.Text, input.JobInstanceID, input.StepID)
			if errors.Is(err, errWorkflowRunConflict) {
				runnerFail(w, 409)
				return
			}
			break
		}
		var seq, used int64
		if err = tx.QueryRowContext(ctx, `SELECT log_sequence,log_bytes FROM golf_workflow_runs WHERE id=$1`, run.ID).Scan(&seq, &used); err != nil {
			runnerFail(w, 503)
			return
		}
		if input.Sequence <= seq {
			var old string
			err = tx.QueryRowContext(ctx, `SELECT text FROM golf_workflow_run_logs WHERE run_id=$1 AND sequence=$2 AND job_instance_id=$3 AND engine_step_id=$4`, run.ID, input.Sequence, input.JobInstanceID, input.StepID).Scan(&old)
			if err != nil || old != input.Text {
				runnerFail(w, 409)
				return
			}
		} else {
			if input.Sequence != seq+1 || used+int64(len(input.Text)) > runnerMaxLogBytes {
				runnerFail(w, 409)
				return
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO golf_workflow_run_logs(run_id,sequence,text,job_instance_id,engine_step_id) VALUES($1,$2,$3,$4,$5)`, run.ID, input.Sequence, input.Text, input.JobInstanceID, input.StepID); err != nil {
				runnerFail(w, 503)
				return
			}
			_, err = tx.ExecContext(ctx, `UPDATE golf_workflow_runs SET log_sequence=$2,log_bytes=log_bytes+$3 WHERE id=$1`, run.ID, input.Sequence, len(input.Text))
		}
	case "graph":
		if !runner.IsActionsCatalog(run.EngineCatalog) {
			runnerFail(w, 400)
			return
		}
		if input.Sequence < 1 || input.Sequence > 512 {
			runnerFail(w, 400)
			return
		}
		err = recordActionEvent(ctx, tx, run, actionEvent{int(input.Sequence), input.JobInstanceID, input.StepID, input.Kind, input.State})
		if errors.Is(err, errWorkflowProgressInput) {
			runnerFail(w, 400)
			return
		}
		if errors.Is(err, errWorkflowRunConflict) {
			runnerFail(w, 409)
			return
		}
	case "progress":
		if run.EngineCatalog != workflowExecutionCatalog {
			runnerFail(w, 400)
			return
		}
		if input.Sequence < 1 || input.Sequence > 100 {
			runnerFail(w, 400)
			return
		}
		err = recordWorkflowProgress(ctx, tx, run, int32(input.Sequence), input.StepIndex, input.Kind, input.ExitCode)
		if errors.Is(err, errWorkflowProgressInput) {
			runnerFail(w, 400)
			return
		}
		if errors.Is(err, errWorkflowRunConflict) {
			runnerFail(w, 409)
			return
		}
	case "finish":
		var finishCatalog string
		if tx.QueryRowContext(ctx, `SELECT engine_catalog FROM golf_workflow_runs WHERE id=$1`, run.ID).Scan(&finishCatalog) != nil {
			runnerFail(w, 503)
			return
		}
		if finishCatalog == workflowExecutionCatalog && input.EngineConclusion != "" || runner.IsActionsCatalog(finishCatalog) && input.ExitCode != 0 {
			runnerFail(w, 400)
			return
		}
		if !input.TimedOut && !input.Cancelled && !input.InfrastructureError && !input.LogsTruncated {
			if runner.IsActionsCatalog(finishCatalog) {
				if input.ExitCode != 0 || (input.EngineConclusion != "success" && input.EngineConclusion != "failure") {
					runnerFail(w, 400)
					return
				}
				code := int32(0)
				if input.EngineConclusion == "failure" {
					code = 1
				}
				err = checkActionsFinish(ctx, tx, run, code)
			} else {
				err = checkWorkflowProgressFinish(ctx, tx, run, input.ExitCode)
			}
			if errors.Is(err, errWorkflowRunConflict) {
				runnerFail(w, 409)
				return
			}
			if err != nil {
				runnerFail(w, 503)
				return
			}
		}
		if input.ExitCode < 0 || input.ExitCode > 255 {
			runnerFail(w, 400)
			return
		}
		state = "succeeded"
		reason := ""
		if input.ExitCode != 0 || input.EngineConclusion == "failure" {
			state = "failed"
		}
		if input.TimedOut {
			state = "timed_out"
		}
		if input.Cancelled {
			state = "cancelled"
		}
		if input.InfrastructureError {
			state = "lost"
			reason = "Runner infrastructure failed; no automatic retry."
		}
		if input.LogsTruncated {
			state = "failed"
			reason = "Log limit exceeded."
		}
		if state == "succeeded" && finishCatalog == workflowExecutionCatalog {
			if err = requireWorkflowArtifact(ctx, tx, run); err != nil {
				runnerFail(w, 409)
				return
			}
		}
		if environment != nil && !input.TimedOut && !input.Cancelled && !input.InfrastructureError && !input.LogsTruncated {
			if err = s.releaseQuarantinedOutput(ctx, tx, run, attempt, environment); err != nil {
				runnerFail(w, 503)
				return
			}
		}
		_, err = tx.ExecContext(ctx, `UPDATE golf_workflow_runs SET state=$2,reason=$3,exit_code=$4,logs_truncated=$5,finished_at=clock_timestamp(),version=version+1,lease_token_hash=NULL WHERE id=$1`, run.ID, state, reason, workflowFinishExit(input.ExitCode, finishCatalog), input.LogsTruncated)
	default:
		runnerFail(w, 404)
		return
	}
	if err != nil || tx.Commit() != nil {
		runnerFail(w, 503)
		return
	}
	w.WriteHeader(204)
}
func (s *Server) cancelRunnerAttempt(ctx context.Context, id, reason string) {
	_, _ = s.db.ExecContext(ctx, `UPDATE golf_workflow_runs SET state='cancelled',reason=$2,version=version+1,finished_at=clock_timestamp(),lease_token_hash=NULL WHERE id=$1 AND forge_url=$3 AND state='running'`, id, reason, s.config.ForgeURL)
}
func runnerLogText(value string) bool {
	return !bytes.ContainsRune([]byte(value), '\x00') && strings.ToValidUTF8(value, "") == value
}

// Explicit operator recovery fences old result capabilities before the worker
// removes its labeled resources. Operators stop every process sharing this ID.
func (s *Server) runnerRecover(w http.ResponseWriter, r *http.Request) {
	id, ok := s.enrolledRunner(r)
	if !ok {
		runnerFail(w, 401)
		return
	}
	var input struct{}
	if !runnerDecode(w, r, &input, 128) {
		return
	}
	if s.db == nil {
		runnerFail(w, 503)
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		runnerFail(w, 503)
		return
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, s.config.ForgeURL+"/runner/"+id); err != nil {
		runnerFail(w, 503)
		return
	}
	_, err = tx.ExecContext(r.Context(), `UPDATE golf_workflow_runs SET state='lost',version=version+1,finished_at=clock_timestamp(),reason='Operator recovered worker; no automatic retry.',lease_token_hash=NULL WHERE forge_url=$1 AND runner_id=$2 AND state='running'`, s.config.ForgeURL, id)
	if err != nil || tx.Commit() != nil {
		runnerFail(w, 503)
		return
	}
	w.WriteHeader(204)
}

func workflowFinishExit(exit int32, catalog string) any {
	if runner.IsActionsCatalog(catalog) {
		return nil
	}
	return exit
}

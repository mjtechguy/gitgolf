package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/mjtechguy/golf-git/internal/runner"
)

const jobGitDomain = "runner_job_git_read"
const jobGitPrefix = "golf_job_git_"

// This capsule grants native ref metadata discovery of its bound repository
// and exact-H/depth1 Git v0/v2 object fetches. It is neither a human
// credential, worker control token, GitHub API token nor checkout compatibility.
// Revocation follows the current job/attempt/authority lifecycle; there is no
// independent per-capsule nonce revocation inventory in this initial slice.
type jobGitClaims struct {
	Run, Attempt, Worker, WorkerHash, LeaseHash                string
	RepositoryID, OwnerID                                      int64
	Owner, Name, Commit, Workflow, Blob, Archive, Catalog, Job string
	Issued, Expires                                            int64
}

type jobGitCredentialResponse = runner.JobGitCredential

func (s *Server) jobGitOrigin() (string, error) {
	u, err := url.Parse(s.config.PublicURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || u.String() != s.config.PublicURL {
		return "", errUnauthenticated
	}
	return u.String(), nil
}

func (s *Server) jobGitBinding(runID string) ([]byte, error) {
	id, err := uuid.Parse(runID)
	origin, originErr := s.jobGitOrigin()
	if err != nil || id.String() != runID || id.Version() != 4 || originErr != nil {
		return nil, errUnauthenticated
	}
	value := sha256.Sum256([]byte(jobGitDomain + "\x00" + s.config.GiteaURL + "\x00" + origin + "\x00" + runID))
	return value[:], nil
}

func (s *Server) jobGitCurrentClaims(c jobGitClaims, run workflowRunRecord, now time.Time) error {
	worker, ok := s.runnerKeys[run.RunnerID]
	wh, we := base64.RawURLEncoding.DecodeString(c.WorkerHash)
	lh, le := base64.RawURLEncoding.DecodeString(c.LeaseHash)
	if !ok || we != nil || le != nil || len(wh) != 32 || len(lh) != 32 || base64.RawURLEncoding.EncodeToString(wh) != c.WorkerHash || base64.RawURLEncoding.EncodeToString(lh) != c.LeaseHash || subtle.ConstantTimeCompare(wh, worker[:]) != 1 || subtle.ConstantTimeCompare(lh, run.LeaseTokenHash) != 1 {
		return errUnauthenticated
	}
	if c.Run != run.ID || c.Attempt != run.AttemptID || c.Worker != run.RunnerID || !attemptIdentifier.MatchString(c.Attempt) || c.RepositoryID != run.RepositoryID || c.OwnerID != run.OwnerID || c.RepositoryID <= 0 || c.OwnerID <= 0 || c.Owner != run.RepositoryOwner || c.Name != run.RepositoryName || c.Commit != run.CommitID || c.Workflow != run.WorkflowPath || c.Blob != run.BlobID || c.Archive != run.SourceSHA256 || c.Catalog != run.EngineCatalog || !runner.IsActionsCatalog(c.Catalog) || !objectID.MatchString(c.Commit) || !objectID.MatchString(c.Blob) || len(c.Commit) != len(c.Blob) || !runner.ValidGitSourcePath(c.Workflow) || !attemptIdentifier.MatchString(c.Job) || len(c.Archive) != 64 || !objectID.MatchString(c.Archive) || run.State != "running" || run.CancelRequested || !run.LeaseExpiresAt.Valid || !run.LeaseExpiresAt.Time.After(now) || c.Issued > now.Unix() || c.Issued < 1 || c.Expires <= now.Unix() || c.Expires <= c.Issued || c.Expires-c.Issued > 300 {
		return errUnauthenticated
	}
	if _, err := repositoryPath(repositoryKey{c.Owner, c.Name}); err != nil {
		return errUnauthenticated
	}
	return nil
}

func (s *Server) mintJobGitCredential(run workflowRunRecord, job string, now time.Time) (jobGitCredentialResponse, error) {
	var empty jobGitCredentialResponse
	worker, ok := s.runnerKeys[run.RunnerID]
	if !ok || len(run.LeaseTokenHash) != 32 {
		return empty, errUnauthenticated
	}
	expires := now.Add(5 * time.Minute).Unix()
	c := jobGitClaims{Run: run.ID, Attempt: run.AttemptID, Worker: run.RunnerID, WorkerHash: base64.RawURLEncoding.EncodeToString(worker[:]), LeaseHash: base64.RawURLEncoding.EncodeToString(run.LeaseTokenHash), RepositoryID: run.RepositoryID, OwnerID: run.OwnerID, Owner: run.RepositoryOwner, Name: run.RepositoryName, Commit: run.CommitID, Workflow: run.WorkflowPath, Blob: run.BlobID, Archive: run.SourceSHA256, Catalog: run.EngineCatalog, Job: job, Issued: now.Unix(), Expires: expires}
	if s.jobGitCurrentClaims(c, run, now) != nil {
		return empty, errUnauthenticated
	}
	binding, err := s.jobGitBinding(run.ID)
	if err != nil {
		return empty, err
	}
	plain, err := json.Marshal(c)
	if err != nil || len(plain) > 2048 {
		return empty, errUnauthenticated
	}
	cipher, key, err := s.keyring.seal(jobGitDomain, string(plain), binding)
	if err != nil {
		return empty, err
	}
	token := jobGitPrefix + key + ":" + run.ID + ":" + base64.RawURLEncoding.EncodeToString(cipher)
	if len(token) > 4096 {
		return empty, errUnauthenticated
	}
	origin, _ := s.jobGitOrigin()
	return jobGitCredentialResponse{GitToken: token, Origin: origin, RepositoryURL: origin + "/" + c.Owner + "/" + c.Name, ExpiresAt: time.Unix(c.Expires, 0).UTC().Format(time.RFC3339), CommitID: c.Commit, WorkflowBlobID: c.Blob, JobInstanceID: c.Job}, nil
}

func (s *Server) openJobGitCredential(token string) (jobGitClaims, error) {
	var claims jobGitClaims
	if !strings.HasPrefix(token, jobGitPrefix) || len(token) > 4096 {
		return claims, errUnauthenticated
	}
	parts := strings.Split(strings.TrimPrefix(token, jobGitPrefix), ":")
	if len(parts) != 3 || !ValidKeyID(parts[0]) {
		return claims, errUnauthenticated
	}
	binding, err := s.jobGitBinding(parts[1])
	encoded, decodeErr := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || decodeErr != nil || base64.RawURLEncoding.EncodeToString(encoded) != parts[2] {
		return claims, errUnauthenticated
	}
	plain, err := s.keyring.open(parts[0], jobGitDomain, encoded, binding)
	if err != nil || len(plain) > 2048 {
		return claims, errUnauthenticated
	}
	decoder := json.NewDecoder(strings.NewReader(plain))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&claims) != nil || decoder.Decode(new(any)) != io.EOF || claims.Run != parts[1] {
		return jobGitClaims{}, errUnauthenticated
	}
	canonical, _ := json.Marshal(claims)
	if !bytes.Equal(canonical, []byte(plain)) {
		return jobGitClaims{}, errUnauthenticated
	}
	return claims, nil
}

// Frozen inventory and genuine current-attempt graph events determine this
// job's authority, never a caller-supplied job/source assertion.
func jobGitRunningJob(ctx context.Context, tx *sql.Tx, run workflowRunRecord, job string) error {
	plan, err := loadActionPlan(ctx, tx, run.ID)
	if err != nil {
		return err
	}
	if plan.Catalog != run.EngineCatalog || plan.ArchiveSHA256 != run.SourceSHA256 || plan.WorkflowPath != run.WorkflowPath || plan.WorkflowBlobID != run.BlobID || !admittedActionJob(plan, job, "") {
		return errUnauthenticated
	}
	events, err := readActionEvents(ctx, tx, run)
	if err != nil {
		return err
	}
	running := false
	for _, event := range events {
		if event.InstanceID == job && event.Kind == "job_started" {
			running = true
		}
		if event.InstanceID == job && event.Kind == "job_finished" {
			running = false
		}
	}
	if !running {
		return errUnauthenticated
	}
	return nil
}

func (s *Server) jobGitIssuerRoute(r *http.Request, attempt string) bool {
	origin, err := s.jobGitOrigin()
	_ = origin
	if err != nil || r.Method != http.MethodPost || r.TLS == nil || r.TLS.Version < tls.VersionTLS13 || r.Host == "" || r.URL.Host != "" && r.URL.Host != r.Host || r.URL.Scheme != "" && r.URL.Scheme != "https" || r.URL.Path != "/internal/ci/attempt/"+attempt+"/job-git-credential" || r.URL.RawPath != "" || r.URL.RawQuery != "" || r.URL.Fragment != "" || r.URL.ForceQuery || r.URL.User != nil || r.URL.Opaque != "" {
		return false
	}
	for _, name := range []string{"Cookie", "Origin", "Git-Protocol", "Content-Encoding"} {
		if len(r.Header.Values(name)) != 0 {
			return false
		}
	}
	return len(r.Header.Values("Golf-Runner-ID")) == 1 && len(r.Header.Values("Golf-Attempt-Token")) == 1 && len(r.Header.Values("Authorization")) == 1 && len(r.Header.Values("Content-Type")) <= 1
}

func (s *Server) jobGitRoute(r *http.Request, claims jobGitClaims) (gitTransportRoute, error) {
	var empty gitTransportRoute
	origin, err := s.jobGitOrigin()
	u, _ := url.Parse(origin)
	if err != nil || r.TLS == nil || r.TLS.Version < tls.VersionTLS13 || r.Host != u.Host || r.URL.Host != "" && r.URL.Host != u.Host || r.URL.Scheme != "" && r.URL.Scheme != "https" || r.URL.RawPath != "" || r.URL.Fragment != "" || r.URL.ForceQuery || r.URL.User != nil || r.URL.Opaque != "" || strings.ContainsAny(r.URL.Path, "%\\") {
		return empty, errUnauthenticated
	}
	for _, name := range []string{"Cookie", "Origin", "Golf-Runner-ID", "Golf-Attempt-Token", "Content-Encoding"} {
		if len(r.Header.Values(name)) != 0 {
			return empty, errUnauthenticated
		}
	}
	if values := r.Header.Values("Git-Protocol"); len(values) > 1 || len(values) == 1 && values[0] != "version=2" {
		return empty, errGitProtocol
	}
	if len(r.Header.Values("Authorization")) != 1 || len(r.Header.Values("Content-Type")) > 1 {
		return empty, errUnauthenticated
	}
	username, _, ok := r.BasicAuth()
	if !ok || username != "x-access-token" {
		return empty, errUnauthenticated
	}
	prefix := "/" + claims.Owner + "/" + claims.Name
	suffix := strings.TrimPrefix(r.URL.Path, prefix)
	if r.URL.Path != prefix+suffix || suffix != "/info/refs" && suffix != "/git-upload-pack" {
		return empty, errGitProtocol
	}
	clone := r.Clone(r.Context())
	clone.URL.Path = "/git/" + claims.Owner + "/" + claims.Name + ".git" + suffix
	route, err := classifyGitTransport(clone)
	if err != nil || route.Service != "git-upload-pack" {
		return empty, errGitProtocol
	}
	return route, nil
}

// Same final policy/approval/placement/control/pool/resource/current-lease
// primitives as runnerAttempt. The job additionally requires its recorded live
// graph and opaque capsule to remain bound before buffered bytes are released.
func (s *Server) jobGitFinalFence(ctx context.Context, tx *sql.Tx, run workflowRunRecord, claims jobGitClaims) error {
	approval, err := storedExecutionRunBinding(ctx, tx, run)
	if err != nil {
		return err
	}
	if err = lockExecutionApprovalUsers(ctx, tx, run, approval); err != nil {
		return err
	}
	if err = s.runnerPolicyFence(ctx, tx, run); err != nil {
		return err
	}
	if _, err = s.executionBrokerFence(ctx, tx, run, approval); err != nil {
		return err
	}
	if err = s.lockRunnerPlacement(ctx, tx, run.RepositoryID); err != nil {
		return err
	}
	if err = s.lockRunnerControl(ctx, tx, run.RunnerID); err != nil {
		return err
	}
	control, _, err := s.runnerControl(ctx, tx, run.RunnerID)
	if err != nil {
		return err
	}
	if control == "revoked" {
		return errUnauthenticated
	}
	if run.RunnerPlacement.PoolID.Valid {
		if err = s.lockRunnerPool(ctx, tx, run.RunnerPlacement.PoolID.String); err != nil {
			return err
		}
	}
	if err = s.runnerResourceFence(ctx, tx, run); err != nil {
		return err
	}
	var state string
	var cancelled bool
	err = tx.QueryRowContext(ctx, `SELECT state,cancel_requested FROM golf_workflow_runs WHERE id=$1 AND forge_url=$2 AND runner_id=$3 AND attempt_id=$4 AND lease_token_hash=$5 AND lease_expires_at>clock_timestamp() FOR UPDATE`, run.ID, s.config.GiteaURL, run.RunnerID, run.AttemptID, run.LeaseTokenHash).Scan(&state, &cancelled)
	if errors.Is(err, sql.ErrNoRows) {
		return errUnauthenticated
	}
	if err != nil {
		return errStorageUnavailable
	}
	if state != "running" || cancelled {
		return errUnauthenticated
	}
	if err = s.jobGitCurrentClaims(claims, run, time.Now()); err != nil {
		return err
	}
	return jobGitRunningJob(ctx, tx, run, claims.Job)
}

func jobGitFailure(w http.ResponseWriter, err error) {
	status := http.StatusServiceUnavailable
	if errors.Is(err, errUnauthenticated) || errors.Is(err, errResourceNotFound) || isRunnerAuthorityDenied(err) {
		status = http.StatusUnauthorized
	}
	if errors.Is(err, errGitProtocol) {
		status = http.StatusBadRequest
	}
	if status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Basic realm="Golf job Git"`)
	}
	http.Error(w, "Job Git read could not be authorized.", status)
}

func (s *Server) jobGitTransport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	_, secret, ok := r.BasicAuth()
	if !ok || len(r.Header.Values("Authorization")) != 1 {
		jobGitFailure(w, errUnauthenticated)
		return
	}
	claims, err := s.openJobGitCredential(secret)
	if err != nil {
		jobGitFailure(w, errUnauthenticated)
		return
	}
	route, err := s.jobGitRoute(r, claims)
	if err != nil {
		jobGitFailure(w, err)
		return
	}
	if s.db == nil {
		jobGitFailure(w, errStorageUnavailable)
		return
	}
	// The ordinary router's inherited 15s deadline remains authoritative;
	// this explicit cap also bounds direct calls without that middleware.
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	run, err := scanWorkflowRun(s.db.QueryRowContext(ctx, `SELECT `+workflowRunColumns+` FROM golf_workflow_runs WHERE id=$1 AND forge_url=$2 AND state='running' AND lease_expires_at>clock_timestamp()`, claims.Run, s.config.GiteaURL))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = errUnauthenticated
		}
		jobGitFailure(w, err)
		return
	}
	if err = s.jobGitCurrentClaims(claims, run, time.Now()); err != nil {
		jobGitFailure(w, err)
		return
	}
	if err = s.runnerRunAuthority(ctx, run); err != nil {
		jobGitFailure(w, err)
		return
	}
	approval, err := storedExecutionRunBinding(ctx, s.db, run)
	if err != nil {
		jobGitFailure(w, err)
		return
	}
	if err = s.executionApprovalAuthority(ctx, run, approval); err != nil {
		jobGitFailure(w, err)
		return
	}
	// Refuse completed/unadmitted jobs before any private native Git read, then
	// repeat all fences after the bounded response has been buffered.
	initial, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		jobGitFailure(w, errStorageUnavailable)
		return
	}
	err = s.jobGitFinalFence(ctx, initial, run, claims)
	if err == nil {
		err = initial.Commit()
	} else {
		_ = initial.Rollback()
	}
	if err != nil {
		jobGitFailure(w, err)
		return
	}
	select {
	case managedGitBuffers <- struct{}{}:
		defer func() { <-managedGitBuffers }()
	default:
		jobGitFailure(w, errStorageUnavailable)
		return
	}
	response, err := s.runnerGitRead(ctx, r, run, route)
	if err != nil {
		jobGitFailure(w, err)
		return
	}
	// The approver may be a different native administrator from the dispatcher.
	// SQL lifecycle/version checks cannot observe that actor losing native admin
	// rights during the read. Recheck supported native authority before SQL locks.
	if err = s.executionApprovalAuthority(ctx, run, approval); err != nil {
		jobGitFailure(w, err)
		return
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		jobGitFailure(w, errStorageUnavailable)
		return
	}
	defer tx.Rollback()
	if err = s.jobGitFinalFence(ctx, tx, run, claims); err != nil {
		jobGitFailure(w, err)
		return
	}
	if ctx.Err() != nil || tx.Commit() != nil {
		jobGitFailure(w, errStorageUnavailable)
		return
	}
	content := "application/x-git-upload-pack-result"
	if route.Advertisement {
		content = "application/x-git-upload-pack-advertisement"
	}
	w.Header().Set("Content-Type", content)
	w.Header().Set("Golf-Source-Commit", run.CommitID)
	w.Header().Set("Golf-Workflow-Blob", run.BlobID)
	w.Header().Set("Golf-Job-Instance", claims.Job)
	w.Header().Set("Content-Length", strconv.Itoa(len(response)))
	_, _ = w.Write(response)
}

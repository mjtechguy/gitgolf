package server

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"strconv"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

var errRunnerPoolConflict = errors.New("Runner pool configuration changed. Refresh and inspect the current values.")
var errRunnerPoolStale = errors.New("The admitted runner placement changed. Inspect this run and explicitly dispatch new work; no automatic reassignment is made.")
var errRunnerPoolUnavailable = errors.New("The selected runner pool is unavailable for new local Docker work.")

type runnerPoolBinding struct {
	PoolID           sql.NullString
	PoolVersion      sql.NullInt64
	PlacementVersion int64
}

func (s *Server) lockRunnerPlacement(ctx context.Context, tx *sql.Tx, repo int64) error {
	if _, e := tx.ExecContext(ctx, `SELECT golf_runner_placement_lock($1,$2)`, s.config.GiteaURL, repo); e != nil {
		return errStorageUnavailable
	}
	return nil
}
func (s *Server) lockRunnerPool(ctx context.Context, tx *sql.Tx, id string) error {
	if _, e := tx.ExecContext(ctx, `SELECT golf_runner_pool_lock($1,$2::uuid)`, s.config.GiteaURL, id); e != nil {
		return errStorageUnavailable
	}
	return nil
}

// Call within the existing user/session, lifecycle and execution-policy transaction
// before INSERT. The native identity/source/policy fences remain the caller's duty.
func (s *Server) runnerPoolAdmission(ctx context.Context, tx *sql.Tx, repo, owner int64) error {
	if e := s.lockRunnerPlacement(ctx, tx, repo); e != nil {
		return e
	}
	var storedOwner, version int64
	var id sql.NullString
	e := tx.QueryRowContext(ctx, `SELECT owner_id,version,pool_id::text FROM golf_repository_runner_placements WHERE forge_url=$1 AND repository_id=$2`, s.config.GiteaURL, repo).Scan(&storedOwner, &version, &id)
	if errors.Is(e, sql.ErrNoRows) {
		return nil
	}
	if e != nil {
		return errStorageUnavailable
	}
	if storedOwner != owner {
		return errRunnerPoolStale
	}
	if !id.Valid {
		return nil
	}
	if e = s.lockRunnerPool(ctx, tx, id.String); e != nil {
		return e
	}
	var runtime, state string
	var enabled bool
	e = tx.QueryRowContext(ctx, `SELECT runtime,state,repository_assignment_enabled FROM golf_runner_pools WHERE forge_url=$1 AND id=$2::uuid`, s.config.GiteaURL, id.String).Scan(&runtime, &state, &enabled)
	if e != nil {
		return errStorageUnavailable
	}
	if runtime != "local-docker" || state != "active" || !enabled {
		return errRunnerPoolUnavailable
	}
	return nil
}
func (s *Server) runnerPoolRunBinding(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string) (runnerPoolBinding, error) {
	var r runnerPoolBinding
	e := q.QueryRowContext(ctx, `SELECT runner_pool_id::text,runner_pool_version,runner_placement_version FROM golf_workflow_runs WHERE forge_url=$1 AND id=$2::uuid`, s.config.GiteaURL, id).Scan(&r.PoolID, &r.PoolVersion, &r.PlacementVersion)
	if e != nil {
		return r, errStorageUnavailable
	}
	return r, nil
}
func runnerPoolBindingWire(r runnerPoolBinding) *golfv1.WorkflowRunnerPlacement {
	w := &golfv1.WorkflowRunnerPlacement{PlacementVersion: strconv.FormatInt(r.PlacementVersion, 10), LegacyUnbound: !r.PoolID.Valid}
	if r.PoolID.Valid {
		w.PoolId = r.PoolID.String
		w.PoolVersion = strconv.FormatInt(r.PoolVersion.Int64, 10)
	}
	return w
}

// Call after existing execution authorization/broker fences, BEFORE the old
// worker-control section and UPDATE. It takes placement→worker→pool→run locks.
// false,nil is queued backpressure; stale is a known pre-dispatch refusal.
// Root's claim consumer must not convert backpressure to success/cancellation.
func (s *Server) runnerPoolClaimFence(ctx context.Context, tx *sql.Tx, r workflowRunRecord, worker string) (bool, error) {
	if _, ok := s.runnerKeys[worker]; !ok || !runnerIdentifier.MatchString(worker) {
		return false, errRunnerPoolUnavailable
	}
	if e := s.lockRunnerPlacement(ctx, tx, r.RepositoryID); e != nil {
		return false, e
	}
	if e := s.lockRunnerControl(ctx, tx, worker); e != nil {
		return false, errStorageUnavailable
	}
	state, _, e := s.runnerControl(ctx, tx, worker)
	if e != nil {
		return false, errStorageUnavailable
	}
	if state != "active" {
		return false, nil
	}
	b, e := s.runnerPoolRunBinding(ctx, tx, r.ID)
	if e != nil {
		return false, e
	}
	var membership sql.NullString
	e = tx.QueryRowContext(ctx, `SELECT pool_id::text FROM golf_runner_pool_workers WHERE forge_url=$1 AND runner_id=$2`, s.config.GiteaURL, worker).Scan(&membership)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return false, errStorageUnavailable
	}
	if membership.Valid != b.PoolID.Valid || membership.Valid && membership.String != b.PoolID.String {
		return false, nil
	}
	var owner, version int64
	var current sql.NullString
	e = tx.QueryRowContext(ctx, `SELECT owner_id,version,pool_id::text FROM golf_repository_runner_placements WHERE forge_url=$1 AND repository_id=$2`, s.config.GiteaURL, r.RepositoryID).Scan(&owner, &version, &current)
	if errors.Is(e, sql.ErrNoRows) {
		owner = r.OwnerID
		version = 0
	} else if e != nil {
		return false, errStorageUnavailable
	}
	if owner != r.OwnerID || version != b.PlacementVersion || current.Valid != b.PoolID.Valid || current.Valid && current.String != b.PoolID.String {
		return false, errRunnerPoolStale
	}
	var capacity int
	var configVersion int64
	var runtime, poolState string
	var enabled bool
	if b.PoolID.Valid {
		if e = s.lockRunnerPool(ctx, tx, b.PoolID.String); e != nil {
			return false, e
		}
		e = tx.QueryRowContext(ctx, `SELECT version,runtime,state,repository_assignment_enabled,max_parallel_attempts FROM golf_runner_pools WHERE forge_url=$1 AND id=$2::uuid`, s.config.GiteaURL, b.PoolID.String).Scan(&configVersion, &runtime, &poolState, &enabled, &capacity)
		if e != nil {
			return false, errStorageUnavailable
		}
		if !b.PoolVersion.Valid || configVersion != b.PoolVersion.Int64 || runtime != "local-docker" || !enabled {
			return false, errRunnerPoolStale
		}
		if poolState != "active" {
			return false, nil
		}
	}
	locked, e := scanWorkflowRun(tx.QueryRowContext(ctx, `SELECT `+workflowRunColumns+` FROM golf_workflow_runs WHERE forge_url=$1 AND id=$2::uuid FOR UPDATE`, s.config.GiteaURL, r.ID))
	if e != nil {
		return false, errStorageUnavailable
	}
	if locked.State != "queued" {
		return false, nil
	}
	if !sameRunnerPoolClaimTarget(r, locked) {
		return false, errRunnerPoolStale
	}
	var busy bool
	e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_workflow_runs WHERE forge_url=$1 AND runner_id=$2 AND state='running')`, s.config.GiteaURL, worker).Scan(&busy)
	if e != nil {
		return false, errStorageUnavailable
	}
	if busy {
		return false, nil
	}
	if b.PoolID.Valid {
		var active int64
		e = tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_workflow_runs WHERE forge_url=$1 AND runner_pool_id=$2::uuid AND state='running'`, s.config.GiteaURL, b.PoolID.String).Scan(&active)
		if e != nil {
			return false, errStorageUnavailable
		}
		if active >= int64(capacity) {
			return false, nil
		}
	}
	return true, nil
}

// Candidate/native/policy inspection happened before these locks. The final
// selected row must still be that exact actor, target, source and admission.
// Do not load command/archive payload into this metadata-only comparison.
func sameRunnerPoolClaimTarget(a, b workflowRunRecord) bool {
	return a.ID == b.ID && a.ForgeURL == b.ForgeURL && a.Version == b.Version && a.RunnerPlacement == b.RunnerPlacement && a.ResourceBound == b.ResourceBound && a.Resources == b.Resources && a.ResourceInstanceVersion == b.ResourceInstanceVersion &&
		a.RepositoryID == b.RepositoryID && a.OwnerID == b.OwnerID && a.RepositoryOwner == b.RepositoryOwner && a.RepositoryName == b.RepositoryName && a.OrganizationOwned == b.OrganizationOwned &&
		a.UserID == b.UserID && bytes.Equal(a.SessionHash, b.SessionHash) &&
		a.CommitID == b.CommitID && a.WorkflowPath == b.WorkflowPath && a.BlobID == b.BlobID && a.Format == b.Format && a.SourceSHA256 == b.SourceSHA256 && a.EngineCatalog == b.EngineCatalog &&
		a.SourceStorage == b.SourceStorage && a.SourceKey == b.SourceKey && a.SourceFingerprint == b.SourceFingerprint && a.SourceProfileID == b.SourceProfileID && a.SourceProfileVersion == b.SourceProfileVersion &&
		a.Origin == b.Origin && a.EventRef == b.EventRef && a.AutomationGrantID == b.AutomationGrantID && a.AutomationGrantRevision == b.AutomationGrantRevision && a.AutomationGrantEpoch == b.AutomationGrantEpoch && a.AutomationCredentialVersion == b.AutomationCredentialVersion && a.RepositoryEventID == b.RepositoryEventID &&
		a.IdempotencyKey == b.IdempotencyKey && bytes.Equal(a.InputHash, b.InputHash) && bytes.Equal(a.PolicyEpochs, b.PolicyEpochs) && !b.CancelRequested
}

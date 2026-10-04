package server

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

var errRunnerResourcesStale = errors.New("Runner resource admission is missing or changed; inspect this run and explicitly dispatch new work. No automatic retry is made.")

const runnerLimitsColumns = `cpu_millis,memory_bytes,pids,timeout_seconds`

type instanceRunnerLimitRecord struct {
	Limits  runner.JobLimits
	Version int64
	Updated time.Time
}

func limitsFromWire(w *golfv1.RunnerJobLimits) (runner.JobLimits, error) {
	if w == nil {
		return runner.JobLimits{}, invalid("Provide all four local Docker resource ceilings.")
	}
	l := runner.JobLimits{CPUMillis: w.CpuMillis, MemoryBytes: w.MemoryBytes, Pids: w.Pids, TimeoutSeconds: w.TimeoutSeconds}
	if l.Validate() != nil {
		return l, invalid("Use CPU 100–1000 millis, canonical memory 67108864–268435456 bytes, 16–64 PIDs and 1–900 seconds.")
	}
	return l, nil
}
func limitsWire(l runner.JobLimits) *golfv1.RunnerJobLimits {
	return &golfv1.RunnerJobLimits{CpuMillis: l.CPUMillis, MemoryBytes: l.MemoryBytes, Pids: l.Pids, TimeoutSeconds: l.TimeoutSeconds}
}
func instanceLimitsWire(r instanceRunnerLimitRecord) *golfv1.InstanceRunnerLimits {
	return &golfv1.InstanceRunnerLimits{Limits: limitsWire(r.Limits), Version: strconv.FormatInt(r.Version, 10), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}
}
func (s *Server) ensureInstanceRunnerLimits(ctx context.Context) error {
	if s.db == nil {
		return nil
	}
	_, e := s.db.ExecContext(ctx, `INSERT INTO golf_instance_runner_limits(forge_url,version,cpu_millis,memory_bytes,pids,timeout_seconds,actor_user_id) VALUES($1,0,1000,268435456,64,900,0) ON CONFLICT(forge_url) DO NOTHING`, s.config.GiteaURL)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

type runnerLimitReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *Server) instanceRunnerLimits(ctx context.Context, q runnerLimitReader, shared bool) (instanceRunnerLimitRecord, error) {
	var r instanceRunnerLimitRecord
	query := `SELECT ` + runnerLimitsColumns + `,version,updated_at FROM golf_instance_runner_limits WHERE forge_url=$1`
	if shared {
		query += ` FOR SHARE`
	}
	if e := q.QueryRowContext(ctx, query, s.config.GiteaURL).Scan(&r.Limits.CPUMillis, &r.Limits.MemoryBytes, &r.Limits.Pids, &r.Limits.TimeoutSeconds, &r.Version, &r.Updated); e != nil || r.Limits.Validate() != nil || r.Version < 0 {
		return r, errStorageUnavailable
	}
	return r, nil
}
func (s *Server) GetInstanceRunnerLimits(ctx context.Context, req *connect.Request[golfv1.GetInstanceRunnerLimitsRequest]) (*connect.Response[golfv1.GetInstanceRunnerLimitsResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if s.db == nil {
		return nil, runnerPoolRPCError(errStorageUnavailable)
	}
	token, e := runnerControlCredential(ctx)
	if e != nil {
		return nil, e
	}
	value := s.cookieValue(req.Header())
	if e = s.requireInstanceAdmin(ctx, value, token); e != nil {
		return nil, e
	}
	policy, e := s.instanceRunnerLimits(ctx, s.db, false)
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	if e = s.requireInstanceAdmin(ctx, value, token); e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.GetInstanceRunnerLimitsResponse{Policy: instanceLimitsWire(policy)}), nil
}
func (s *Server) SetInstanceRunnerLimits(ctx context.Context, req *connect.Request[golfv1.SetInstanceRunnerLimitsRequest]) (*connect.Response[golfv1.SetInstanceRunnerLimitsResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if s.db == nil {
		return nil, runnerPoolRPCError(errStorageUnavailable)
	}
	limits, e := limitsFromWire(req.Msg.Limits)
	if e != nil {
		return nil, e
	}
	v, ok := runnerControlVersion(req.Msg.ExpectedVersion)
	if !ok || v == int64(^uint64(0)>>1) {
		return nil, invalid("Provide the current exact instance ceiling version.")
	}
	token, e := runnerControlCredential(ctx)
	if e != nil {
		return nil, e
	}
	value := s.cookieValue(req.Header())
	initial, e := s.confirmInfrastructureAdmin(ctx, value, token, req.Msg.CurrentPassword)
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	var result instanceRunnerLimitRecord
	// Generation edit never locks active runs/pools/placements. Future consumers detect
	// the changed immutable generation and cancel; this is not instant host quiescence.
	e = s.infrastructureAdminTransaction(ctx, value, initial, func(tx *sql.Tx) error {
		row := tx.QueryRowContext(ctx, `UPDATE golf_instance_runner_limits SET version=version+1,cpu_millis=$3,memory_bytes=$4,pids=$5,timeout_seconds=$6,actor_user_id=$7,updated_at=clock_timestamp() WHERE forge_url=$1 AND version=$2 RETURNING `+runnerLimitsColumns+`,version,updated_at`, s.config.GiteaURL, v, limits.CPUMillis, limits.Memory(), limits.Pids, limits.TimeoutSeconds, initial.UserID)
		e := row.Scan(&result.Limits.CPUMillis, &result.Limits.MemoryBytes, &result.Limits.Pids, &result.Limits.TimeoutSeconds, &result.Version, &result.Updated)
		if errors.Is(e, sql.ErrNoRows) {
			return errRunnerPoolConflict
		}
		if e != nil {
			return errStorageUnavailable
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO golf_instance_runner_limit_audit(forge_url,version,actor_user_id,cpu_millis,memory_bytes,pids,timeout_seconds) VALUES($1,$2,$3,$4,$5,$6,$7)`, s.config.GiteaURL, result.Version, initial.UserID, limits.CPUMillis, limits.Memory(), limits.Pids, limits.TimeoutSeconds)
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	return connect.NewResponse(&golfv1.SetInstanceRunnerLimitsResponse{Policy: instanceLimitsWire(result)}), nil
}
func resourceBinding(r workflowRunRecord) runner.JobResourceBinding {
	b := runner.JobResourceBinding{Profile: runner.JobLimitsProfile, Limits: r.Resources, InstanceVersion: strconv.FormatInt(r.ResourceInstanceVersion, 10), PlacementVersion: strconv.FormatInt(r.RunnerPlacement.PlacementVersion, 10), Bound: r.ResourceBound}
	if r.RunnerPlacement.PoolID.Valid {
		b.PoolID = r.RunnerPlacement.PoolID.String
		b.PoolVersion = strconv.FormatInt(r.RunnerPlacement.PoolVersion.Int64, 10)
	}
	return b
}
func resourceBindingWire(r workflowRunRecord) *golfv1.WorkflowJobResourceBinding {
	if !r.ResourceBound {
		return &golfv1.WorkflowJobResourceBinding{Bound: false}
	}
	b := resourceBinding(r)
	return &golfv1.WorkflowJobResourceBinding{Profile: b.Profile, Limits: limitsWire(b.Limits), InstanceVersion: b.InstanceVersion, PoolId: b.PoolID, PoolVersion: b.PoolVersion, PlacementVersion: b.PlacementVersion, Bound: b.Bound}
}

// Existing placement→worker→pool locks must precede this short shared instance
// lock. No native HTTP is issued while it is held; instance edits lock no run.
func (s *Server) runnerResourceFence(ctx context.Context, tx *sql.Tx, r workflowRunRecord) error {
	if resourceBinding(r).Validate() != nil {
		return errRunnerResourcesStale
	}
	i, e := s.instanceRunnerLimits(ctx, tx, true)
	if e != nil {
		return e
	}
	if i.Version != r.ResourceInstanceVersion {
		return errRunnerResourcesStale
	}
	limits := i.Limits
	var owner, version int64
	var selected sql.NullString
	var a runner.JobLimits
	e = tx.QueryRowContext(ctx, `SELECT owner_id,version,pool_id::text,`+runnerLimitsColumns+` FROM golf_repository_runner_placements WHERE forge_url=$1 AND repository_id=$2`, s.config.GiteaURL, r.RepositoryID).Scan(&owner, &version, &selected, &a.CPUMillis, &a.MemoryBytes, &a.Pids, &a.TimeoutSeconds)
	if errors.Is(e, sql.ErrNoRows) {
		version = 0
	} else if e != nil {
		return errStorageUnavailable
	} else if owner != r.OwnerID || a.Validate() != nil {
		return errRunnerResourcesStale
	} else {
		limits = runner.MinimumJobLimits(limits, a)
	}
	if version != r.RunnerPlacement.PlacementVersion || selected != r.RunnerPlacement.PoolID {
		return errRunnerResourcesStale
	}
	if selected.Valid {
		var p runner.JobLimits
		var pv int64
		var state string
		var enabled bool
		e = tx.QueryRowContext(ctx, `SELECT version,state,repository_assignment_enabled,`+runnerLimitsColumns+` FROM golf_runner_pools WHERE forge_url=$1 AND id=$2::uuid`, s.config.GiteaURL, selected.String).Scan(&pv, &state, &enabled, &p.CPUMillis, &p.MemoryBytes, &p.Pids, &p.TimeoutSeconds)
		if e != nil {
			return errStorageUnavailable
		}
		if !r.RunnerPlacement.PoolVersion.Valid || pv != r.RunnerPlacement.PoolVersion.Int64 || p.Validate() != nil || !enabled {
			return errRunnerResourcesStale
		}
		limits = runner.MinimumJobLimits(limits, p)
		// Drain itself fences a previous version; no claimed attempt silently refreshes.
	}
	if limits != r.Resources {
		return errRunnerResourcesStale
	}
	return nil
}

// A second short current generation observation precedes returning an assignment.
// It issues no native request, takes no reverse locks, and never refreshes the run.
func (s *Server) runnerResourceObservation(ctx context.Context, r workflowRunRecord) error {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	if e = s.lockRunnerPlacement(ctx, tx, r.RepositoryID); e != nil {
		return e
	}
	if r.RunnerPlacement.PoolID.Valid {
		if e = s.lockRunnerPool(ctx, tx, r.RunnerPlacement.PoolID.String); e != nil {
			return e
		}
	}
	if e = s.runnerResourceFence(ctx, tx, r); e != nil {
		return e
	}
	if tx.Commit() != nil {
		return errStorageUnavailable
	}
	return nil
}

func (s *Server) rejectRunnerResourcesRun(ctx context.Context, r workflowRunRecord) error {
	_, e := s.db.ExecContext(ctx, `UPDATE golf_workflow_runs SET state='cancelled',version=version+1,finished_at=clock_timestamp(),reason=$4,cancel_requested=true WHERE forge_url=$1 AND id=$2::uuid AND version=$3 AND state='queued' AND repository_id=$5 AND owner_id=$6 AND commit_id=$7 AND source_sha256=$8 AND resource_bound=$9 AND resource_instance_version=$10`, s.config.GiteaURL, r.ID, r.Version, errRunnerResourcesStale.Error(), r.RepositoryID, r.OwnerID, r.CommitID, r.SourceSHA256, r.ResourceBound, r.ResourceInstanceVersion)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

func (s *Server) cancelRunnerResourceAttempt(ctx context.Context, id string) error {
	_, e := s.db.ExecContext(ctx, `UPDATE golf_workflow_runs SET state='cancelled',reason=$2,version=version+1,finished_at=clock_timestamp(),cancel_requested=true,lease_token_hash=NULL WHERE id=$1::uuid AND forge_url=$3 AND state='running'`, id, errRunnerResourcesStale.Error(), s.config.GiteaURL)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

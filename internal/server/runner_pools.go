package server

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const runnerPoolColumns = `id::text,name,version,runtime,state,max_parallel_attempts,repository_assignment_enabled,created_at,updated_at`

type runnerPoolRecord struct {
	ID, Name, Runtime, State string
	Version                  int64
	Capacity                 uint32
	Enabled                  bool
	Created, Updated         time.Time
}

func scanRunnerPool(q workflowRunScanner) (runnerPoolRecord, error) {
	var r runnerPoolRecord
	e := q.Scan(&r.ID, &r.Name, &r.Version, &r.Runtime, &r.State, &r.Capacity, &r.Enabled, &r.Created, &r.Updated)
	if errors.Is(e, sql.ErrNoRows) {
		return r, errResourceNotFound
	}
	if e != nil {
		return r, errStorageUnavailable
	}
	return r, nil
}
func runnerPoolState(v golfv1.RunnerPoolState) string {
	switch v {
	case golfv1.RunnerPoolState_RUNNER_POOL_STATE_ACTIVE:
		return "active"
	case golfv1.RunnerPoolState_RUNNER_POOL_STATE_DRAINING:
		return "draining"
	}
	return ""
}
func poolWire(r runnerPoolRecord, workers []string) *golfv1.RunnerPool {
	state := golfv1.RunnerPoolState_RUNNER_POOL_STATE_ACTIVE
	if r.State == "draining" {
		state = golfv1.RunnerPoolState_RUNNER_POOL_STATE_DRAINING
	}
	return &golfv1.RunnerPool{Id: r.ID, Name: r.Name, Version: strconv.FormatInt(r.Version, 10), Runtime: r.Runtime, State: state, MaxParallelAttempts: r.Capacity, WorkerIds: workers, RepositoryAssignmentEnabled: r.Enabled, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}
}
func validatePoolInput(m *golfv1.SaveRunnerPoolRequest, keys map[string][32]byte) (int64, []string, error) {
	v, ok := runnerControlVersion(m.ExpectedVersion)
	if !ok || !creationKey.MatchString(m.Id) || m.Runtime != "local-docker" || runnerPoolState(m.State) == "" || m.MaxParallelAttempts < 1 || m.MaxParallelAttempts > 100 || (len(m.WorkerIds) == 0 && m.State != golfv1.RunnerPoolState_RUNNER_POOL_STATE_DRAINING) || len(m.WorkerIds) > 100 || !utf8.ValidString(m.Name) || len(m.Name) > 128 || strings.TrimSpace(m.Name) != m.Name || m.Name == "" {
		return 0, nil, invalid("Provide a named local-docker pool, exact UUID/version, up to 100 enrolled workers and 1–100 parallel attempts. An active pool requires a worker.")
	}
	for _, r := range m.Name {
		if unicode.IsControl(r) {
			return 0, nil, invalid("Pool names cannot contain control characters.")
		}
	}
	workers := append([]string(nil), m.WorkerIds...)
	sort.Strings(workers)
	for i, id := range workers {
		if _, enrolled := keys[id]; !enrolled || !runnerIdentifier.MatchString(id) || i > 0 && id == workers[i-1] {
			return 0, nil, invalid("Select unique already operator-enrolled worker identities.")
		}
	}
	return v, workers, nil
}
func runnerPoolRPCError(e error) error {
	if errors.Is(e, errRunnerPoolConflict) {
		return connect.NewError(connect.CodeAborted, errRunnerPoolConflict)
	}
	if errors.Is(e, errRunnerPoolStale) || errors.Is(e, errRunnerPoolUnavailable) {
		return connect.NewError(connect.CodeFailedPrecondition, e)
	}
	return infrastructureRPCError(e)
}
func (s *Server) poolWorkers(ctx context.Context, tx *sql.Tx, id string) ([]string, error) {
	rows, e := tx.QueryContext(ctx, `SELECT runner_id FROM golf_runner_pool_workers WHERE forge_url=$1 AND pool_id=$2::uuid ORDER BY runner_id`, s.config.GiteaURL, id)
	if e != nil {
		return nil, errStorageUnavailable
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) != nil || !runnerIdentifier.MatchString(id) || len(out) >= 100 {
			return nil, errStorageUnavailable
		}
		out = append(out, id)
	}
	if rows.Err() != nil {
		return nil, errStorageUnavailable
	}
	return out, nil
}
func (s *Server) poolInventory(ctx context.Context, tx *sql.Tx, admin bool) ([]*golfv1.RunnerPool, error) {
	rows, e := tx.QueryContext(ctx, `SELECT `+runnerPoolColumns+` FROM golf_runner_pools WHERE forge_url=$1 ORDER BY name,id`, s.config.GiteaURL)
	if e != nil {
		return nil, errStorageUnavailable
	}
	records := []runnerPoolRecord{}
	for rows.Next() {
		r, e := scanRunnerPool(rows)
		if e != nil || len(records) >= 20 {
			rows.Close()
			return nil, errStorageUnavailable
		}
		records = append(records, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, errStorageUnavailable
	}
	result := []*golfv1.RunnerPool{}
	for _, r := range records {
		ids, e := s.poolWorkers(ctx, tx, r.ID)
		if e != nil {
			return nil, e
		}
		w := poolWire(r, ids)
		if admin {
			var count int64
			if tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_workflow_runs WHERE forge_url=$1 AND runner_pool_id=$2::uuid AND state='running'`, s.config.GiteaURL, r.ID).Scan(&count) != nil {
				return nil, errStorageUnavailable
			}
			v := strconv.FormatInt(count, 10)
			w.ActiveAttemptCount = &v
		}
		result = append(result, w)
	}
	return result, nil
}
func (s *Server) ListRunnerPools(ctx context.Context, req *connect.Request[golfv1.ListRunnerPoolsRequest]) (*connect.Response[golfv1.ListRunnerPoolsResponse], error) {
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
	tx, e := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if e != nil {
		return nil, runnerPoolRPCError(errStorageUnavailable)
	}
	defer tx.Rollback()
	rows, e := s.poolInventory(ctx, tx, true)
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	if e = s.requireInstanceAdmin(ctx, value, token); e != nil {
		return nil, e
	}
	ids := make([]string, 0, len(s.runnerKeys))
	for id := range s.runnerKeys {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return connect.NewResponse(&golfv1.ListRunnerPoolsResponse{Pools: rows, EnrolledWorkerIds: ids}), nil
}
func (s *Server) SaveRunnerPool(ctx context.Context, req *connect.Request[golfv1.SaveRunnerPoolRequest]) (*connect.Response[golfv1.SaveRunnerPoolResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if s.db == nil {
		return nil, runnerPoolRPCError(errStorageUnavailable)
	}
	token, e := runnerControlCredential(ctx)
	if e != nil {
		return nil, e
	}
	m := req.Msg
	version, workers, e := validatePoolInput(m, s.runnerKeys)
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	value := s.cookieValue(req.Header())
	initial, e := s.confirmInfrastructureAdmin(ctx, value, token, m.CurrentPassword)
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	var result *golfv1.RunnerPool
	e = s.infrastructureAdminTransaction(ctx, value, initial, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, s.config.GiteaURL+"/runner-pool-catalog"); e != nil {
			return errStorageUnavailable
		}
		old, e := scanRunnerPool(tx.QueryRowContext(ctx, `SELECT `+runnerPoolColumns+` FROM golf_runner_pools WHERE forge_url=$1 AND id=$2::uuid`, s.config.GiteaURL, m.Id))
		fresh := errors.Is(e, errResourceNotFound)
		if e != nil && !fresh {
			return e
		}
		if fresh && version != 0 || !fresh && old.Version != version {
			return errRunnerPoolConflict
		}
		if version == int64(^uint64(0)>>1) {
			return errStorageUnavailable
		}
		prior := []string{}
		if !fresh {
			prior, e = s.poolWorkers(ctx, tx, m.Id)
			if e != nil {
				return e
			}
		}
		all := map[string]bool{}
		for _, id := range append(append([]string{}, prior...), workers...) {
			all[id] = true
		}
		ordered := make([]string, 0, len(all))
		for id := range all {
			ordered = append(ordered, id)
		}
		sort.Strings(ordered)
		for _, id := range ordered {
			if e = s.lockRunnerControl(ctx, tx, id); e != nil {
				return errStorageUnavailable
			}
		}
		if e = s.lockRunnerPool(ctx, tx, m.Id); e != nil {
			return e
		}
		wanted := map[string]bool{}
		for _, id := range workers {
			wanted[id] = true
			state, _, e := s.runnerControl(ctx, tx, id)
			if e != nil {
				return errStorageUnavailable
			}
			if state == "revoked" {
				return invalid("A terminally revoked worker cannot join a pool.")
			}
			var other string
			e = tx.QueryRowContext(ctx, `SELECT pool_id::text FROM golf_runner_pool_workers WHERE forge_url=$1 AND runner_id=$2`, s.config.GiteaURL, id).Scan(&other)
			if e != nil && !errors.Is(e, sql.ErrNoRows) {
				return errStorageUnavailable
			}
			if e == nil && other != m.Id {
				return invalid("A worker can belong to only one pool. Remove idle membership explicitly before selecting another pool.")
			}
			if errors.Is(e, sql.ErrNoRows) {
				var busy bool
				if tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_workflow_runs WHERE forge_url=$1 AND runner_id=$2 AND state='running')`, s.config.GiteaURL, id).Scan(&busy) != nil {
					return errStorageUnavailable
				}
				if busy {
					return invalid("A worker with an active attempt cannot join a pool.")
				}
			}
		}
		for _, id := range prior {
			if !wanted[id] {
				var busy bool
				if tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_workflow_runs WHERE forge_url=$1 AND runner_id=$2 AND state='running')`, s.config.GiteaURL, id).Scan(&busy) != nil {
					return errStorageUnavailable
				}
				if busy {
					return invalid("A worker with an active attempt cannot leave its pool.")
				}
			}
		}
		var nameUsed bool
		if tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_runner_pools WHERE forge_url=$1 AND name=$2 AND id<>$3::uuid)`, s.config.GiteaURL, m.Name, m.Id).Scan(&nameUsed) != nil {
			return errStorageUnavailable
		}
		if nameUsed {
			return invalid("That pool name already exists.")
		}
		if fresh {
			var count int
			if tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_runner_pools WHERE forge_url=$1`, s.config.GiteaURL).Scan(&count) != nil {
				return errStorageUnavailable
			}
			if count >= 20 {
				return invalid("The instance runner pool limit is 20.")
			}
		}
		r, e := scanRunnerPool(tx.QueryRowContext(ctx, `INSERT INTO golf_runner_pools(forge_url,id,name,version,runtime,state,max_parallel_attempts,repository_assignment_enabled,actor_user_id) VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(forge_url,id) DO UPDATE SET name=excluded.name,version=excluded.version,state=excluded.state,max_parallel_attempts=excluded.max_parallel_attempts,repository_assignment_enabled=excluded.repository_assignment_enabled,actor_user_id=excluded.actor_user_id,updated_at=clock_timestamp() RETURNING `+runnerPoolColumns, s.config.GiteaURL, m.Id, m.Name, version+1, m.Runtime, runnerPoolState(m.State), m.MaxParallelAttempts, m.RepositoryAssignmentEnabled, initial.UserID))
		if e != nil {
			return e
		}
		for _, id := range prior {
			if !wanted[id] {
				if _, e = tx.ExecContext(ctx, `DELETE FROM golf_runner_pool_workers WHERE forge_url=$1 AND runner_id=$2 AND pool_id=$3::uuid`, s.config.GiteaURL, id, m.Id); e != nil {
					return errStorageUnavailable
				}
			}
		}
		previous := map[string]bool{}
		for _, id := range prior {
			previous[id] = true
		}
		for _, id := range workers {
			if !previous[id] {
				if _, e = tx.ExecContext(ctx, `INSERT INTO golf_runner_pool_workers(forge_url,runner_id,pool_id) VALUES($1,$2,$3::uuid)`, s.config.GiteaURL, id, m.Id); e != nil {
					return errStorageUnavailable
				}
			}
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_runner_pool_audit(forge_url,pool_id,version,actor_user_id,name,state,max_parallel_attempts,repository_assignment_enabled,worker_ids) VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9)`, s.config.GiteaURL, m.Id, r.Version, initial.UserID, r.Name, r.State, r.Capacity, r.Enabled, workers); e != nil {
			return errStorageUnavailable
		}
		result = poolWire(r, workers)
		return nil
	})
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	return connect.NewResponse(&golfv1.SaveRunnerPoolResponse{Pool: result}), nil
}
func (s *Server) placementRecord(ctx context.Context, tx *sql.Tx, key repositoryKey, a *golfv1.RepositoryAccess) (*golfv1.RepositoryRunnerPlacement, error) {
	w := &golfv1.RepositoryRunnerPlacement{Repository: &golfv1.RepositoryKey{Owner: key.Owner, Name: key.Name}, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, AccessRevision: a.Revision, Version: "0", LegacyUnbound: true}
	var owner, version int64
	var id sql.NullString
	var poolVersion sql.NullInt64
	e := tx.QueryRowContext(ctx, `SELECT owner_id,version,pool_id::text,selected_pool_version FROM golf_repository_runner_placements WHERE forge_url=$1 AND repository_id=$2`, s.config.GiteaURL, a.RepositoryId).Scan(&owner, &version, &id, &poolVersion)
	if errors.Is(e, sql.ErrNoRows) {
		return w, nil
	}
	if e != nil {
		return nil, errStorageUnavailable
	}
	if strconv.FormatInt(owner, 10) != a.OwnerId {
		return nil, errRunnerPoolStale
	}
	w.Version = strconv.FormatInt(version, 10)
	if id.Valid {
		w.PoolId = id.String
		w.PoolVersion = strconv.FormatInt(poolVersion.Int64, 10)
		w.LegacyUnbound = false
	}
	return w, nil
}
func (s *Server) GetRepositoryRunnerPlacement(ctx context.Context, req *connect.Request[golfv1.GetRepositoryRunnerPlacementRequest]) (*connect.Response[golfv1.GetRepositoryRunnerPlacementResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if s.db == nil {
		return nil, runnerPoolRPCError(errStorageUnavailable)
	}
	token, value, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if e = validateRepositoryAccess(key, m.RepositoryId, m.OwnerId, m.ExpectedRevision, ""); e != nil {
		return nil, runnerPoolRPCError(e)
	}
	var result *golfv1.GetRepositoryRunnerPlacementResponse
	e = s.withForgeCaller(ctx, value, token, func(caller User) error {
		a, e := s.readRepositoryAccess(ctx, token, key, caller)
		if e != nil {
			return e
		}
		if e = accessMatches(a, m.RepositoryId, m.OwnerId, m.ExpectedRevision); e != nil {
			return e
		}
		tx, e := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
		if e != nil {
			return errStorageUnavailable
		}
		defer tx.Rollback()
		placement, e := s.placementRecord(ctx, tx, key, a)
		if e != nil {
			return e
		}
		pools, e := s.poolInventory(ctx, tx, false)
		if e != nil {
			return e
		}
		result = &golfv1.GetRepositoryRunnerPlacementResponse{Placement: placement, CanEdit: token.Local, PasswordConfirmationAvailable: token.Local}
		for _, p := range pools {
			if p.RepositoryAssignmentEnabled {
				result.EligiblePools = append(result.EligiblePools, p)
			}
			if p.Id == placement.PoolId {
				result.SelectedPool = p
			}
		}
		after, e := s.readRepositoryAccess(ctx, token, key, caller)
		if e != nil {
			return e
		}
		return accessMatches(after, m.RepositoryId, m.OwnerId, m.ExpectedRevision)
	})
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) SetRepositoryRunnerPlacement(ctx context.Context, req *connect.Request[golfv1.SetRepositoryRunnerPlacementRequest]) (*connect.Response[golfv1.SetRepositoryRunnerPlacementResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if s.db == nil {
		return nil, runnerPoolRPCError(errStorageUnavailable)
	}
	token, value, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	version, ok := runnerControlVersion(m.ExpectedPlacementVersion)
	poolVersion, validPoolVersion := runnerControlVersion(m.ExpectedPoolVersion)
	if e = validateRepositoryAccess(key, m.RepositoryId, m.OwnerId, m.ExpectedRevision, ""); e != nil {
		return nil, runnerPoolRPCError(e)
	}
	if !ok || (m.PoolId == "" && m.ExpectedPoolVersion != "") || (m.PoolId != "" && (!creationKey.MatchString(m.PoolId) || !validPoolVersion || poolVersion == 0)) {
		return nil, runnerPoolRPCError(invalid("Provide the current placement version and an explicitly selected pool/version or unbound mode."))
	}
	initial, e := s.ownSecuritySnapshot(ctx, value, token)
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	if e = s.consumeLocalLogin(ctx, initial.Username); e != nil {
		return nil, runnerPoolRPCError(e)
	}
	correct, e := verifyLocalPassword(ctx, m.CurrentPassword, initial.PasswordHash)
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	if !correct {
		return nil, runnerPoolRPCError(errPasswordConfirmation)
	}
	latest, e := s.ownSecuritySnapshot(ctx, value, token)
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	if !sameOwnSecurity(initial, latest) {
		return nil, runnerPoolRPCError(errUnauthenticated)
	}
	var result *golfv1.RepositoryRunnerPlacement
	e = s.withForgeCaller(ctx, value, token, func(caller User) error {
		return s.workflowTransaction(ctx, value, caller.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, hash []byte) error {
			q := database.New(s.db).WithTx(tx)
			current, e := q.GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
			if e != nil || !sameOwnSecurity(initial, current) {
				return errUnauthenticated
			}
			a, e := s.readRepositoryAccess(ctx, token, key, caller)
			if e != nil {
				return e
			}
			if e = accessMatches(a, m.RepositoryId, m.OwnerId, m.ExpectedRevision); e != nil {
				return e
			}
			repo, _ := discussionID(m.RepositoryId)
			owner, _ := discussionID(m.OwnerId)
			if _, e = s.lockRepositoryLifecycleTransaction(ctx, tx, repo); e != nil {
				return e
			}
			if e = s.lockRunnerPlacement(ctx, tx, repo); e != nil {
				return e
			}
			prior, e := s.placementRecord(ctx, tx, key, a)
			if e != nil {
				return e
			}
			if prior.Version != m.ExpectedPlacementVersion {
				return errRunnerPoolConflict
			}
			if version == int64(^uint64(0)>>1) {
				return errStorageUnavailable
			}
			var selected, selectedVersion any
			if m.PoolId != "" {
				if e = s.lockRunnerPool(ctx, tx, m.PoolId); e != nil {
					return e
				}
				p, e := scanRunnerPool(tx.QueryRowContext(ctx, `SELECT `+runnerPoolColumns+` FROM golf_runner_pools WHERE forge_url=$1 AND id=$2::uuid`, s.config.GiteaURL, m.PoolId))
				if e != nil {
					return e
				}
				if p.Version != poolVersion {
					return errRunnerPoolConflict
				}
				if !p.Enabled || p.Runtime != "local-docker" || p.State != "active" {
					return errRunnerPoolUnavailable
				}
				selected = m.PoolId
				selectedVersion = poolVersion
			}
			if _, e = tx.ExecContext(ctx, `INSERT INTO golf_repository_runner_placements(forge_url,repository_id,owner_id,version,pool_id,selected_pool_version,actor_user_id) VALUES($1,$2,$3,$4,$5::uuid,$6,$7) ON CONFLICT(forge_url,repository_id) DO UPDATE SET version=excluded.version,pool_id=excluded.pool_id,selected_pool_version=excluded.selected_pool_version,actor_user_id=excluded.actor_user_id,updated_at=clock_timestamp()`, s.config.GiteaURL, repo, owner, version+1, selected, selectedVersion, actor.UserID); e != nil {
				return errStorageUnavailable
			}
			if _, e = tx.ExecContext(ctx, `INSERT INTO golf_runner_placement_audit(forge_url,repository_id,owner_id,version,actor_user_id,pool_id,selected_pool_version) VALUES($1,$2,$3,$4,$5,$6::uuid,$7)`, s.config.GiteaURL, repo, owner, version+1, actor.UserID, selected, selectedVersion); e != nil {
				return errStorageUnavailable
			}
			after, e := s.readRepositoryAccess(ctx, token, key, caller)
			if e != nil {
				return e
			}
			if e = accessMatches(after, m.RepositoryId, m.OwnerId, m.ExpectedRevision); e != nil {
				return e
			}
			result, e = s.placementRecord(ctx, tx, key, a)
			return e
		})
	})
	if e != nil {
		return nil, runnerPoolRPCError(e)
	}
	return connect.NewResponse(&golfv1.SetRepositoryRunnerPlacementResponse{Placement: result}), nil
}

// Ordinary current native repository administration is required; global Golf
// administration, worker labels and eligible pool IDs never grant repo authority.

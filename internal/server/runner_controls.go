package server

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func runnerControlCredential(ctx context.Context) (forgeCredential, error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return token, err
	}
	_, delegated := ctx.Value(apiAuthKey{}).(apiAuth)
	if delegated || !token.Local {
		return forgeCredential{}, connect.NewError(connect.CodePermissionDenied, errors.New("A current managed Golf password session is required."))
	}
	return token, nil
}

var errRunnerControlConflict = errors.New("Runner control changed. Refresh and inspect the current state.")

func runnerControlName(state golfv1.RunnerControlState) string {
	switch state {
	case golfv1.RunnerControlState_RUNNER_CONTROL_STATE_ACTIVE:
		return "active"
	case golfv1.RunnerControlState_RUNNER_CONTROL_STATE_DRAINING:
		return "draining"
	case golfv1.RunnerControlState_RUNNER_CONTROL_STATE_REVOKED:
		return "revoked"
	}
	return ""
}
func runnerControlWire(state string) golfv1.RunnerControlState {
	switch state {
	case "active":
		return golfv1.RunnerControlState_RUNNER_CONTROL_STATE_ACTIVE
	case "draining":
		return golfv1.RunnerControlState_RUNNER_CONTROL_STATE_DRAINING
	case "revoked":
		return golfv1.RunnerControlState_RUNNER_CONTROL_STATE_REVOKED
	}
	return golfv1.RunnerControlState_RUNNER_CONTROL_STATE_UNSPECIFIED
}
func runnerControlTransition(old, next string) bool {
	return (old == "active" || old == "draining") && old != next && (next == "revoked" || old == "active" && next == "draining" || old == "draining" && next == "active")
}
func runnerControlVersion(value string) (int64, bool) {
	n, e := strconv.ParseInt(value, 10, 64)
	return n, e == nil && n >= 0 && strconv.FormatInt(n, 10) == value
}
func (s *Server) lockRunnerControl(ctx context.Context, tx *sql.Tx, id string) error {
	_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, s.config.GiteaURL+"/runner/"+id)
	return err
}

// The configured credential authenticates an identity but can never clear a
// retained revocation. Missing control means its original operator enrollment.
func (s *Server) runnerControl(ctx context.Context, tx *sql.Tx, id string) (string, int64, error) {
	var state string
	var version int64
	err := tx.QueryRowContext(ctx, `SELECT state,version FROM golf_runner_controls WHERE forge_url=$1 AND runner_id=$2`, s.config.GiteaURL, id).Scan(&state, &version)
	if errors.Is(err, sql.ErrNoRows) {
		return "active", 0, nil
	}
	return state, version, err
}
func (s *Server) enrolledRunnerInventory(ctx context.Context, tx *sql.Tx) ([]*golfv1.EnrolledRunner, error) {
	ids := make([]string, 0, len(s.runnerKeys))
	for id := range s.runnerKeys {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	rows := make([]*golfv1.EnrolledRunner, 0, len(ids))
	for _, id := range ids {
		state, version, err := s.runnerControl(ctx, tx, id)
		if err != nil {
			return nil, errStorageUnavailable
		}
		if runnerControlWire(state) == golfv1.RunnerControlState_RUNNER_CONTROL_STATE_UNSPECIFIED || version < 0 {
			return nil, errStorageUnavailable
		}
		var stamp sql.NullTime
		var recent, busy bool
		err = tx.QueryRowContext(ctx, `SELECT (SELECT last_seen FROM golf_runner_presence WHERE forge_url=$1 AND runner_id=$2),COALESCE((SELECT last_seen>clock_timestamp()-interval '15 seconds' AND last_seen<=clock_timestamp() FROM golf_runner_presence WHERE forge_url=$1 AND runner_id=$2),false),EXISTS(SELECT 1 FROM golf_workflow_runs WHERE forge_url=$1 AND runner_id=$2 AND state='running' AND lease_expires_at>clock_timestamp())`, s.config.GiteaURL, id).Scan(&stamp, &recent, &busy)
		if err != nil {
			return nil, errStorageUnavailable
		}
		row := &golfv1.EnrolledRunner{WorkerId: id, State: runnerControlWire(state), Version: strconv.FormatInt(version, 10), RecentConnection: recent, HasActiveAttempt: busy}
		if stamp.Valid {
			value := stamp.Time.Format(time.RFC3339Nano)
			row.LastSeen = &value
		}
		rows = append(rows, row)
	}
	return rows, nil
}
func (s *Server) GetInstanceRunners(ctx context.Context, req *connect.Request[golfv1.GetInstanceRunnersRequest]) (*connect.Response[golfv1.GetInstanceRunnersResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if s.db == nil {
		return nil, rpcError(errStorageUnavailable)
	}
	token, err := runnerControlCredential(ctx)
	if err != nil {
		return nil, err
	}
	value := s.cookieValue(req.Header())
	if err = s.requireInstanceAdmin(ctx, value, token); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	defer tx.Rollback()
	rows, err := s.enrolledRunnerInventory(ctx, tx)
	if err != nil {
		return nil, rpcError(err)
	}
	if err = s.requireInstanceAdmin(ctx, value, token); err != nil {
		return nil, err
	}
	return connect.NewResponse(&golfv1.GetInstanceRunnersResponse{Runners: rows}), nil
}
func (s *Server) UpdateRunnerControl(ctx context.Context, req *connect.Request[golfv1.UpdateRunnerControlRequest]) (*connect.Response[golfv1.UpdateRunnerControlResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if s.db == nil {
		return nil, rpcError(errStorageUnavailable)
	}
	token, err := runnerControlCredential(ctx)
	if err != nil {
		return nil, err
	}
	value := s.cookieValue(req.Header())
	m := req.Msg
	next := runnerControlName(m.State)
	version, ok := runnerControlVersion(m.ExpectedVersion)
	if _, enrolled := s.runnerKeys[m.WorkerId]; !enrolled || !runnerIdentifier.MatchString(m.WorkerId) || next == "" || !ok {
		return nil, rpcError(invalid("Select an enrolled worker and its current control version."))
	}
	initial, err := s.confirmInfrastructureAdmin(ctx, value, token, m.CurrentPassword)
	if err != nil {
		return nil, rpcError(err)
	}
	var result *golfv1.EnrolledRunner
	err = s.infrastructureAdminTransaction(ctx, value, initial, func(tx *sql.Tx) error {
		if err := s.lockRunnerControl(ctx, tx, m.WorkerId); err != nil {
			return errStorageUnavailable
		}
		old, current, err := s.runnerControl(ctx, tx, m.WorkerId)
		if err != nil {
			return errStorageUnavailable
		}
		if current != version {
			return errRunnerControlConflict
		}
		if !runnerControlTransition(old, next) {
			return invalid("Revocation is terminal. Re-enroll with a new operator-managed worker identity and key; Resume only applies to draining workers.")
		}
		if version == int64(^uint64(0)>>1) {
			return errStorageUnavailable
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO golf_runner_controls(forge_url,runner_id,state,version) VALUES($1,$2,$3,$4) ON CONFLICT(forge_url,runner_id) DO UPDATE SET state=excluded.state,version=excluded.version,updated_at=clock_timestamp()`, s.config.GiteaURL, m.WorkerId, next, version+1)
		if err != nil {
			return errStorageUnavailable
		}
		if next == "revoked" {
			// Fences all result/release capabilities; runner observes refusal and cleans
			// its owned execution. Cancellation is not a successful daemon-cleanup proof.
			_, err = tx.ExecContext(ctx, `UPDATE golf_workflow_runs SET state='cancelled',cancel_requested=true,version=version+1,finished_at=clock_timestamp(),reason='Enrolled worker was revoked.',lease_token_hash=NULL,lease_expires_at=NULL WHERE forge_url=$1 AND runner_id=$2 AND state='running'`, s.config.GiteaURL, m.WorkerId)
			if err != nil {
				return errStorageUnavailable
			}
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO golf_runner_control_audit(forge_url,runner_id,version,actor_user_id,previous_state,state) VALUES($1,$2,$3,$4,$5,$6)`, s.config.GiteaURL, m.WorkerId, version+1, initial.UserID, old, next)
		if err != nil {
			return errStorageUnavailable
		}
		rows, err := s.enrolledRunnerInventory(ctx, tx)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if row.WorkerId == m.WorkerId {
				result = row
			}
		}
		return nil
	})
	if errors.Is(err, errRunnerControlConflict) {
		return nil, connect.NewError(connect.CodeAborted, errRunnerControlConflict)
	}
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.UpdateRunnerControlResponse{Runner: result}), nil
}
func (s *Server) GetRepositoryRunners(ctx context.Context, req *connect.Request[golfv1.GetRepositoryRunnersRequest]) (*connect.Response[golfv1.GetRepositoryRunnersResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if s.db == nil {
		return nil, rpcError(errStorageUnavailable)
	}
	token, err := runnerControlCredential(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	repoID, e := strconv.ParseInt(m.RepositoryId, 10, 64)
	ownerID, e2 := strconv.ParseInt(m.OwnerId, 10, 64)
	if e != nil || e2 != nil || repoID <= 0 || ownerID <= 0 || strconv.FormatInt(repoID, 10) != m.RepositoryId || strconv.FormatInt(ownerID, 10) != m.OwnerId || !executionWorkflowPath(m.WorkflowPath) {
		return nil, rpcError(invalid("Provide exact repository/owner IDs and a supported workflow path."))
	}
	key := keyFrom(m.Repository)
	var result *golfv1.GetRepositoryRunnersResponse
	err = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, key, func(_ string, repo Repository) error {
		if repo.ID != repoID {
			return errInvalidForgeResponse
		}
		settings, _, err := s.readRepositorySettings(ctx, token, key)
		if err != nil {
			return err
		}
		if settings.ID != repoID || settings.Owner == nil || settings.Owner.ID != ownerID {
			return errInvalidForgeResponse
		}
		org, err := s.repositoryOwnerKind(ctx, token, *settings.Owner)
		if err != nil {
			return err
		}
		tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if err != nil {
			return errStorageUnavailable
		}
		defer tx.Rollback()
		states, _, err := s.readExecutionPolicyStates(ctx, tx, repoID, ownerID, org, false)
		if err != nil {
			return err
		}
		rows, err := s.enrolledRunnerInventory(ctx, tx)
		if err != nil {
			return err
		}
		after, _, err := s.readRepositorySettings(ctx, token, key)
		if err != nil {
			return err
		}
		if after.ID != repoID || after.Owner == nil || after.Owner.ID != ownerID || !strings.EqualFold(after.FullName, settings.FullName) {
			return errInvalidForgeResponse
		}
		result = &golfv1.GetRepositoryRunnersResponse{Repository: &golfv1.RepositoryKey{Owner: after.Owner.Login, Name: after.Name}, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, WorkflowPath: m.WorkflowPath, ManualAllowed: executionPoliciesAllow(states, repoID, ownerID, org, "manual", m.WorkflowPath), PushAllowed: executionPoliciesAllow(states, repoID, ownerID, org, "push", m.WorkflowPath), Runners: rows}
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

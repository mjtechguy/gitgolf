package server

import (
	"context"
	"strconv"
)

// Lazy cleanup is bounded to the original record. TTL enforcement never waits
// for this bookkeeping and does not depend on a deployment worker/timer.
func (s *Server) expireDeployment(ctx context.Context, d *deploymentRecord) (*deploymentRecord, error) {
	repo, e := strconv.ParseInt(d.wire.Target.RepositoryId, 10, 64)
	if e != nil {
		return nil, errStorageUnavailable
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return nil, errStorageUnavailable
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, "SELECT golf_deployment_lock($1,$2)", s.config.ForgeURL, repo); e != nil {
		return nil, errStorageUnavailable
	}
	result, e := tx.ExecContext(ctx, "UPDATE golf_repository_deployments SET state='EXPIRED',version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND state='READY' AND expires_at<=clock_timestamp()", d.wire.Id)
	if e != nil {
		return nil, errStorageUnavailable
	}
	n, _ := result.RowsAffected()
	current, e := scanDeployment(tx.QueryRowContext(ctx, "SELECT "+deploymentColumns+" FROM golf_repository_deployments WHERE id=$1", d.wire.Id))
	if e != nil {
		return nil, e
	}
	if n == 1 {
		if _, e = tx.ExecContext(ctx, "INSERT INTO golf_deployment_events(deployment_id,version,state,actor_id) VALUES($1,$2,'EXPIRED',NULL)", d.wire.Id, current.wire.Version); e != nil {
			return nil, errStorageUnavailable
		}
		if _, e = tx.ExecContext(ctx, "DELETE FROM golf_preview_credentials WHERE deployment_id=$1", d.wire.Id); e != nil {
			return nil, errStorageUnavailable
		}
	}
	if tx.Commit() != nil {
		return nil, errStorageUnavailable
	}
	return current, nil
}

package server

import (
	"context"
	"database/sql"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

type localMFARecoveryEffect struct{ sessions, challenges, codes int64 }

// Both recovery callers hold the immutable Golf-user/account/MFA rows. This
// shared effect keeps every recovery ingress on the same revocation contract.
func resetLocalMFALocked(ctx context.Context, tx *sql.Tx, q *database.Queries, account, user, credentialVersion, mfaVersion int64) (localMFARecoveryEffect, error) {
	var out localMFARecoveryEffect
	for _, write := range []struct {
		query   string
		version int64
	}{{`UPDATE golf_local_mfa SET version=version+1,enabled=false,active_content_id=NULL,pending_content_id=NULL,pending_expires_at=NULL,last_counter=-1 WHERE account_id=$1 AND version=$2`, mfaVersion}, {`UPDATE golf_local_accounts SET credential_version=credential_version+1 WHERE id=$1 AND credential_version=$2`, credentialVersion}} {
		result, e := tx.ExecContext(ctx, write.query, account, write.version)
		if e != nil {
			return out, errStorageUnavailable
		}
		n, e := result.RowsAffected()
		if e != nil {
			return out, errStorageUnavailable
		}
		if n != 1 {
			return out, errAdminAccountConflict
		}
	}
	var e error
	out.sessions, e = q.DeleteMFABrowserSessions(ctx, database.DeleteMFABrowserSessionsParams{UserID: user, LocalAccountID: sql.NullInt64{Int64: account, Valid: true}})
	if e != nil {
		return out, errStorageUnavailable
	}
	for _, write := range []struct {
		query string
		count *int64
	}{{`DELETE FROM golf_mfa_login_challenges WHERE account_id=$1`, &out.challenges}, {`DELETE FROM golf_mfa_recovery_codes WHERE account_id=$1`, &out.codes}} {
		result, e := tx.ExecContext(ctx, write.query, account)
		if e != nil {
			return out, errStorageUnavailable
		}
		*write.count, e = result.RowsAffected()
		if e != nil {
			return out, errStorageUnavailable
		}
	}
	if _, e = tx.ExecContext(ctx, `DELETE FROM golf_mfa_attempts WHERE account_id=$1`, account); e != nil {
		return out, errStorageUnavailable
	}
	return out, nil
}

package server

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

// Provider verification happens before taking account/session locks. The RPC
// boundary has already resolved any OAuth refresh; resolving it again while
// holding these locks could block on our own session row.
//
// All account operations lock the immutable Golf user first, then the caller
// session. This serializes competing bulk revocations without each request
// holding the session that its competitor needs to delete. Login locks affected
// accounts in sorted order; logout locks its account first. OAuth refresh only
// locks sessions and never requests a user lock. A revoked/expired caller is
// rechecked after either lock wait.
func (s *Server) withManagedSession(ctx context.Context, value string, credential forgeCredential, operation func(*database.Queries, database.LockManagedSessionRow, []byte) error) error {
	hash, err := sessionHash(value)
	if err != nil {
		return errUnauthenticated
	}
	if s.db == nil {
		return errStorageUnavailable
	}
	user, err := s.currentUser(ctx, credential)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	queries := database.New(s.db).WithTx(tx)
	identity, err := queries.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: hash, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return errUnauthenticated
	}
	if err != nil {
		return errStorageUnavailable
	}
	if user.ID != identity.ForgeUserID {
		return errUnauthenticated
	}
	caller, err := queries.LockManagedSession(ctx, database.LockManagedSessionParams{CallerTokenHash: hash, UserID: identity.ID, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return errUnauthenticated
	}
	if err != nil {
		return errStorageUnavailable
	}
	if !caller.ExpiresAt.After(time.Now()) {
		return errUnauthenticated
	}
	err = operation(queries, caller, hash)
	// A target row may have been locked by another in-flight request. Never
	// commit a revocation or reveal a listing after the caller's absolute expiry.
	if !caller.ExpiresAt.After(time.Now()) {
		return errUnauthenticated
	}
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return errStorageUnavailable
	}
	return nil
}

func (s *Server) listSessions(ctx context.Context, value string, credential forgeCredential, request pageRequest) ([]database.ListManagedSessionsRow, uint32, error) {
	page, limit, err := pagination(request)
	if err != nil {
		return nil, 0, err
	}
	var rows []database.ListManagedSessionsRow
	err = s.withManagedSession(ctx, value, credential, func(queries *database.Queries, caller database.LockManagedSessionRow, hash []byte) error {
		var err error
		rows, err = queries.ListManagedSessions(ctx, database.ListManagedSessionsParams{
			CallerTokenHash: hash, UserID: caller.UserID, ForgeURL: s.config.GiteaURL,
			RowLimit: int32(limit + 1), RowOffset: int32((page - 1) * limit),
		})
		if err != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	next := uint32(0)
	if len(rows) > int(limit) {
		if page == 10000 {
			return nil, 0, invalid("Session listing exceeds the 10000-page limit. Increase the page size or revoke other sessions, then refresh.")
		}
		rows = rows[:limit]
		next = page + 1
	}
	return rows, next, nil
}

func (s *Server) revokeSession(ctx context.Context, value string, credential forgeCredential, sessionID string) (bool, error) {
	id, err := strconv.ParseInt(sessionID, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != sessionID {
		return false, invalid("Session ID must be a positive decimal identifier.")
	}
	current := false
	err = s.withManagedSession(ctx, value, credential, func(queries *database.Queries, caller database.LockManagedSessionRow, hash []byte) error {
		count, err := queries.RevokeManagedSession(ctx, database.RevokeManagedSessionParams{
			CallerTokenHash: hash, UserID: caller.UserID, ForgeURL: s.config.GiteaURL, SessionID: id,
		})
		if err != nil {
			return errStorageUnavailable
		}
		if count != 1 {
			return errResourceNotFound
		}
		current = caller.SessionID == id
		return appendAudit(ctx, queries, database.AppendAuditEventParams{UserID: caller.UserID, Action: "SESSION_REVOKED", ActorSessionID: caller.SessionID, TargetSessionID: auditTarget(id), CredentialKind: caller.CredentialKind, RevokedCount: 1})
	})
	return current && err == nil, err
}

func (s *Server) revokeOtherSessions(ctx context.Context, value string, credential forgeCredential) (uint64, error) {
	var count int64
	err := s.withManagedSession(ctx, value, credential, func(queries *database.Queries, caller database.LockManagedSessionRow, hash []byte) error {
		var err error
		count, err = queries.RevokeOtherManagedSessions(ctx, database.RevokeOtherManagedSessionsParams{
			CallerTokenHash: hash, UserID: caller.UserID, ForgeURL: s.config.GiteaURL,
		})
		if err != nil {
			return errStorageUnavailable
		}
		return appendAudit(ctx, queries, database.AppendAuditEventParams{UserID: caller.UserID, Action: "OTHER_SESSIONS_REVOKED", ActorSessionID: caller.SessionID, CredentialKind: caller.CredentialKind, RevokedCount: count})
	})
	if err != nil {
		return 0, err
	}
	return uint64(count), nil
}

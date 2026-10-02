package server

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

var errAdminAccountConflict = errors.New("local account changed")
var errPasswordConfirmation = errors.New("password confirmation rejected")

// Browser administration deliberately excludes all administrator accounts and
// reactivation. Operator recovery requires fresh credentials, not a toggle.
func (s *Server) DisableLocalAccount(ctx context.Context, req *connect.Request[golfv1.DisableLocalAccountRequest]) (*connect.Response[golfv1.DisableLocalAccountResponse], error) {
	credential, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	value := s.cookieValue(req.Header())
	if err := s.requireInstanceAdmin(ctx, value, credential); err != nil {
		return nil, err
	}
	accountID, err := discussionID(req.Msg.AccountId)
	if err != nil {
		return nil, rpcError(invalid("Account ID must be a canonical positive decimal identifier."))
	}
	version, err := discussionID(req.Msg.ExpectedCredentialVersion)
	if err != nil {
		return nil, rpcError(invalid("Provide the current account credential version."))
	}
	if !validLocalPassword(req.Msg.PasswordConfirmation) {
		return nil, rpcError(errPasswordConfirmation)
	}
	hash, err := s.authSessionHash(ctx, value, nil)
	if err != nil {
		return nil, rpcError(err)
	}
	q := database.New(s.db)
	initial, err := q.GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, rpcError(errUnauthenticated)
	}
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if err := s.consumeLocalLogin(ctx, initial.Username); err != nil {
		return nil, rpcError(err)
	}
	correct, err := verifyLocalPassword(ctx, req.Msg.PasswordConfirmation, initial.PasswordHash)
	if err != nil {
		return nil, rpcError(err)
	}
	if !correct {
		return nil, rpcError(errPasswordConfirmation)
	}
	// Repeat provider/local identity verification after the bounded KDF wait.
	if err := s.requireInstanceAdmin(ctx, value, credential); err != nil {
		return nil, err
	}
	target, err := q.GetAdminAccountTarget(ctx, database.GetAdminAccountTargetParams{ID: accountID, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, rpcError(errResourceNotFound)
	}
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if target.IsInstanceAdmin || target.UserID == initial.UserID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("Administrator accounts cannot be disabled through this portal."))
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	defer tx.Rollback()
	locked := q.WithTx(tx)
	users, err := locked.LockAdminAccountUsers(ctx, database.LockAdminAccountUsersParams{FirstUserID: initial.UserID, SecondUserID: target.UserID})
	if err != nil || len(users) != 2 {
		return nil, rpcError(errStorageUnavailable)
	}
	actor, err := locked.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: initial.ID, UserID: initial.UserID})
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	_, err = locked.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: target.ID, UserID: target.UserID})
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if !actor.IsInstanceAdmin || actor.DisabledAt.Valid || actor.CredentialVersion != initial.CredentialVersion || actor.PasswordHash != initial.PasswordHash {
		return nil, rpcError(errUnauthenticated)
	}
	_, err = locked.LockSessionCredential(ctx, database.LockSessionCredentialParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, rpcError(errUnauthenticated)
	}
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	current, err := locked.GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, rpcError(errUnauthenticated)
	}
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if current.ID != initial.ID || current.UserID != initial.UserID || current.SessionID != initial.SessionID || current.CredentialVersion != initial.CredentialVersion || current.PasswordHash != initial.PasswordHash {
		return nil, rpcError(errUnauthenticated)
	}
	changed, err := locked.DisableRegularLocalAccount(ctx, database.DisableRegularLocalAccountParams{ID: target.ID, CredentialVersion: version})
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if changed != 1 {
		return nil, rpcError(errAdminAccountConflict)
	}
	revoked, err := locked.DeleteLocalAccountSessions(ctx, sql.NullInt64{Int64: target.ID, Valid: true})
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	updated, err := locked.GetAdminAccountTarget(ctx, database.GetAdminAccountTargetParams{ID: target.ID, ForgeURL: s.config.GiteaURL})
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	operation, err := newAuditOperation()
	if err != nil {
		return nil, rpcError(err)
	}
	err = locked.AppendAdminAccountDisable(ctx, database.AppendAdminAccountDisableParams{AccountID: target.ID, OperationID: operation, CredentialVersion: updated.CredentialVersion, SessionsRevoked: revoked, ActorUserID: sql.NullInt64{Int64: initial.UserID, Valid: true}, ActorSessionID: sql.NullInt64{Int64: initial.SessionID, Valid: true}})
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	// Expiry can advance while locks were acquired; recheck immediately before commit.
	if _, err := locked.GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL}); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, rpcError(errUnauthenticated)
		}
		return nil, rpcError(errStorageUnavailable)
	}
	if err := tx.Commit(); err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	stamp := updated.DisabledAt.Time.Format(time.RFC3339Nano)
	return connect.NewResponse(&golfv1.DisableLocalAccountResponse{Account: &golfv1.LocalAccountInfo{Id: strconv.FormatInt(updated.ID, 10), Username: updated.Username, Email: updated.Email.String, NativeUserId: strconv.FormatInt(updated.ForgeUserID, 10), GolfUserId: strconv.FormatInt(updated.UserID, 10), IsInstanceAdmin: updated.IsInstanceAdmin, Disabled: updated.DisabledAt.Valid, CredentialVersion: strconv.FormatInt(updated.CredentialVersion, 10), CreatedAt: updated.CreatedAt.Format(time.RFC3339Nano), DisabledAt: &stamp}, SessionsRevoked: uint64(revoked), OperationId: operation}), nil
}

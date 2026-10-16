package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgconn"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

// This is Golf's local login alias, not a verified mail or native identity.
func (s *Server) GetAccountSecurity(ctx context.Context, req *connect.Request[golfv1.GetAccountSecurityRequest]) (*connect.Response[golfv1.GetAccountSecurityResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	value := s.cookieValue(req.Header())
	result := &golfv1.GetAccountSecurityResponse{}
	err = s.withForgeCaller(ctx, value, token, func(caller User) error {
		result.Security = &golfv1.AccountSecurity{UserId: strconv.FormatInt(caller.ID, 10)}
		if !token.Local {
			return nil
		}
		hash, err := s.authSessionHash(ctx, value, nil)
		if err != nil {
			return err
		}
		row, err := database.New(s.db).GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.ForgeURL})
		if errors.Is(err, sql.ErrNoRows) {
			return errUnauthenticated
		}
		if err != nil {
			return errStorageUnavailable
		}
		if row.ForgeUserID != caller.ID {
			return errUnauthenticated
		}
		if _, err := s.localSessionUser(ctx, value, caller); err != nil {
			return err
		}
		result.Security = &golfv1.AccountSecurity{UserId: strconv.FormatInt(row.ForgeUserID, 10), AccountId: strconv.FormatInt(row.ID, 10), Username: row.Username, LoginEmail: row.Email.String, CredentialVersion: strconv.FormatInt(row.CredentialVersion, 10), CanManage: true}
		if mfa, e := loadLocalMFA(ctx, s.db, row.ID, false); e == nil {
			result.Security.MfaEnabled = mfa.Enabled
		} else if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

type ownSecurityChange struct {
	accountID, userID, version                     int64
	confirmation, password, email, action, mfaCode string
}
type ownSecurityResult struct {
	version, revoked int64
	operation        string
}

func (s *Server) ownSecuritySnapshot(ctx context.Context, value string, token forgeCredential) (database.GetOwnPasswordConfirmationRow, error) {
	var empty database.GetOwnPasswordConfirmationRow
	if !token.Local {
		return empty, forgeError{http.StatusForbidden}
	}
	hash, err := s.authSessionHash(ctx, value, nil)
	if err != nil {
		return empty, err
	}
	if s.db == nil {
		return empty, errStorageUnavailable
	}
	caller, err := s.currentUser(ctx, token)
	if err != nil {
		return empty, err
	}
	row, err := database.New(s.db).GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.ForgeURL})
	if errors.Is(err, sql.ErrNoRows) {
		return empty, errUnauthenticated
	}
	if err != nil {
		return empty, errStorageUnavailable
	}
	if caller.ID != row.ForgeUserID {
		return empty, errUnauthenticated
	}
	if _, err := s.localSessionUser(ctx, value, caller); err != nil {
		return empty, err
	}
	return row, nil
}
func sameOwnSecurity(a, b database.GetOwnPasswordConfirmationRow) bool {
	return a.ID == b.ID && a.UserID == b.UserID && a.ForgeUserID == b.ForgeUserID && a.SessionID == b.SessionID && a.CredentialVersion == b.CredentialVersion && a.PasswordHash == b.PasswordHash && a.ExpiresAt.Equal(b.ExpiresAt)
}
func (s *Server) changeOwnSecurity(ctx context.Context, value string, token forgeCredential, input ownSecurityChange) (ownSecurityResult, error) {
	var empty ownSecurityResult
	initial, err := s.ownSecuritySnapshot(ctx, value, token)
	if err != nil {
		return empty, err
	}
	if initial.ID != input.accountID || initial.ForgeUserID != input.userID {
		return empty, forgeError{http.StatusForbidden}
	}
	if initial.CredentialVersion != input.version {
		return empty, errAdminAccountConflict
	}
	if input.action == "SELF_EMAIL_CHANGED" && initial.Email.Valid && initial.Email.String == input.email {
		return empty, invalid("Choose a different Golf sign-in email alias.")
	}
	correct, err := s.verifyLocalPasswordAttempt(ctx, initial.Username, input.confirmation, initial.PasswordHash)
	if err != nil {
		return empty, err
	}
	if !correct {
		return empty, errPasswordConfirmation
	}
	passwordHash := ""
	if input.action == "SELF_PASSWORD_CHANGED" {
		passwordHash, err = hashLocalPassword(ctx, input.password)
		if err != nil {
			return empty, err
		}
	}
	if input.mfaCode != "" {
		if err := s.reserveMFAAttempt(ctx, initial.ID); err != nil {
			return empty, err
		}
	}
	// Native waits and both KDFs finish before acquiring any account locks.
	latest, err := s.ownSecuritySnapshot(ctx, value, token)
	if err != nil {
		return empty, err
	}
	if !sameOwnSecurity(initial, latest) {
		return empty, errUnauthenticated
	}
	hash, err := s.authSessionHash(ctx, value, nil)
	if err != nil {
		return empty, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return empty, errStorageUnavailable
	}
	defer tx.Rollback()
	q := database.New(s.db).WithTx(tx)
	owner, err := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: hash, ForgeURL: s.config.ForgeURL})
	if errors.Is(err, sql.ErrNoRows) {
		return empty, errUnauthenticated
	}
	if err != nil {
		return empty, errStorageUnavailable
	}
	if owner.ID != initial.UserID || owner.ForgeUserID != initial.ForgeUserID {
		return empty, errUnauthenticated
	}
	account, err := q.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: initial.ID, UserID: initial.UserID})
	if err != nil {
		return empty, errStorageUnavailable
	}
	if account.DisabledAt.Valid || account.CredentialVersion != initial.CredentialVersion || account.PasswordHash != initial.PasswordHash {
		return empty, errUnauthenticated
	}
	_, err = q.LockSessionCredential(ctx, database.LockSessionCredentialParams{TokenHash: hash, ForgeURL: s.config.ForgeURL})
	if errors.Is(err, sql.ErrNoRows) {
		return empty, errUnauthenticated
	}
	if err != nil {
		return empty, errStorageUnavailable
	}
	current, err := q.GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.ForgeURL})
	if errors.Is(err, sql.ErrNoRows) {
		return empty, errUnauthenticated
	}
	if err != nil {
		return empty, errStorageUnavailable
	}
	if !sameOwnSecurity(initial, current) {
		return empty, errUnauthenticated
	}
	mfa, mfaErr := loadLocalMFA(ctx, tx, initial.ID, true)
	if mfaErr != nil && !errors.Is(mfaErr, sql.ErrNoRows) {
		return empty, errStorageUnavailable
	}
	if mfaErr == nil && mfa.Enabled {
		recovery, err := s.consumeMFA(ctx, tx, mfa, input.mfaCode)
		if err != nil {
			return empty, err
		}
		if recovery {
			if _, err = tx.ExecContext(ctx, `INSERT INTO golf_mfa_events(account_id,user_id,action,version) VALUES($1,$2,'recovery_used',$3)`, initial.ID, initial.UserID, mfa.Version); err != nil {
				return empty, errStorageUnavailable
			}
		}
	}
	// The account row lock plus expected-version comparison is the local CAS.
	switch input.action {
	case "SELF_PASSWORD_CHANGED":
		err = q.ChangeLocalPassword(ctx, database.ChangeLocalPasswordParams{ID: initial.ID, PasswordHash: passwordHash})
	case "SELF_EMAIL_CHANGED":
		err = q.ChangeLocalEmail(ctx, database.ChangeLocalEmailParams{ID: initial.ID, Email: sql.NullString{String: input.email, Valid: true}})
	default:
		return empty, invalid("Unsupported own credential change.")
	}
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			return empty, invalid("That Golf sign-in email alias is already enrolled. Choose another.")
		}
		return empty, errStorageUnavailable
	}
	revoked, err := q.DeleteLocalAccountSessions(ctx, sql.NullInt64{Int64: initial.ID, Valid: true})
	if err != nil {
		return empty, errStorageUnavailable
	}
	operation, err := newAuditOperation()
	if err != nil {
		return empty, err
	}
	count, err := q.AppendSelfAccountChange(ctx, database.AppendSelfAccountChangeParams{AccountID: initial.ID, OperationID: operation, Action: input.action, CredentialVersion: initial.CredentialVersion + 1, SessionsRevoked: revoked, ActorUserID: initial.UserID, ActorSessionID: sql.NullInt64{Int64: initial.SessionID, Valid: true}})
	if err != nil || count != 1 {
		return empty, errStorageUnavailable
	}
	live, err := q.OwnSecurityExpiryLive(ctx, initial.ExpiresAt)
	if err != nil {
		return empty, errStorageUnavailable
	}
	if !live {
		return empty, errUnauthenticated
	}
	if err := tx.Commit(); err != nil {
		return empty, errStorageUnavailable
	}
	return ownSecurityResult{version: initial.CredentialVersion + 1, revoked: revoked, operation: operation}, nil
}
func ownSecurityInput(account, user, version, password string) (ownSecurityChange, error) {
	var input ownSecurityChange
	var err error
	input.accountID, err = discussionID(account)
	if err != nil {
		return input, invalid("Provide your immutable local account ID.")
	}
	input.userID, err = discussionID(user)
	if err != nil {
		return input, invalid("Provide your immutable user ID.")
	}
	input.version, err = discussionID(version)
	if err != nil {
		return input, invalid("Provide the current credential version.")
	}
	if !validLocalPassword(password) {
		return input, errPasswordConfirmation
	}
	input.confirmation = password
	return input, nil
}
func (s *Server) ChangeOwnPassword(ctx context.Context, req *connect.Request[golfv1.ChangeOwnPasswordRequest]) (*connect.Response[golfv1.ChangeOwnPasswordResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	input, err := ownSecurityInput(req.Msg.AccountId, req.Msg.UserId, req.Msg.ExpectedCredentialVersion, req.Msg.PasswordConfirmation)
	if err != nil {
		return nil, rpcError(err)
	}
	if !validLocalPassword(req.Msg.NewPassword) {
		return nil, rpcError(invalid("New password must contain at least 15 characters and at most 1024 UTF-8 bytes."))
	}
	input.action, input.password, input.mfaCode = "SELF_PASSWORD_CHANGED", req.Msg.NewPassword, req.Msg.MfaCode
	result, err := s.changeOwnSecurity(ctx, s.cookieValue(req.Header()), token, input)
	if err != nil {
		return nil, rpcError(err)
	}
	response := connect.NewResponse(&golfv1.ChangeOwnPasswordResponse{CredentialVersion: strconv.FormatInt(result.version, 10), SessionsRevoked: uint64(result.revoked), OperationId: result.operation, RequiresLogin: true})
	response.Header().Add("Set-Cookie", s.sessionCookie("", time.Unix(1, 0), -1).String())
	return response, nil
}
func (s *Server) ChangeOwnLoginEmail(ctx context.Context, req *connect.Request[golfv1.ChangeOwnLoginEmailRequest]) (*connect.Response[golfv1.ChangeOwnLoginEmailResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	input, err := ownSecurityInput(req.Msg.AccountId, req.Msg.UserId, req.Msg.ExpectedCredentialVersion, req.Msg.PasswordConfirmation)
	if err != nil {
		return nil, rpcError(err)
	}
	email, valid := canonicalLocalEmail(req.Msg.LoginEmail)
	if !valid {
		return nil, rpcError(invalid("Provide a valid Golf sign-in email alias."))
	}
	input.action, input.email, input.mfaCode = "SELF_EMAIL_CHANGED", email, req.Msg.MfaCode
	result, err := s.changeOwnSecurity(ctx, s.cookieValue(req.Header()), token, input)
	if err != nil {
		return nil, rpcError(err)
	}
	response := connect.NewResponse(&golfv1.ChangeOwnLoginEmailResponse{CredentialVersion: strconv.FormatInt(result.version, 10), SessionsRevoked: uint64(result.revoked), OperationId: result.operation, RequiresLogin: true})
	response.Header().Add("Set-Cookie", s.sessionCookie("", time.Unix(1, 0), -1).String())
	return response, nil
}

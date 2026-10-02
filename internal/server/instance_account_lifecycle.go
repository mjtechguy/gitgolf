package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgconn"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

func (s *Server) EnrollRegularLocalAccount(ctx context.Context, req *connect.Request[golfv1.EnrollRegularLocalAccountRequest]) (*connect.Response[golfv1.EnrollRegularLocalAccountResponse], error) {
	r, err := s.adminAccountLifecycle(ctx, req.Header(), "ADMIN_CREATED", adminAccountChange{username: req.Msg.Username, email: req.Msg.Email, password: req.Msg.Password, token: req.Msg.ForgeToken, nativeID: req.Msg.ExpectedNativeUserId, confirmation: req.Msg.PasswordConfirmation})
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	return connect.NewResponse(&golfv1.EnrollRegularLocalAccountResponse{Account: r.account, SessionsRevoked: r.revoked, OperationId: r.operation}), nil
}

func (s *Server) ResetRegularLocalPassword(ctx context.Context, req *connect.Request[golfv1.ResetRegularLocalPasswordRequest]) (*connect.Response[golfv1.ResetRegularLocalPasswordResponse], error) {
	r, err := s.adminAccountLifecycle(ctx, req.Header(), "ADMIN_PASSWORD_RESET", adminAccountChange{accountID: req.Msg.AccountId, version: req.Msg.ExpectedCredentialVersion, password: req.Msg.Password, confirmation: req.Msg.PasswordConfirmation})
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	return connect.NewResponse(&golfv1.ResetRegularLocalPasswordResponse{Account: r.account, SessionsRevoked: r.revoked, OperationId: r.operation}), nil
}

func (s *Server) EnableRegularLocalAccount(ctx context.Context, req *connect.Request[golfv1.EnableRegularLocalAccountRequest]) (*connect.Response[golfv1.EnableRegularLocalAccountResponse], error) {
	r, err := s.adminAccountLifecycle(ctx, req.Header(), "ADMIN_ENABLED", adminAccountChange{accountID: req.Msg.AccountId, version: req.Msg.ExpectedCredentialVersion, password: req.Msg.Password, token: req.Msg.ForgeToken, confirmation: req.Msg.PasswordConfirmation})
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	return connect.NewResponse(&golfv1.EnableRegularLocalAccountResponse{Account: r.account, SessionsRevoked: r.revoked, OperationId: r.operation}), nil
}

type adminAccountChange struct {
	accountID, version, username, email, password, token, nativeID, confirmation string
}
type adminAccountChangeResult struct {
	account   *golfv1.LocalAccountInfo
	revoked   uint64
	operation string
}

// All three operations use one lock/audit boundary. Provider calls and password
// hashing finish before sorted user -> account -> session locks are acquired.
// The source credential remains native authority, not a Golf role assignment.
func (s *Server) adminAccountLifecycle(ctx context.Context, header http.Header, action string, input adminAccountChange) (adminAccountChangeResult, error) {
	var empty adminAccountChangeResult
	credential, err := rpcToken(ctx)
	if err != nil {
		return empty, err
	}
	value := s.cookieValue(header)
	initial, err := s.confirmInfrastructureAdmin(ctx, value, credential, input.confirmation)
	if err != nil {
		return empty, err
	}
	if !validLocalPassword(input.password) {
		return empty, invalid("Use a password of at least 15 characters and at most 1024 UTF-8 bytes.")
	}
	creating, enabling := action == "ADMIN_CREATED", action == "ADMIN_ENABLED"
	var accountID, version, expectedNativeID int64
	if creating {
		if !localUsername.MatchString(input.username) {
			return empty, invalid("Use a lowercase username of 3–64 letters, digits, dots, hyphens or underscores, starting with a letter or digit.")
		}
		if input.email != "" {
			var ok bool
			input.email, ok = canonicalLocalEmail(input.email)
			if !ok {
				return empty, invalid("Provide a valid email address without a display name or whitespace.")
			}
		}
		expectedNativeID, err = discussionID(input.nativeID)
		if err != nil {
			return empty, invalid("Provide the expected native user's canonical positive decimal ID.")
		}
	} else {
		accountID, err = discussionID(input.accountID)
		if err != nil {
			return empty, invalid("Account ID must be a canonical positive decimal identifier.")
		}
		version, err = discussionID(input.version)
		if err != nil {
			return empty, invalid("Provide the current account credential version.")
		}
	}
	q := database.New(s.db)
	var target database.GetAdminAccountTargetRow
	if !creating {
		target, err = q.GetAdminAccountTarget(ctx, database.GetAdminAccountTargetParams{ID: accountID, ForgeURL: s.config.GiteaURL})
		if errors.Is(err, sql.ErrNoRows) {
			return empty, errResourceNotFound
		}
		if err != nil {
			return empty, errStorageUnavailable
		}
		if target.IsInstanceAdmin || target.UserID == initial.UserID {
			return empty, protectedAdminAccount()
		}
		if target.CredentialVersion != version || enabling && !target.DisabledAt.Valid {
			return empty, errAdminAccountConflict
		}
		expectedNativeID = target.ForgeUserID
	}
	var native User
	if creating || enabling {
		if len(input.token) < 8 || len(input.token) > 512 || strings.ContainsAny(input.token, " \t\r\n") {
			return empty, invalid("Provide a valid source credential for the expected native identity.")
		}
		native, err = s.currentUser(ctx, forgeCredential{Kind: "pat", Token: input.token})
		if err != nil || native.ID != expectedNativeID {
			return empty, invalid("The source credential could not be verified for the expected native identity.")
		}
		if err := checkRuntimeKeys(ctx, s.db, s.keyring); err != nil {
			return empty, err
		}
	}
	passwordHash, err := hashLocalPassword(ctx, input.password)
	if err != nil {
		return empty, err
	}
	// A reset/revocation during target verification or hashing must not inherit
	// the earlier administrator decision. No provider call runs under SQL locks.
	if err := s.requireInstanceAdmin(ctx, value, credential); err != nil {
		return empty, err
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
	locked := q.WithTx(tx)
	if creating {
		if err := locked.EnsureLoginUser(ctx, database.EnsureLoginUserParams{ForgeURL: s.config.GiteaURL, ForgeUserID: native.ID, Login: native.Login, FullName: native.FullName, AvatarURL: native.AvatarURL}); err != nil {
			return empty, errStorageUnavailable
		}
		target.UserID, err = locked.GetLifecycleNativeUser(ctx, database.GetLifecycleNativeUserParams{ForgeURL: s.config.GiteaURL, ForgeUserID: native.ID})
		if err != nil {
			return empty, errStorageUnavailable
		}
		if target.UserID == initial.UserID {
			return empty, protectedAdminAccount()
		}
	}
	users, err := locked.LockAdminAccountUsers(ctx, database.LockAdminAccountUsersParams{FirstUserID: initial.UserID, SecondUserID: target.UserID})
	if err != nil || len(users) != 2 {
		return empty, errStorageUnavailable
	}
	actor, err := locked.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: initial.ID, UserID: initial.UserID})
	if err != nil {
		return empty, errStorageUnavailable
	}
	if !actor.IsInstanceAdmin || actor.DisabledAt.Valid || actor.PasswordHash != initial.PasswordHash || actor.CredentialVersion != initial.CredentialVersion {
		return empty, errUnauthenticated
	}
	var account database.GolfLocalAccount
	if creating {
		existing, err := locked.GetLifecycleEnrollment(ctx, target.UserID)
		if err == nil {
			if existing.IsInstanceAdmin {
				return empty, protectedAdminAccount()
			}
			return empty, errAdminAccountConflict
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return empty, errStorageUnavailable
		}
	} else {
		account, err = locked.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: target.ID, UserID: target.UserID})
		if err != nil {
			return empty, errStorageUnavailable
		}
		if account.IsInstanceAdmin {
			return empty, protectedAdminAccount()
		}
		if account.CredentialVersion != version || enabling && !account.DisabledAt.Valid {
			return empty, errAdminAccountConflict
		}
	}
	if _, err := locked.LockSessionCredential(ctx, database.LockSessionCredentialParams{TokenHash: hash, ForgeURL: s.config.GiteaURL}); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return empty, errUnauthenticated
		}
		return empty, errStorageUnavailable
	}
	checkActor := func() error {
		current, err := locked.GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
		if errors.Is(err, sql.ErrNoRows) {
			return errUnauthenticated
		}
		if err != nil {
			return errStorageUnavailable
		}
		if current != initial {
			return errUnauthenticated
		}
		return nil
	}
	if err := checkActor(); err != nil {
		return empty, err
	}
	if creating {
		binding := make([]byte, 32)
		if _, err := rand.Read(binding); err != nil {
			return empty, errCredentialUnavailable
		}
		encrypted, keyID, err := s.keyring.seal(localAccountDomain, input.token, binding)
		if err != nil {
			return empty, err
		}
		account, err = locked.CreateLocalAccount(ctx, database.CreateLocalAccountParams{UserID: target.UserID, Username: input.username, Email: sql.NullString{String: input.email, Valid: input.email != ""}, PasswordHash: passwordHash, EncryptedForgeToken: encrypted, CredentialBinding: binding, CredentialKeyID: keyID, IsInstanceAdmin: false})
		if err != nil {
			var pg *pgconn.PgError
			if errors.As(err, &pg) && pg.Code == "23505" {
				return empty, errAdminAccountConflict
			}
			return empty, errStorageUnavailable
		}
	} else {
		var changed int64
		if enabling {
			encrypted, keyID, sealErr := s.keyring.seal(localAccountDomain, input.token, account.CredentialBinding)
			if sealErr != nil {
				return empty, sealErr
			}
			changed, err = locked.EnableRegularLocalAccount(ctx, database.EnableRegularLocalAccountParams{ID: account.ID, CredentialVersion: version, PasswordHash: passwordHash, EncryptedForgeToken: encrypted, CredentialKeyID: keyID})
		} else {
			changed, err = locked.ResetRegularLocalPassword(ctx, database.ResetRegularLocalPasswordParams{ID: account.ID, CredentialVersion: version, PasswordHash: passwordHash})
		}
		if err != nil {
			return empty, errStorageUnavailable
		}
		if changed != 1 {
			return empty, errAdminAccountConflict
		}
	}
	revoked, err := locked.DeleteLocalAccountSessions(ctx, sql.NullInt64{Int64: account.ID, Valid: true})
	if err != nil {
		return empty, errStorageUnavailable
	}
	updated, err := locked.GetAdminAccountTarget(ctx, database.GetAdminAccountTargetParams{ID: account.ID, ForgeURL: s.config.GiteaURL})
	if err != nil {
		return empty, errStorageUnavailable
	}
	operation, err := newAuditOperation()
	if err != nil {
		return empty, err
	}
	if err := locked.AppendAdminAccountLifecycle(ctx, database.AppendAdminAccountLifecycleParams{AccountID: account.ID, OperationID: operation, Action: action, CredentialVersion: updated.CredentialVersion, SessionsRevoked: revoked, ActorUserID: sql.NullInt64{Int64: initial.UserID, Valid: true}, ActorSessionID: sql.NullInt64{Int64: initial.SessionID, Valid: true}}); err != nil {
		return empty, errStorageUnavailable
	}
	if err := checkActor(); err != nil {
		return empty, err
	}
	if err := tx.Commit(); err != nil {
		return empty, errStorageUnavailable
	}
	info := &golfv1.LocalAccountInfo{Id: strconv.FormatInt(updated.ID, 10), Username: updated.Username, Email: updated.Email.String, NativeUserId: strconv.FormatInt(updated.ForgeUserID, 10), GolfUserId: strconv.FormatInt(updated.UserID, 10), IsInstanceAdmin: updated.IsInstanceAdmin, Disabled: updated.DisabledAt.Valid, CredentialVersion: strconv.FormatInt(updated.CredentialVersion, 10), CreatedAt: updated.CreatedAt.Format(time.RFC3339Nano)}
	if updated.DisabledAt.Valid {
		stamp := updated.DisabledAt.Time.Format(time.RFC3339Nano)
		info.DisabledAt = &stamp
	}
	return adminAccountChangeResult{account: info, revoked: uint64(revoked), operation: operation}, nil
}

func protectedAdminAccount() error {
	return connect.NewError(connect.CodePermissionDenied, errors.New("Administrator accounts cannot be changed through this portal."))
}

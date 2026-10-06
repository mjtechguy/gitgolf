package server

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

// Browser recovery is intentionally narrower than privileged operator recovery:
// no self-reset, no instance-admin target, no native writes, no password reset.
func (s *Server) ResetRegularLocalMFA(ctx context.Context, req *connect.Request[golfv1.ResetRegularLocalMFARequest]) (*connect.Response[golfv1.ResetRegularLocalMFAResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m := req.Msg
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	value := s.cookieValue(req.Header())
	initial, e := s.confirmInfrastructureAdmin(ctx, value, token, m.PasswordConfirmation)
	if e != nil {
		return nil, infrastructureRPCError(e)
	}
	account, e := discussionID(m.AccountId)
	if e != nil {
		return nil, rpcError(e)
	}
	user, e := discussionID(m.GolfUserId)
	if e != nil {
		return nil, rpcError(e)
	}
	native, e := discussionID(m.NativeUserId)
	if e != nil {
		return nil, rpcError(e)
	}
	version, e := discussionID(m.ExpectedCredentialVersion)
	if e != nil {
		return nil, rpcError(e)
	}
	mfaVersion, e := discussionID(m.ExpectedMfaVersion)
	if e != nil {
		return nil, rpcError(e)
	}
	actorMFAVersion, e := emailVersion(m.ExpectedAdminMfaVersion, true)
	if e != nil {
		return nil, rpcError(e)
	}
	reason := strings.TrimSpace(m.Reason)
	if !m.AcknowledgeWarning || reason == "" || len(reason) > 512 || !discussionText(reason, 512) {
		return nil, rpcError(invalid("Acknowledge the loss of factor protection and provide a recovery reason of at most512UTF-8bytes."))
	}
	q := database.New(s.db)
	target, e := q.GetAdminAccountTarget(ctx, database.GetAdminAccountTargetParams{ID: account, ForgeURL: s.config.GiteaURL})
	if errors.Is(e, sql.ErrNoRows) {
		return nil, rpcError(errResourceNotFound)
	}
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if target.IsInstanceAdmin || target.UserID == initial.UserID {
		return nil, protectedAdminAccount()
	}
	if target.UserID != user || target.ForgeUserID != native || target.CredentialVersion != version {
		return nil, rpcError(errAdminAccountConflict)
	}
	if m.AdminMfaCode != "" {
		if e = s.reserveMFAAttempt(ctx, initial.ID); e != nil {
			return nil, rpcError(e)
		}
	}
	// Provider/KDF work completes before sorted users -> local accounts -> caller
	// session -> MFA locks, matching current admin lifecycle and own security paths.
	if e = s.requireInstanceAdmin(ctx, value, token); e != nil {
		return nil, e
	}
	hash, e := s.authSessionHash(ctx, value, nil)
	if e != nil {
		return nil, rpcError(e)
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	defer tx.Rollback()
	locked := q.WithTx(tx)
	users, e := locked.LockAdminAccountUsers(ctx, database.LockAdminAccountUsersParams{FirstUserID: initial.UserID, SecondUserID: target.UserID})
	if e != nil || len(users) != 2 {
		return nil, rpcError(errStorageUnavailable)
	}
	actor, e := locked.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: initial.ID, UserID: initial.UserID})
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	subject, e := locked.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: account, UserID: user})
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if !actor.IsInstanceAdmin || actor.DisabledAt.Valid || actor.CredentialVersion != initial.CredentialVersion || actor.PasswordHash != initial.PasswordHash {
		return nil, rpcError(errUnauthenticated)
	}
	if subject.IsInstanceAdmin || subject.UserID == initial.UserID {
		return nil, protectedAdminAccount()
	}
	if subject.CredentialVersion != version {
		return nil, rpcError(errAdminAccountConflict)
	}
	latestTarget, e := locked.GetAdminAccountTarget(ctx, database.GetAdminAccountTargetParams{ID: account, ForgeURL: s.config.GiteaURL})
	if e != nil || latestTarget.UserID != user || latestTarget.ForgeUserID != native {
		return nil, rpcError(errAdminAccountConflict)
	}
	if _, e = locked.LockSessionCredential(ctx, database.LockSessionCredentialParams{TokenHash: hash, ForgeURL: s.config.GiteaURL}); e != nil {
		return nil, rpcError(errUnauthenticated)
	}
	checkActor := func() error {
		current, e := locked.GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
		if e != nil || current != initial {
			return errUnauthenticated
		}
		return s.requireGolfUserAccess(ctx, tx, initial.UserID)
	}
	if e = checkActor(); e != nil {
		return nil, rpcError(e)
	}
	actorMFA, e := loadLocalMFA(ctx, tx, initial.ID, true)
	if errors.Is(e, sql.ErrNoRows) {
		if actorMFAVersion != 0 {
			return nil, rpcError(errAdminAccountConflict)
		}
	} else if e != nil {
		return nil, rpcError(errStorageUnavailable)
	} else {
		if actorMFA.Version != actorMFAVersion {
			return nil, rpcError(errAdminAccountConflict)
		}
		if actorMFA.Enabled {
			recovery, e := s.consumeMFA(ctx, tx, actorMFA, m.AdminMfaCode)
			if e != nil {
				return nil, rpcError(e)
			}
			if recovery {
				if _, e = tx.ExecContext(ctx, `INSERT INTO golf_mfa_events(account_id,user_id,action,version) VALUES($1,$2,'recovery_used',$3)`, initial.ID, initial.UserID, actorMFA.Version); e != nil {
					return nil, rpcError(errStorageUnavailable)
				}
			}
		}
	}
	factor, e := loadLocalMFA(ctx, tx, account, true)
	if e != nil || factor.Version != mfaVersion || !factor.Enabled && !factor.Pending.Valid {
		return nil, rpcError(errAdminAccountConflict)
	}
	out := &golfv1.ResetRegularLocalMFAResponse{}
	out.OperationId, e = newAuditOperation()
	if e != nil {
		return nil, rpcError(e)
	}
	effects, e := resetLocalMFALocked(ctx, tx, locked, account, user, version, mfaVersion)
	if e != nil {
		return nil, rpcError(e)
	}
	out.SessionsRevoked = uint64(effects.sessions)
	out.ChallengesRevoked = uint64(effects.challenges)
	out.RecoveryCodesRevoked = uint64(effects.codes)
	revoked := effects.sessions
	if _, e = tx.ExecContext(ctx, `INSERT INTO golf_mfa_events(account_id,user_id,action,version,operation_id,actor_user_id,actor_session_id,reason) VALUES($1,$2,'admin_reset',$3,$4,$5,$6,$7)`, account, user, mfaVersion+1, out.OperationId, initial.UserID, initial.SessionID, reason); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if e = locked.AppendAdminAccountLifecycle(ctx, database.AppendAdminAccountLifecycleParams{AccountID: account, OperationID: out.OperationId, Action: "ADMIN_MFA_RESET", CredentialVersion: version + 1, SessionsRevoked: revoked, ActorUserID: sql.NullInt64{Int64: initial.UserID, Valid: true}, ActorSessionID: sql.NullInt64{Int64: initial.SessionID, Valid: true}}); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if e = checkActor(); e != nil {
		return nil, rpcError(e)
	}
	if e = tx.Commit(); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	out.Account = &golfv1.LocalAccountInfo{Id: m.AccountId, GolfUserId: m.GolfUserId, NativeUserId: m.NativeUserId, Username: subject.Username, Email: subject.Email.String, Disabled: subject.DisabledAt.Valid, CredentialVersion: strconv.FormatInt(version+1, 10), MfaVersion: strconv.FormatInt(mfaVersion+1, 10), CreatedAt: subject.CreatedAt.UTC().Format(time.RFC3339Nano)}
	if subject.DisabledAt.Valid {
		stamp := subject.DisabledAt.Time.UTC().Format(time.RFC3339Nano)
		out.Account.DisabledAt = &stamp
	}
	return connect.NewResponse(out), nil
}

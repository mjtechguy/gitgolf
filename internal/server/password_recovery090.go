package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const recoveryMessage90 = "If this is an enabled Golf account with a currently verified email and configured delivery, a recovery code will be sent."

var errRecoveryCode90 = errors.New("Recovery could not be completed. Check the code, or request a new one.")

// Repeat current local consent after provider I/O, immediately before SMTP DATA.
func (s *Server) recoveryEmailAuthority90(ctx context.Context, d emailDelivery) error {
	if d.Kind != "verification" {
		return nil
	}
	var current bool
	e := s.db.QueryRowContext(ctx, `SELECT ch.purpose='verification' OR (ch.confirmed_at IS NULL AND ch.expires_at>clock_timestamp() AND ch.attempts<5 AND EXISTS(SELECT 1 FROM golf_password_recovery_enrollments er JOIN golf_email_contacts c ON c.user_id=er.user_id JOIN golf_local_accounts a ON a.id=er.local_account_id AND a.user_id=er.user_id JOIN golf_users u ON u.id=er.user_id WHERE er.user_id=ch.user_id AND er.enabled AND er.version=ch.password_recovery_enrollment_version AND er.local_account_id=c.local_account_id AND er.native_user_id=u.forge_user_id AND er.native_user_id=c.native_user_id AND er.credential_version=a.credential_version AND er.credential_version=c.credential_version AND er.contact_version=c.version AND c.version=ch.contact_version AND c.verified_at IS NOT NULL AND c.suppression='' AND a.disabled_at IS NULL AND u.forge_url=$2)) FROM golf_email_challenges ch WHERE ch.id=$1 AND ch.user_id=$3`, d.ChallengeID, s.config.ForgeURL, d.UserID).Scan(&current)
	if e != nil || !current {
		return errEmailRevoked
	}
	return nil
}

// Separate fixed counters prevent recovery requests from locking out sign-in.
// ponytail: 1024 hash buckets can collide; use per-tenant bounded buckets if traffic requires it.
func (s *Server) recoveryLimit90(ctx context.Context, scope string) (bool, error) {
	if s.db == nil {
		return false, errStorageUnavailable
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return false, errStorageUnavailable
	}
	defer tx.Rollback()
	var global, subject int
	query := `UPDATE golf_password_recovery_limits SET attempts=CASE WHEN resets_at<=clock_timestamp() THEN 1 ELSE LEAST(attempts+1,121) END,resets_at=CASE WHEN resets_at<=clock_timestamp() THEN clock_timestamp()+make_interval(secs=>$2) ELSE resets_at END WHERE bucket=$1 RETURNING attempts`
	if e = tx.QueryRowContext(ctx, query, 0, 60).Scan(&global); e != nil {
		return false, errStorageUnavailable
	}
	if e = tx.QueryRowContext(ctx, query, localLoginBucket(scope), 3600).Scan(&subject); e != nil {
		return false, errStorageUnavailable
	}
	if e = tx.Commit(); e != nil {
		return false, errStorageUnavailable
	}
	return global <= 120 && subject <= 10, nil
}

type recoveryAccount90 struct {
	emailAccount
	ContactVersion    int64
	EnrollmentVersion int64
	Username          string
	Token             string
}

func (s *Server) recoveryAccount90(ctx context.Context, tx database.DBTX, user int64) (a recoveryAccount90, e error) {
	var cipher, binding, mailbox []byte
	var key string
	e = tx.QueryRowContext(ctx, `SELECT u.id,u.forge_user_id,a.id,a.credential_version,a.email,c.version,er.version,a.username,a.encrypted_forge_token,a.credential_binding,a.credential_key_id,c.mailbox_hash
 FROM golf_users u JOIN golf_local_accounts a ON a.user_id=u.id JOIN golf_email_contacts c ON c.user_id=u.id AND c.local_account_id=a.id AND c.native_user_id=u.forge_user_id AND c.credential_version=a.credential_version
 JOIN golf_password_recovery_enrollments er ON er.user_id=u.id AND er.local_account_id=a.id AND er.native_user_id=u.forge_user_id AND er.credential_version=a.credential_version AND er.contact_version=c.version AND er.enabled
 WHERE u.id=$1 AND u.forge_url=$2 AND a.disabled_at IS NULL AND c.verified_at IS NOT NULL AND c.suppression='' AND NOT EXISTS(SELECT 1 FROM golf_user_access WHERE user_id=u.id AND suspended)`, user, s.config.ForgeURL).Scan(&a.UserID, &a.NativeID, &a.LocalID, &a.CredentialVersion, &a.Email, &a.ContactVersion, &a.EnrollmentVersion, &a.Username, &cipher, &binding, &key, &mailbox)
	if e != nil {
		return a, e
	}
	if !bytes.Equal(mailbox, emailHash(a.Email)) {
		return a, errRecoveryCode90
	}
	a.Token, e = s.keyring.open(key, localAccountDomain, cipher, binding)
	return
}

func (s *Server) RequestPasswordRecovery(ctx context.Context, req *connect.Request[golfv1.RequestPasswordRecoveryRequest]) (*connect.Response[golfv1.RequestPasswordRecoveryResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	response := connect.NewResponse(&golfv1.RequestPasswordRecoveryResponse{Message: recoveryMessage90})
	email, ok := canonicalLocalEmail(req.Msg.Email)
	if !ok || !creationKey.MatchString(req.Msg.OperationId) {
		return response, nil
	}
	allowed, e := s.recoveryLimit90(ctx, "request:"+email)
	if e != nil {
		return nil, rpcError(e)
	}
	if !allowed {
		return response, nil
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	defer tx.Rollback()
	var user int64
	e = tx.QueryRowContext(ctx, `SELECT u.id FROM golf_users u JOIN golf_local_accounts a ON a.user_id=u.id WHERE u.forge_url=$1 AND a.email=$2 FOR UPDATE OF u`, s.config.ForgeURL, email).Scan(&user)
	if errors.Is(e, sql.ErrNoRows) {
		return response, nil
	}
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	a, e := s.recoveryAccount90(ctx, tx, user)
	if e != nil {
		return response, nil
	}
	if _, e = tx.ExecContext(ctx, `SELECT id FROM golf_local_accounts WHERE id=$1 FOR UPDATE`, a.LocalID); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	// Re-read after the canonical actor/account locks: contact or credential changes invalidate recovery.
	a, e = s.recoveryAccount90(ctx, tx, user)
	if e != nil {
		return response, nil
	}
	var count int
	var exists bool
	if e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_email_challenges WHERE id=$1),(SELECT count(*) FROM golf_email_challenges WHERE user_id=$2 AND purpose='password_recovery' AND created_at>clock_timestamp()-interval '1 hour')`, req.Msg.OperationId, user).Scan(&exists, &count); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if exists || count >= 3 {
		return response, nil
	}
	profile, generation, sender, e := s.emailActive(ctx, tx)
	if e != nil {
		return response, nil
	}
	var random [24]byte
	if _, e = rand.Read(random[:]); e != nil {
		return nil, rpcError(errCredentialUnavailable)
	}
	code := base64.RawURLEncoding.EncodeToString(random[:])
	id := req.Msg.OperationId
	text := "Your Golf password recovery code is:\n\n" + id + "." + code + "\n\nEnter it only in Golf's password recovery form. It expires in 15 minutes and works once. Your authenticator and MFA recovery codes will not be reset. If you did not request this, ignore it."
	body, e := emailMessage(sender.Sender, a.Email, id, "Recover your Golf password", text)
	if e != nil {
		return nil, rpcError(e)
	}
	mailID := uuid.NewString()
	if e = s.notificationStore(ctx, tx, mailID, "mail", emailMailSecret{a.Email, body}); e != nil {
		return nil, rpcError(e)
	}
	if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_challenges(id,user_id,contact_version,code_hash,expires_at,purpose,password_recovery_enrollment_version) VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes','password_recovery',$5)`, id, user, a.ContactVersion, emailCodeHash(id, code), a.EnrollmentVersion); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_deliveries(id,user_id,kind,contact_version,challenge_id,event_id,event_topic,transport_id,transport_version,activation_generation,content_id) VALUES($1,$2,'verification',$3,$1,$4,'verification',$5,$6,$7,$8)`, id, user, a.ContactVersion, "password_recovery:"+id, profile.ID, profile.Version, generation, mailID); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_events(user_id,action,object_id,version) VALUES($1,'password_recovery_requested',$2,$3)`, user, id, a.ContactVersion); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if e = tx.Commit(); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	return response, nil
}

func (s *Server) CompletePasswordRecovery(ctx context.Context, req *connect.Request[golfv1.CompletePasswordRecoveryRequest]) (*connect.Response[golfv1.CompletePasswordRecoveryResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	fail := func() (*connect.Response[golfv1.CompletePasswordRecoveryResponse], error) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errRecoveryCode90)
	}
	parts := strings.Split(req.Msg.RecoveryCode, ".")
	if len(parts) != 2 || !creationKey.MatchString(parts[0]) || len(parts[1]) != 32 || !validLocalPassword(req.Msg.NewPassword) {
		return fail()
	}
	decoded, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil || len(decoded) != 24 || base64.RawURLEncoding.EncodeToString(decoded) != parts[1] {
		return fail()
	}
	id, code := parts[0], parts[1]
	allowed, e := s.recoveryLimit90(ctx, "complete:"+id)
	if e != nil {
		return nil, rpcError(e)
	}
	if !allowed {
		return fail()
	}
	var user, contactVersion, enrollmentVersion int64
	var expected []byte
	// Charge incorrect guesses durably before the KDF/provider work. This is not consumption.
	e = s.db.QueryRowContext(ctx, `UPDATE golf_email_challenges SET attempts=attempts+1 WHERE id=$1 AND purpose='password_recovery' AND confirmed_at IS NULL AND expires_at>clock_timestamp() AND attempts<5 RETURNING user_id,contact_version,code_hash,password_recovery_enrollment_version`, id).Scan(&user, &contactVersion, &expected, &enrollmentVersion)
	if e != nil || subtle.ConstantTimeCompare(expected, emailCodeHash(id, code)) != 1 {
		return fail()
	}
	initial, e := s.recoveryAccount90(ctx, s.db, user)
	if e != nil || initial.ContactVersion != contactVersion || initial.EnrollmentVersion != enrollmentVersion {
		return fail()
	}
	token := forgeCredential{Kind: "pat", Token: initial.Token, Local: true}
	actor, e := s.currentUser(ctx, token)
	if e != nil || actor.ID != initial.NativeID {
		return fail()
	}
	password, e := hashLocalPassword(ctx, req.Msg.NewPassword)
	if e != nil {
		return nil, rpcError(e)
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, `SELECT id FROM golf_users WHERE id=$1 FOR UPDATE`, user); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	q := database.New(s.db).WithTx(tx)
	account, e := q.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: initial.LocalID, UserID: user})
	if e != nil || account.DisabledAt.Valid || account.CredentialVersion != initial.CredentialVersion {
		return fail()
	}
	if _, e = tx.ExecContext(ctx, `SELECT user_id FROM golf_email_contacts WHERE user_id=$1 FOR UPDATE`, user); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	latest, e := s.recoveryAccount90(ctx, tx, user)
	if e != nil || latest.ContactVersion != contactVersion || latest.EnrollmentVersion != enrollmentVersion || latest.NativeID != initial.NativeID {
		return fail()
	}
	var live bool
	if e = tx.QueryRowContext(ctx, `SELECT confirmed_at IS NULL AND expires_at>clock_timestamp() AND attempts<=5 AND code_hash=$2 FROM golf_email_challenges WHERE id=$1 AND purpose='password_recovery' AND user_id=$3 AND contact_version=$4 FOR UPDATE`, id, expected, user, contactVersion).Scan(&live); e != nil || !live {
		return fail()
	}
	actor, e = s.currentUser(ctx, forgeCredential{Kind: "pat", Token: latest.Token, Local: true})
	if e != nil || actor.ID != latest.NativeID {
		return fail()
	}
	consumed, e := tx.ExecContext(ctx, `UPDATE golf_email_challenges ch SET confirmed_at=clock_timestamp() WHERE ch.id=$1 AND ch.purpose='password_recovery' AND ch.user_id=$2 AND ch.contact_version=$3 AND ch.confirmed_at IS NULL AND ch.expires_at>clock_timestamp() AND ch.attempts<=5 AND ch.code_hash=$4 AND EXISTS(SELECT 1 FROM golf_email_contacts c JOIN golf_local_accounts a ON a.id=c.local_account_id JOIN golf_users u ON u.id=c.user_id WHERE c.user_id=ch.user_id AND c.version=ch.contact_version AND c.verified_at IS NOT NULL AND c.suppression='' AND c.mailbox_hash=$5 AND a.disabled_at IS NULL AND a.credential_version=c.credential_version AND a.id=$6 AND u.forge_url=$7 AND u.forge_user_id=c.native_user_id AND EXISTS(SELECT 1 FROM golf_password_recovery_enrollments er WHERE er.user_id=u.id AND er.local_account_id=a.id AND er.native_user_id=u.forge_user_id AND er.credential_version=a.credential_version AND er.contact_version=c.version AND er.version=$8 AND er.enabled))`, id, user, contactVersion, expected, emailHash(latest.Email), latest.LocalID, s.config.ForgeURL, enrollmentVersion)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	changed, e := consumed.RowsAffected()
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if changed != 1 {
		return fail()
	}
	if e = q.ChangeLocalPassword(ctx, database.ChangeLocalPasswordParams{ID: latest.LocalID, PasswordHash: password}); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	result, e := tx.ExecContext(ctx, `DELETE FROM golf_sessions WHERE user_id=$1`, user)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	revoked, e := result.RowsAffected()
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if _, e = tx.ExecContext(ctx, `DELETE FROM golf_mfa_login_challenges WHERE account_id=$1`, latest.LocalID); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}

	operation, e := newAuditOperation()
	if e != nil {
		return nil, rpcError(e)
	}
	if e = q.AppendLocalAccountEvent(ctx, database.AppendLocalAccountEventParams{AccountID: latest.LocalID, OperationID: operation, Action: "PASSWORD_RESET", CredentialVersion: latest.CredentialVersion + 1, SessionsRevoked: revoked}); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_events(user_id,action,object_id,version) VALUES($1,'password_recovered',$2,$3)`, user, id, latest.CredentialVersion+1); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if e = tx.Commit(); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	return connect.NewResponse(&golfv1.CompletePasswordRecoveryResponse{RequiresLogin: true}), nil
}

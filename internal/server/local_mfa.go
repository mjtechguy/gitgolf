package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const mfaChallengeLifetime = 5 * time.Minute

var errMFARequired = errors.New("Complete the Golf authentication challenge.")

type mfaSecret struct {
	Secret    string
	AccountID int64
}
type localMFA struct {
	AccountID, Version int64
	Enabled            bool
	Active, Pending    sql.NullString
	PendingExpires     sql.NullTime
	LastCounter        int64
}

func loadLocalMFA(ctx context.Context, db database.DBTX, account int64, lock bool) (localMFA, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	var v localMFA
	e := db.QueryRowContext(ctx, `SELECT account_id,version,enabled,active_content_id::text,pending_content_id::text,pending_expires_at,last_counter FROM golf_local_mfa WHERE account_id=$1`+suffix, account).Scan(&v.AccountID, &v.Version, &v.Enabled, &v.Active, &v.Pending, &v.PendingExpires, &v.LastCounter)
	return v, e
}
func totpCode(secret string, counter int64) (string, error) {
	key, e := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if e != nil || len(key) != 20 || counter < 0 {
		return "", errCredentialUnavailable
	}
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], uint64(counter))
	m := hmac.New(sha1.New, key)
	_, _ = m.Write(b[:])
	sum := m.Sum(nil)
	offset := sum[len(sum)-1] & 15
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1000000), nil
}
func totpCounter(secret, code string, now time.Time, last int64) (int64, bool) {
	if len(code) != 6 {
		return 0, false
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	current := now.Unix() / 30
	matched := int64(-1)
	// Check all windows before deciding, and refuse a previously consumed counter.
	for delta := int64(-1); delta <= 1; delta++ {
		c := current + delta
		want, e := totpCode(secret, c)
		if e == nil && subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 && c > last {
			matched = c
		}
	}
	return matched, matched >= 0
}
func recoveryHash(account, version int64, code string) []byte {
	h := sha256.Sum256([]byte(fmt.Sprintf("golf:mfa:recovery:v1:%d:%d:%s", account, version, code)))
	return h[:]
}
func recoveryCodes(ctx context.Context, tx database.DBTX, account, version int64) ([]string, error) {
	codes := make([]string, 10)
	for i := range codes {
		b := make([]byte, 16)
		if _, e := rand.Read(b); e != nil {
			return nil, e
		}
		v := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b)
		codes[i] = v[:13] + "-" + v[13:]
		if _, e := tx.ExecContext(ctx, `INSERT INTO golf_mfa_recovery_codes(account_id,version,code_hash) VALUES($1,$2,$3)`, account, version, recoveryHash(account, version, codes[i])); e != nil {
			return nil, e
		}
	}
	return codes, nil
}
func (s *Server) consumeMFA(ctx context.Context, tx database.DBTX, v localMFA, code string) (bool, error) {
	if !v.Enabled || !v.Active.Valid {
		return false, errLocalCredentials
	}
	var secret mfaSecret
	if e := s.notificationLoad(ctx, tx, v.Active.String, "mfa", &secret); e != nil {
		return false, e
	}
	if secret.AccountID != v.AccountID {
		return false, errCredentialUnavailable
	}
	var now time.Time
	if e := tx.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&now); e != nil {
		return false, errStorageUnavailable
	}
	if c, ok := totpCounter(secret.Secret, code, now, v.LastCounter); ok {
		_, e := tx.ExecContext(ctx, `UPDATE golf_local_mfa SET last_counter=$2 WHERE account_id=$1`, v.AccountID, c)
		return false, e
	}
	if len(code) != 27 {
		return false, errLocalCredentials
	}
	var used []byte
	e := tx.QueryRowContext(ctx, `UPDATE golf_mfa_recovery_codes SET used_at=clock_timestamp() WHERE account_id=$1 AND version=$2 AND code_hash=$3 AND used_at IS NULL RETURNING code_hash`, v.AccountID, v.Version, recoveryHash(v.AccountID, v.Version, code)).Scan(&used)
	if errors.Is(e, sql.ErrNoRows) {
		return false, errLocalCredentials
	}
	return true, e
}
func (s *Server) mfaCookie(value string, expires time.Time, maxAge int) *http.Cookie {
	c := s.sessionCookie(value, expires, maxAge)
	c.Name = "golf_mfa_challenge"
	if c.Secure {
		c.Name = "__Host-golf_mfa_challenge"
	}
	c.SameSite = http.SameSiteStrictMode
	return c
}
func (s *Server) mfaCookieValue(header http.Header) string {
	r := http.Request{Header: header}
	name := s.mfaCookie("", time.Time{}, 0).Name
	c, e := r.Cookie(name)
	if e != nil {
		return ""
	}
	return c.Value
}

// Called only after password verification and native identity verification.
func (s *Server) beginMFALogin(ctx context.Context, row database.GetLocalAccountRow) (string, time.Time, bool, error) {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return "", time.Time{}, false, errStorageUnavailable
	}
	defer tx.Rollback()
	// Preserve the same user -> local account -> MFA lock order as session creation.
	var owner int64
	e = tx.QueryRowContext(ctx, `SELECT id FROM golf_users WHERE id=$1 AND forge_url=$2 AND forge_user_id=$3 FOR UPDATE`, row.UserID, s.config.GiteaURL, row.ForgeUserID).Scan(&owner)
	if e != nil {
		return "", time.Time{}, false, errLocalCredentials
	}
	account, e := database.New(s.db).WithTx(tx).LockLocalAccount(ctx, database.LockLocalAccountParams{ID: row.ID, UserID: row.UserID})
	if e != nil || account.DisabledAt.Valid || account.CredentialVersion != row.CredentialVersion || account.PasswordHash != row.PasswordHash {
		return "", time.Time{}, false, errLocalCredentials
	}
	if e = s.requireGolfUserAccess(ctx, tx, row.UserID); e != nil {
		return "", time.Time{}, false, e
	}
	v, e := loadLocalMFA(ctx, tx, row.ID, true)
	if errors.Is(e, sql.ErrNoRows) || e == nil && !v.Enabled {
		return "", time.Time{}, false, nil
	}
	if e != nil {
		return "", time.Time{}, false, errStorageUnavailable
	}
	random := make([]byte, 32)
	if _, e = rand.Read(random); e != nil {
		return "", time.Time{}, false, e
	}
	value := base64.RawURLEncoding.EncodeToString(random)
	hash, _ := sessionHash(value)
	var expires time.Time
	// Expired challenges are credential-free metadata and can be deleted safely.
	if _, e = tx.ExecContext(ctx, `DELETE FROM golf_mfa_login_challenges WHERE account_id=$1 AND (expires_at<clock_timestamp() OR consumed_at IS NOT NULL)`, row.ID); e != nil {
		return "", time.Time{}, false, errStorageUnavailable
	}
	var active int
	if e = tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_mfa_login_challenges WHERE account_id=$1 AND expires_at>clock_timestamp() AND consumed_at IS NULL`, row.ID).Scan(&active); e != nil {
		return "", time.Time{}, false, errStorageUnavailable
	}
	if active >= 10 {
		return "", time.Time{}, false, errLocalRateLimited
	}
	if e = tx.QueryRowContext(ctx, `INSERT INTO golf_mfa_login_challenges(token_hash,account_id,user_id,credential_version,mfa_version,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '5 minutes') RETURNING expires_at`, hash, row.ID, row.UserID, row.CredentialVersion, v.Version).Scan(&expires); e != nil {
		return "", time.Time{}, false, errStorageUnavailable
	}
	if e = tx.Commit(); e != nil {
		return "", time.Time{}, false, errStorageUnavailable
	}
	return value, expires, true, nil
}
func (s *Server) CompletePasswordMFA(ctx context.Context, req *connect.Request[golfv1.CompletePasswordMFARequest]) (*connect.Response[golfv1.LoginWithPasswordResponse], error) {
	hash, e := sessionHash(s.mfaCookieValue(req.Header()))
	if e != nil {
		return nil, rpcError(errLocalCredentials)
	}
	if s.db == nil {
		return nil, rpcError(errStorageUnavailable)
	}
	// Charge one durable attempt before provider waits/session creation. Five tries
	// per opaque password-authenticated challenge; no TOTP/account enumeration.
	var account, user, credentialVersion, mfaVersion int64
	e = s.db.QueryRowContext(ctx, `UPDATE golf_mfa_login_challenges SET attempts=attempts+1 WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() AND attempts<5 RETURNING account_id,user_id,credential_version,mfa_version`, hash).Scan(&account, &user, &credentialVersion, &mfaVersion)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, rpcError(errLocalCredentials)
	}
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if e = s.reserveMFAAttempt(ctx, account); e != nil {
		return nil, rpcError(e)
	}
	var forgeID int64
	var cipher, binding []byte
	var key string
	e = s.db.QueryRowContext(ctx, `SELECT u.forge_user_id,a.encrypted_forge_token,a.credential_binding,a.credential_key_id FROM golf_local_accounts a JOIN golf_users u ON u.id=a.user_id WHERE a.id=$1 AND a.user_id=$2 AND a.credential_version=$3 AND a.disabled_at IS NULL AND u.forge_url=$4`, account, user, credentialVersion, s.config.GiteaURL).Scan(&forgeID, &cipher, &binding, &key)
	if e != nil {
		return nil, rpcError(errLocalCredentials)
	}
	token, e := s.keyring.open(key, localAccountDomain, cipher, binding)
	if e != nil {
		return nil, rpcError(e)
	}
	actor, e := s.currentUser(ctx, forgeCredential{Kind: "pat", Token: token})
	if e != nil {
		return nil, rpcError(e)
	}
	if actor.ID != forgeID {
		return nil, rpcError(errLocalCredentials)
	}
	result, e := s.createSessionBound(ctx, actor, "local", token, s.cookieValue(req.Header()), &localLoginBinding{accountID: account, userID: user, version: credentialVersion, mfaChallenge: hash, mfaVersion: mfaVersion, mfaCode: req.Msg.Code})
	if e != nil {
		return nil, rpcError(e)
	}
	response := connect.NewResponse(&golfv1.LoginWithPasswordResponse{User: wireUser(result.User)})
	response.Header().Add("Set-Cookie", s.sessionCookie(result.Value, result.Expires, int(sessionLifetime.Seconds())).String())
	response.Header().Add("Set-Cookie", s.mfaCookie("", time.Unix(1, 0), -1).String())
	return response, nil
}
func (s *Server) localMFAState(ctx context.Context, tx database.DBTX, row database.GetOwnPasswordConfirmationRow) (*golfv1.OwnMFA, error) {
	out := &golfv1.OwnMFA{UserId: strconv.FormatInt(row.ForgeUserID, 10), AccountId: strconv.FormatInt(row.ID, 10), Version: "0"}
	v, e := loadLocalMFA(ctx, tx, row.ID, false)
	if errors.Is(e, sql.ErrNoRows) {
		return out, nil
	}
	if e != nil {
		return nil, errStorageUnavailable
	}
	out.Version = strconv.FormatInt(v.Version, 10)
	out.Enabled = v.Enabled
	if v.PendingExpires.Valid && v.PendingExpires.Time.After(time.Now()) {
		out.PendingExpiresAt = v.PendingExpires.Time.UTC().Format(time.RFC3339Nano)
	}
	e = tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_mfa_recovery_codes WHERE account_id=$1 AND version=$2 AND used_at IS NULL`, row.ID, v.Version).Scan(&out.RemainingRecoveryCodes)
	return out, e
}
func (s *Server) GetOwnMFA(ctx context.Context, req *connect.Request[golfv1.GetOwnMFARequest]) (*connect.Response[golfv1.GetOwnMFAResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	row, e := s.ownSecuritySnapshot(ctx, s.cookieValue(req.Header()), token)
	if e != nil {
		return nil, rpcError(e)
	}
	v, e := s.localMFAState(ctx, s.db, row)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetOwnMFAResponse{Mfa: v}), nil
}

// Password KDF/provider waits finish before locks; captured expiry and identity
// are rechecked under the exact current account/session lock before any mutation.
func (s *Server) withOwnMFA(ctx context.Context, header http.Header, password string, fn func(*sql.Tx, database.GetOwnPasswordConfirmationRow) error) error {
	token, e := rpcToken(ctx)
	if e != nil {
		return e
	}
	value := s.cookieValue(header)
	initial, e := s.ownSecuritySnapshot(ctx, value, token)
	if e != nil {
		return e
	}
	if !validLocalPassword(password) {
		return errPasswordConfirmation
	}
	ok, e := s.verifyLocalPasswordAttempt(ctx, initial.Username, password, initial.PasswordHash)
	if e != nil {
		return e
	}
	if !ok {
		return errPasswordConfirmation
	}
	if e = s.reserveMFAAttempt(ctx, initial.ID); e != nil {
		return e
	}
	latest, e := s.ownSecuritySnapshot(ctx, value, token)
	if e != nil {
		return e
	}
	if !sameOwnSecurity(initial, latest) {
		return errUnauthenticated
	}
	hash, e := s.authSessionHash(ctx, value, nil)
	if e != nil {
		return e
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	q := database.New(s.db).WithTx(tx)
	owner, e := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: hash, ForgeURL: s.config.GiteaURL})
	if e != nil || owner.ID != initial.UserID {
		return errUnauthenticated
	}
	account, e := q.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: initial.ID, UserID: initial.UserID})
	if e != nil || account.DisabledAt.Valid || account.CredentialVersion != initial.CredentialVersion || account.PasswordHash != initial.PasswordHash {
		return errUnauthenticated
	}
	if _, e = q.LockSessionCredential(ctx, database.LockSessionCredentialParams{TokenHash: hash, ForgeURL: s.config.GiteaURL}); e != nil {
		return errUnauthenticated
	}
	current, e := q.GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
	if e != nil || !sameOwnSecurity(initial, current) {
		return errUnauthenticated
	}
	if e = s.requireGolfUserAccess(ctx, tx, initial.UserID); e != nil {
		return e
	}
	if e = fn(tx, initial); e != nil {
		return e
	}
	live, e := q.OwnSecurityExpiryLive(ctx, initial.ExpiresAt)
	if e != nil {
		return errStorageUnavailable
	}
	if !live {
		return errUnauthenticated
	}
	return tx.Commit()
}
func (s *Server) BeginOwnMFA(ctx context.Context, req *connect.Request[golfv1.BeginOwnMFARequest]) (*connect.Response[golfv1.BeginOwnMFAResponse], error) {
	expected, e := emailVersion(req.Msg.ExpectedVersion, true)
	if e != nil {
		return nil, rpcError(e)
	}
	out := &golfv1.BeginOwnMFAResponse{}
	e = s.withOwnMFA(ctx, req.Header(), req.Msg.PasswordConfirmation, func(tx *sql.Tx, row database.GetOwnPasswordConfirmationRow) error {
		v, e := loadLocalMFA(ctx, tx, row.ID, true)
		if errors.Is(e, sql.ErrNoRows) {
			if expected != 0 {
				return errRepositorySettingsConflict
			}
			v = localMFA{AccountID: row.ID, Version: 0}
		} else if e != nil {
			return errStorageUnavailable
		}
		if v.Version != expected || v.Enabled {
			return errRepositorySettingsConflict
		}
		random := make([]byte, 20)
		if _, e = rand.Read(random); e != nil {
			return e
		}
		secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(random)
		id := uuid.NewString()
		if e = s.notificationStore(ctx, tx, id, "mfa", mfaSecret{Secret: secret, AccountID: row.ID}); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_local_mfa(account_id,version,pending_content_id,pending_expires_at) VALUES($1,1,$2,clock_timestamp()+interval '10 minutes') ON CONFLICT(account_id) DO UPDATE SET version=golf_local_mfa.version+1,pending_content_id=$2,pending_expires_at=clock_timestamp()+interval '10 minutes'`, row.ID, id); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_mfa_events(account_id,user_id,action,version) VALUES($1,$2,'setup_started',$3)`, row.ID, row.UserID, expected+1); e != nil {
			return e
		}
		out.Mfa, e = s.localMFAState(ctx, tx, row)
		out.Secret = secret
		out.ProvisioningUri = "otpauth://totp/" + url.PathEscape("Golf:"+row.Username) + "?" + url.Values{"secret": {secret}, "issuer": {"Golf"}, "algorithm": {"SHA1"}, "digits": {"6"}, "period": {"30"}}.Encode()
		return e
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}
func (s *Server) changeOwnMFA(ctx context.Context, header http.Header, m *golfv1.ChangeOwnMFARequest, action string) (*golfv1.ChangeOwnMFAResponse, error) {
	expected, e := emailVersion(m.ExpectedVersion, false)
	if e != nil {
		return nil, e
	}
	out := &golfv1.ChangeOwnMFAResponse{}
	e = s.withOwnMFA(ctx, header, m.PasswordConfirmation, func(tx *sql.Tx, row database.GetOwnPasswordConfirmationRow) error {
		v, e := loadLocalMFA(ctx, tx, row.ID, true)
		if e != nil {
			return errRepositorySettingsConflict
		}
		if v.Version != expected {
			return errRepositorySettingsConflict
		}
		if action == "enabled" {
			if v.Enabled || !v.Pending.Valid {
				return errRepositorySettingsConflict
			}
			var live bool
			if e = tx.QueryRowContext(ctx, `SELECT $1::timestamptz>clock_timestamp()`, v.PendingExpires).Scan(&live); e != nil || !live {
				return errRepositorySettingsConflict
			}
			var secret mfaSecret
			if e = s.notificationLoad(ctx, tx, v.Pending.String, "mfa", &secret); e != nil {
				return e
			}
			if secret.AccountID != row.ID {
				return errCredentialUnavailable
			}
			var now time.Time
			if e = tx.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&now); e != nil {
				return e
			}
			counter, ok := totpCounter(secret.Secret, m.Code, now, -1)
			if !ok {
				return errLocalCredentials
			}
			_, e = tx.ExecContext(ctx, `UPDATE golf_local_mfa SET version=version+1,enabled=true,active_content_id=pending_content_id,pending_content_id=NULL,pending_expires_at=NULL,last_counter=$2 WHERE account_id=$1`, row.ID, counter)
		} else {
			recovery, e := s.consumeMFA(ctx, tx, v, m.Code)
			if e != nil {
				return e
			}
			if recovery {
				if _, e = tx.ExecContext(ctx, `INSERT INTO golf_mfa_events(account_id,user_id,action,version) VALUES($1,$2,'recovery_used',$3)`, row.ID, row.UserID, v.Version); e != nil {
					return e
				}
			}
			if action == "disabled" {
				_, e = tx.ExecContext(ctx, `UPDATE golf_local_mfa SET version=version+1,enabled=false,active_content_id=NULL,pending_content_id=NULL,pending_expires_at=NULL,last_counter=-1 WHERE account_id=$1`, row.ID)
			} else {
				_, e = tx.ExecContext(ctx, `UPDATE golf_local_mfa SET version=version+1 WHERE account_id=$1`, row.ID)
			}
		}
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `DELETE FROM golf_mfa_recovery_codes WHERE account_id=$1`, row.ID); e != nil {
			return e
		}
		if action != "disabled" {
			out.RecoveryCodes, e = recoveryCodes(ctx, tx, row.ID, expected+1)
			if e != nil {
				return e
			}
		}
		out.OperationId, e = newAuditOperation()
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_mfa_events(account_id,user_id,action,version,operation_id) VALUES($1,$2,$3,$4,$5)`, row.ID, row.UserID, action, expected+1, out.OperationId); e != nil {
			return e
		}
		count, e := database.New(s.db).WithTx(tx).DeleteLocalAccountSessions(ctx, sql.NullInt64{Int64: row.ID, Valid: true})
		if e != nil {
			return e
		}
		out.SessionsRevoked = uint64(count)
		out.RequiresLogin = true
		out.Mfa, e = s.localMFAState(ctx, tx, row)
		return e
	})
	return out, e
}
func (s *Server) ownMFAResponse(ctx context.Context, req *connect.Request[golfv1.ChangeOwnMFARequest], action string) (*connect.Response[golfv1.ChangeOwnMFAResponse], error) {
	v, e := s.changeOwnMFA(ctx, req.Header(), req.Msg, action)
	if e != nil {
		return nil, rpcError(e)
	}
	out := connect.NewResponse(v)
	out.Header().Add("Set-Cookie", s.sessionCookie("", time.Unix(1, 0), -1).String())
	out.Header().Add("Set-Cookie", s.mfaCookie("", time.Unix(1, 0), -1).String())
	return out, nil
}
func (s *Server) ConfirmOwnMFA(ctx context.Context, req *connect.Request[golfv1.ChangeOwnMFARequest]) (*connect.Response[golfv1.ChangeOwnMFAResponse], error) {
	return s.ownMFAResponse(ctx, req, "enabled")
}
func (s *Server) DisableOwnMFA(ctx context.Context, req *connect.Request[golfv1.ChangeOwnMFARequest]) (*connect.Response[golfv1.ChangeOwnMFAResponse], error) {
	return s.ownMFAResponse(ctx, req, "disabled")
}
func (s *Server) RegenerateOwnMFARecovery(ctx context.Context, req *connect.Request[golfv1.ChangeOwnMFARequest]) (*connect.Response[golfv1.ChangeOwnMFAResponse], error) {
	return s.ownMFAResponse(ctx, req, "recovery_regenerated")
}

// All local session creation paths share this lock-bound gate. The code and the
// opaque challenge are consumed in the same transaction as the new session.
func (s *Server) checkMFASessionBinding(ctx context.Context, tx *sql.Tx, local *localLoginBinding) error {
	// Internal reviewer grants already authorize background use independently of interactive sign-in.
	if local.background {
		return nil
	}
	v, e := loadLocalMFA(ctx, tx, local.accountID, true)
	if errors.Is(e, sql.ErrNoRows) || e == nil && !v.Enabled {
		if len(local.mfaChallenge) != 0 {
			return errLocalCredentials
		}
		return nil
	}
	if e != nil {
		return errStorageUnavailable
	}
	if len(local.mfaChallenge) != 32 || v.Version != local.mfaVersion {
		return errMFARequired
	}
	var id int64
	e = tx.QueryRowContext(ctx, `SELECT account_id FROM golf_mfa_login_challenges WHERE token_hash=$1 AND account_id=$2 AND user_id=$3 AND credential_version=$4 AND mfa_version=$5 AND consumed_at IS NULL AND attempts BETWEEN 1 AND 5 AND expires_at>clock_timestamp() FOR UPDATE`, local.mfaChallenge, local.accountID, local.userID, local.version, local.mfaVersion).Scan(&id)
	if e != nil {
		return errLocalCredentials
	}
	recovery, e := s.consumeMFA(ctx, tx, v, local.mfaCode)
	if e != nil {
		return e
	}
	if recovery {
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_mfa_events(account_id,user_id,action,version) VALUES($1,$2,'recovery_used',$3)`, local.accountID, local.userID, v.Version); e != nil {
			return errStorageUnavailable
		}
	}
	result, e := tx.ExecContext(ctx, `UPDATE golf_mfa_login_challenges SET consumed_at=clock_timestamp() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, local.mfaChallenge)
	if e != nil {
		return errStorageUnavailable
	}
	n, e := result.RowsAffected()
	if e != nil || n != 1 {
		return errLocalCredentials
	}
	return nil
}

// A successful password must not grant a fresh independent factor-guess budget.
// This fixed ten-attempt/5-minute bound spans processes, aliases and challenges.
func (s *Server) reserveMFAAttempt(ctx context.Context, account int64) error {
	var attempts int
	e := s.db.QueryRowContext(ctx, `INSERT INTO golf_mfa_attempts(account_id,window_start,attempts) VALUES($1,clock_timestamp(),1)
 ON CONFLICT(account_id) DO UPDATE SET window_start=CASE WHEN golf_mfa_attempts.window_start<clock_timestamp()-interval '5 minutes' THEN clock_timestamp() ELSE golf_mfa_attempts.window_start END,
 attempts=CASE WHEN golf_mfa_attempts.window_start<clock_timestamp()-interval '5 minutes' THEN 1 ELSE golf_mfa_attempts.attempts+1 END
 WHERE golf_mfa_attempts.window_start<clock_timestamp()-interval '5 minutes' OR golf_mfa_attempts.attempts<10 RETURNING attempts`, account).Scan(&attempts)
	if errors.Is(e, sql.ErrNoRows) {
		return errLocalRateLimited
	}
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

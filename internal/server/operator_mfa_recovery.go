package server

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

// Console-only privileged recovery; never exported through a browser RPC. The
// operator owns the DB/keyring and acknowledges writer drain/traffic quarantine.
// Current native identity is verified through its supported API, not forge SQL.
func ResetOperatorLocalMFA(ctx context.Context, db *sql.DB, keys *Keyring, forgeURL string, input LocalAccountInput) (LocalAccountResult, error) {
	empty := LocalAccountResult{}
	bad := errors.New("Operator MFA recovery requires exact immutable account/native IDs and saved versions, a reason, warning acknowledgement and drained Golf writers.")
	account, e := discussionID(input.AccountID)
	if e != nil {
		return empty, bad
	}
	user, e := discussionID(input.GolfUserID)
	if e != nil {
		return empty, bad
	}
	nativeID, e := discussionID(input.ExpectedNativeUserID)
	if e != nil {
		return empty, bad
	}
	version, e := discussionID(input.ExpectedCredentialVersion)
	if e != nil {
		return empty, bad
	}
	factorVersion, e := discussionID(input.ExpectedMFAVersion)
	if e != nil {
		return empty, bad
	}
	reason := strings.TrimSpace(input.RecoveryReason)
	if !localUsername.MatchString(input.Username) || !input.AcknowledgeMFAReset || !input.WritersDrained || reason == "" || len(reason) > 512 || !discussionText(reason, 512) || input.Password != "" || input.ForgeToken != "" || input.Email != "" || input.IsInstanceAdmin {
		return empty, bad
	}
	parsed, e := url.Parse(forgeURL)
	if e != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return empty, errors.New("Forge configuration is invalid.")
	}
	forgeURL = strings.TrimRight(forgeURL, "/")
	if db == nil {
		return empty, errStorageUnavailable
	}
	if e = checkRuntimeKeys(ctx, db, keys); e != nil {
		return empty, e
	}
	q := database.New(db)
	observed, e := q.GetLocalAccount(ctx, database.GetLocalAccountParams{Username: input.Username, ForgeURL: forgeURL})
	if e != nil {
		return empty, errResourceNotFound
	}
	if observed.ID != account || observed.UserID != user || observed.ForgeUserID != nativeID || observed.CredentialVersion != version {
		return empty, errAdminAccountConflict
	}
	token, e := keys.open(observed.CredentialKeyID, localAccountDomain, observed.EncryptedForgeToken, observed.CredentialBinding)
	if e != nil {
		return empty, errCredentialUnavailable
	}
	s := &Server{db: db, keyring: keys, config: Config{GiteaURL: forgeURL}, client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	native, e := s.currentUser(ctx, forgeCredential{Kind: "pat", Token: token})
	if e != nil || native.ID != nativeID {
		return empty, errors.New("The current native identity could not be verified; reconcile the mapped credential before recovery.")
	}
	tx, e := db.BeginTx(ctx, nil)
	if e != nil {
		return empty, errStorageUnavailable
	}
	defer tx.Rollback()
	locked := q.WithTx(tx)
	owner, e := locked.LockLocalAccountUser(ctx, database.LockLocalAccountUserParams{Username: input.Username, ForgeURL: forgeURL})
	if e != nil || owner != user {
		return empty, errAdminAccountConflict
	}
	current, e := locked.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: account, UserID: user})
	if e != nil {
		return empty, errStorageUnavailable
	}
	latest, e := locked.GetAdminAccountTarget(ctx, database.GetAdminAccountTargetParams{ID: account, ForgeURL: forgeURL})
	if e != nil || latest.ForgeUserID != nativeID || current.Username != input.Username || current.CredentialVersion != version || current.PasswordHash != observed.PasswordHash || current.CredentialKeyID != observed.CredentialKeyID || !bytes.Equal(current.EncryptedForgeToken, observed.EncryptedForgeToken) || !bytes.Equal(current.CredentialBinding, observed.CredentialBinding) {
		return empty, errAdminAccountConflict
	}
	factor, e := loadLocalMFA(ctx, tx, account, true)
	if e != nil || factor.Version != factorVersion || !factor.Enabled && !factor.Pending.Valid {
		return empty, errAdminAccountConflict
	}
	operation, e := newAuditOperation()
	if e != nil {
		return empty, e
	}
	effects, e := resetLocalMFALocked(ctx, tx, locked, account, user, version, factorVersion)
	if e != nil {
		return empty, e
	}
	revoked, challengeCount, codeCount := effects.sessions, effects.challenges, effects.codes
	if _, e = tx.ExecContext(ctx, `INSERT INTO golf_mfa_events(account_id,user_id,action,version,operation_id,actor_kind,reason) VALUES($1,$2,'operator_reset',$3,$4,'operator',$5)`, account, user, factorVersion+1, operation, reason); e != nil {
		return empty, errStorageUnavailable
	}
	if e = locked.AppendLocalAccountEvent(ctx, database.AppendLocalAccountEventParams{AccountID: account, OperationID: operation, Action: "OPERATOR_MFA_RESET", CredentialVersion: version + 1, SessionsRevoked: revoked}); e != nil {
		return empty, errStorageUnavailable
	}
	if e = tx.Commit(); e != nil {
		return empty, errStorageUnavailable
	}
	return LocalAccountResult{ID: input.AccountID, Username: current.Username, Email: current.Email.String, UserID: input.GolfUserID, IsInstanceAdmin: current.IsInstanceAdmin, Disabled: current.DisabledAt.Valid, CredentialVersion: strconv.FormatInt(version+1, 10), MFAVersion: strconv.FormatInt(factorVersion+1, 10), SessionsRevoked: uint64(revoked), ChallengesRevoked: uint64(challengeCount), RecoveryCodesRevoked: uint64(codeCount), OperationID: operation}, nil
}

// Privileged read-only discovery for a locked-out administrator. Only saved
// nonsecret Golf metadata is read; this never queries/decrypts native secrets.
func InspectOperatorLocalAccount(ctx context.Context, db *sql.DB, forgeURL, username string) (LocalAccountResult, error) {
	var out LocalAccountResult
	if !localUsername.MatchString(username) {
		return out, errors.New("Use the canonical enrolled Golf username.")
	}
	if db == nil {
		return out, errStorageUnavailable
	}
	forgeURL = strings.TrimRight(forgeURL, "/")
	var account, user, native, credential, mfa int64
	var disabled sql.NullTime
	var pending sql.NullTime
	e := db.QueryRowContext(ctx, `SELECT a.id,a.user_id,u.forge_user_id,a.username,COALESCE(a.email,''),a.is_instance_admin,a.disabled_at,a.credential_version,COALESCE(m.version,0),COALESCE(m.enabled,false),m.pending_expires_at FROM golf_local_accounts a JOIN golf_users u ON u.id=a.user_id LEFT JOIN golf_local_mfa m ON m.account_id=a.id WHERE a.username=$1 AND u.forge_url=$2`, username, forgeURL).Scan(&account, &user, &native, &out.Username, &out.Email, &out.IsInstanceAdmin, &disabled, &credential, &mfa, &out.MFAEnabled, &pending)
	if errors.Is(e, sql.ErrNoRows) {
		return out, errResourceNotFound
	}
	if e != nil {
		return out, errStorageUnavailable
	}
	out.ID = strconv.FormatInt(account, 10)
	out.UserID = strconv.FormatInt(user, 10)
	out.NativeUserID = strconv.FormatInt(native, 10)
	out.CredentialVersion = strconv.FormatInt(credential, 10)
	out.MFAVersion = strconv.FormatInt(mfa, 10)
	out.Disabled = disabled.Valid
	if pending.Valid {
		out.MFAPendingExpiresAt = pending.Time.UTC().Format(time.RFC3339Nano)
	}
	return out, nil
}

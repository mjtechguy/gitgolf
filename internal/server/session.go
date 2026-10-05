package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

const cookieName = "golf_session"
const sessionLifetime = 12 * time.Hour

func sessionHash(value string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return nil, errUnauthenticated
	}
	hash := sha256.Sum256([]byte(value))
	return hash[:], nil
}
func (s *Server) sessionCookie(value string, expires time.Time, maxAge int) *http.Cookie {
	name := cookieName
	if !s.config.AllowInsecureCookies {
		name = "__Host-golf_session"
	}
	return &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, Secure: !s.config.AllowInsecureCookies, SameSite: http.SameSiteLaxMode, Expires: expires, MaxAge: maxAge}
}

type loginResult struct {
	User    User
	Value   string
	Expires time.Time
}

func (s *Server) loginSession(ctx context.Context, token, oldValue string) (loginResult, error) {
	if len(token) < 8 || len(token) > 512 || strings.ContainsAny(token, "\r\n\t ") {
		return loginResult{}, invalid("Enter a valid Gitea access token.")
	}
	user, err := s.currentUser(ctx, forgeCredential{Kind: "pat", Token: token})
	if err != nil {
		return loginResult{}, err
	}
	return s.createSession(ctx, user, "pat", token, oldValue)
}

func (s *Server) createSession(ctx context.Context, user User, kind, payload, oldValue string) (loginResult, error) {
	return s.createSessionBound(ctx, user, kind, payload, oldValue, nil)
}
func (s *Server) createSessionBound(ctx context.Context, user User, kind, payload, oldValue string, local *localLoginBinding) (loginResult, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return loginResult{}, err
	}
	value := base64.RawURLEncoding.EncodeToString(random)
	hash, _ := sessionHash(value)
	expires := time.Now().UTC().Add(sessionLifetime)
	if s.db == nil {
		return loginResult{}, errStorageUnavailable
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return loginResult{}, errStorageUnavailable
	}
	defer tx.Rollback()
	queries := database.New(s.db).WithTx(tx)
	// The two account locks are sorted before any profile update, session lock
	// or event-ID allocation. Opposite-direction cookie replacements cannot
	// each hold the account their competitor needs. INSERT DO NOTHING avoids
	// updating/locking an existing new account before this ordered step.
	if err := queries.EnsureLoginUser(ctx, database.EnsureLoginUserParams{ForgeURL: s.config.GiteaURL, ForgeUserID: user.ID, Login: user.Login, FullName: user.FullName, AvatarURL: user.AvatarURL}); err != nil {
		return loginResult{}, errStorageUnavailable
	}
	oldHash, _ := sessionHash(oldValue)
	accounts, err := queries.LockLoginUsers(ctx, database.LockLoginUsersParams{ForgeURL: s.config.GiteaURL, ForgeUserID: user.ID, OldTokenHash: oldHash})
	if err != nil {
		return loginResult{}, errStorageUnavailable
	}
	id, err := queries.UpsertUser(ctx, database.UpsertUserParams{ForgeURL: s.config.GiteaURL, ForgeUserID: user.ID, Login: user.Login, FullName: user.FullName, AvatarURL: user.AvatarURL})
	if err != nil {
		return loginResult{}, errStorageUnavailable
	}
	if err := s.requireGolfUserAccess(ctx, tx, id); err != nil {
		return loginResult{}, err
	}
	if local != nil {
		account, err := queries.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: local.accountID, UserID: id})
		if errors.Is(err, sql.ErrNoRows) {
			return loginResult{}, errLocalCredentials
		}
		if err != nil {
			return loginResult{}, errStorageUnavailable
		}
		if local.userID != id || account.DisabledAt.Valid || account.CredentialVersion != local.version {
			return loginResult{}, errLocalCredentials
		}
		user.IsInstanceAdmin = account.IsInstanceAdmin
	}
	operation, err := newAuditOperation()
	if err != nil {
		return loginResult{}, err
	}
	for _, account := range accounts {
		if oldHash == nil {
			break
		}
		old, err := queries.DeleteAuditedSession(ctx, database.DeleteAuditedSessionParams{TokenHash: oldHash, UserID: account.ID, ForgeURL: s.config.GiteaURL})
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return loginResult{}, errStorageUnavailable
		}
		oldOperation := operation
		if account.ID != id {
			oldOperation = ""
		} // No cross-account operation correlation.
		if err := appendAudit(ctx, queries, database.AppendAuditEventParams{UserID: account.ID, Action: "SESSION_REPLACED", ActorSessionID: old.SessionID, TargetSessionID: auditTarget(old.SessionID), CredentialKind: old.CredentialKind, RevokedCount: 1, OperationID: oldOperation}); err != nil {
			return loginResult{}, err
		}
	}
	encrypted, keyID, err := s.keyring.seal(sessionDomain, payload, hash)
	if err != nil {
		return loginResult{}, err
	}
	var sessionID int64
	if local == nil {
		sessionID, err = queries.CreateKeyedSession(ctx, database.CreateKeyedSessionParams{TokenHash: hash, UserID: id, EncryptedToken: encrypted, ExpiresAt: expires, CredentialKind: kind, CredentialKeyID: keyID})
	} else {
		sessionID, err = queries.CreateLocalSession(ctx, database.CreateLocalSessionParams{TokenHash: hash, UserID: id, EncryptedToken: encrypted, ExpiresAt: expires, CredentialKeyID: keyID, LocalAccountID: sql.NullInt64{Int64: local.accountID, Valid: true}, LocalCredentialVersion: sql.NullInt64{Int64: local.version, Valid: true}})
	}
	if err != nil {
		return loginResult{}, errStorageUnavailable
	}
	if err := appendAudit(ctx, queries, database.AppendAuditEventParams{UserID: id, Action: "SIGN_IN", ActorSessionID: sessionID, TargetSessionID: auditTarget(sessionID), CredentialKind: kind, OperationID: operation, ExpiresAt: sql.NullTime{Time: expires, Valid: true}}); err != nil {
		return loginResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return loginResult{}, errStorageUnavailable
	}
	// Cleanup has no lifecycle-event meaning and must not hold account locks
	// while deleting expired rows belonging to unrelated accounts. A cleanup
	// failure cannot turn an already committed sign-in into a false failure.
	_ = database.New(s.db).DeleteExpiredSessions(ctx)
	return loginResult{user, value, expires}, nil
}
func (s *Server) sessionCredential(ctx context.Context, value string) (forgeCredential, error) {
	hash, err := s.authSessionHash(ctx, value, nil)
	if err != nil {
		return forgeCredential{}, err
	}
	return s.sessionCredentialHash(ctx, hash)
}

// The trusted scheduler resolves an existing session; no credential reaches a job.
func (s *Server) sessionCredentialHash(ctx context.Context, hash []byte) (forgeCredential, error) {
	if s.db == nil {
		return forgeCredential{}, errStorageUnavailable
	}
	row, err := s.currentGolfSessionCredential(ctx, hash)
	if errors.Is(err, sql.ErrNoRows) {
		return forgeCredential{}, errUnauthenticated
	}
	if err != nil {
		return forgeCredential{}, errStorageUnavailable
	}
	payload, err := s.keyring.open(row.CredentialKeyID, sessionDomain, row.EncryptedToken, hash)
	if err != nil {
		return forgeCredential{}, errCredentialUnavailable
	}
	var credential forgeCredential
	switch row.CredentialKind {
	case "pat", "local":
		credential = forgeCredential{Kind: "pat", Token: payload, Local: row.CredentialKind == "local"}
	case "oauth":
		credential, err = s.oauthCredential(ctx, hash, payload)
		if err != nil {
			return forgeCredential{}, err
		}
	default:
		return forgeCredential{}, errCredentialUnavailable
	}
	// Refresh can wait on a provider or a session lock. Re-read after it has
	// released its transaction; never acquire a user lock inside OAuth refresh.
	current, err := s.currentGolfSessionCredential(ctx, hash)
	if errors.Is(err, sql.ErrNoRows) {
		return forgeCredential{}, errUnauthenticated
	}
	if err != nil {
		return forgeCredential{}, errStorageUnavailable
	}
	if current.ForgeUserID != row.ForgeUserID || current.CredentialKind != row.CredentialKind || !current.ExpiresAt.After(time.Now()) {
		return forgeCredential{}, errUnauthenticated
	}
	return credential, nil
}
func (s *Server) logoutSession(ctx context.Context, value string) error {
	hash, err := sessionHash(value)
	if err != nil {
		return nil
	}
	if s.db == nil {
		return errStorageUnavailable
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	queries := database.New(s.db).WithTx(tx)
	id, err := queries.LockLogoutUser(ctx, database.LockLogoutUserParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return errStorageUnavailable
	}
	old, err := queries.DeleteAuditedSession(ctx, database.DeleteAuditedSessionParams{TokenHash: hash, UserID: id, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return errStorageUnavailable
	}
	if err := appendAudit(ctx, queries, database.AppendAuditEventParams{UserID: id, Action: "SIGN_OUT", ActorSessionID: old.SessionID, TargetSessionID: auditTarget(old.SessionID), CredentialKind: old.CredentialKind, RevokedCount: 1}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return errStorageUnavailable
	}
	return nil
}

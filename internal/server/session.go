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

func (s *Server) seal(token string, hash []byte) []byte {
	nonce := make([]byte, s.cipher.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	return s.cipher.Seal(nonce, nonce, []byte(token), hash)
}
func (s *Server) unseal(value, hash []byte) (string, error) {
	n := s.cipher.NonceSize()
	if len(value) < n {
		return "", errors.New("invalid credential envelope")
	}
	plain, err := s.cipher.Open(nil, value[:n], value[n:], hash)
	return string(plain), err
}
func sessionHash(value string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return nil, errUnauthenticated
	}
	hash := sha256.Sum256([]byte(value))
	return hash[:], nil
}
func (s *Server) sessionCookie(value string, expires time.Time, maxAge int) *http.Cookie {
	return &http.Cookie{Name: cookieName, Value: value, Path: "/", HttpOnly: true, Secure: !s.config.AllowInsecureCookies, SameSite: http.SameSiteLaxMode, Expires: expires, MaxAge: maxAge}
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
	id, err := queries.UpsertUser(ctx, database.UpsertUserParams{ForgeURL: s.config.GiteaURL, ForgeUserID: user.ID, Login: user.Login, FullName: user.FullName, AvatarURL: user.AvatarURL})
	if err == nil {
		err = queries.CreateSession(ctx, database.CreateSessionParams{TokenHash: hash, UserID: id, EncryptedToken: s.seal(payload, hash), ExpiresAt: expires, CredentialKind: kind})
	}
	if err == nil {
		err = queries.DeleteExpiredSessions(ctx)
	}
	if oldHash, hashErr := sessionHash(oldValue); err == nil && hashErr == nil {
		err = queries.DeleteSession(ctx, oldHash)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		return loginResult{}, errStorageUnavailable
	}
	return loginResult{user, value, expires}, nil
}
func (s *Server) sessionCredential(ctx context.Context, value string) (forgeCredential, error) {
	hash, err := sessionHash(value)
	if err != nil {
		return forgeCredential{}, errUnauthenticated
	}
	if s.db == nil {
		return forgeCredential{}, errStorageUnavailable
	}
	row, err := database.New(s.db).GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return forgeCredential{}, errUnauthenticated
	}
	if err != nil {
		return forgeCredential{}, errStorageUnavailable
	}
	payload, err := s.unseal(row.EncryptedToken, hash)
	if err != nil {
		return forgeCredential{}, errCredentialUnavailable
	}
	switch row.CredentialKind {
	case "pat":
		if !row.ExpiresAt.After(time.Now()) {
			return forgeCredential{}, errUnauthenticated
		}
		return forgeCredential{Kind: "pat", Token: payload}, nil
	case "oauth":
		credential, err := s.oauthCredential(ctx, hash, payload)
		if !row.ExpiresAt.After(time.Now()) {
			return forgeCredential{}, errUnauthenticated
		}
		return credential, err
	default:
		return forgeCredential{}, errCredentialUnavailable
	}
}
func (s *Server) logoutSession(ctx context.Context, value string) error {
	hash, err := sessionHash(value)
	if err != nil {
		return nil
	}
	if s.db == nil {
		return errStorageUnavailable
	}
	if err := database.New(s.db).DeleteSession(ctx, hash); err != nil {
		return errStorageUnavailable
	}
	return nil
}

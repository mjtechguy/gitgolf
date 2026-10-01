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
		return nil, errors.New("invalid session")
	}
	hash := sha256.Sum256([]byte(value))
	return hash[:], nil
}

func (s *Server) setCookie(w http.ResponseWriter, value string, expires time.Time, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: value, Path: "/", HttpOnly: true,
		Secure: !s.config.AllowInsecureCookies, SameSite: http.SameSiteLaxMode, Expires: expires, MaxAge: maxAge})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token string `json:"token"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if len(input.Token) < 8 || len(input.Token) > 512 || strings.ContainsAny(input.Token, "\r\n\t ") {
		problem(w, http.StatusBadRequest, "invalid_token", "Enter a valid Gitea access token.")
		return
	}
	user, err := s.currentUser(r.Context(), input.Token)
	if err != nil {
		s.forgeProblem(w, err)
		return
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		problem(w, 500, "session_failed", "Could not create session.")
		return
	}
	value := base64.RawURLEncoding.EncodeToString(random)
	hash, _ := sessionHash(value)
	expires := time.Now().UTC().Add(sessionLifetime)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		problem(w, 503, "database_unavailable", "Session storage is unavailable.")
		return
	}
	defer tx.Rollback()
	var id int64
	err = tx.QueryRowContext(r.Context(), `INSERT INTO golf_users (forge_url, forge_user_id, login, full_name, avatar_url)
		VALUES ($1,$2,$3,$4,$5) ON CONFLICT (forge_url, forge_user_id) DO UPDATE SET login=EXCLUDED.login,
		full_name=EXCLUDED.full_name, avatar_url=EXCLUDED.avatar_url RETURNING id`, s.config.GiteaURL, user.ID, user.Login, user.FullName, user.AvatarURL).Scan(&id)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO golf_sessions (token_hash,user_id,encrypted_token,expires_at) VALUES ($1,$2,$3,$4)`, hash, id, s.seal(input.Token, hash), expires)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `DELETE FROM golf_sessions WHERE expires_at < now()`)
	}
	// Re-authentication replaces this browser's old session rather than leaving it live.
	if old, cookieErr := r.Cookie(cookieName); err == nil && cookieErr == nil {
		if oldHash, hashErr := sessionHash(old.Value); hashErr == nil {
			_, err = tx.ExecContext(r.Context(), `DELETE FROM golf_sessions WHERE token_hash=$1`, oldHash)
		}
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		problem(w, 503, "session_failed", "Could not persist session.")
		return
	}
	s.setCookie(w, value, expires, int(sessionLifetime.Seconds()))
	respond(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) token(w http.ResponseWriter, r *http.Request) (string, bool) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		problem(w, 401, "unauthenticated", "Sign in to Golf.")
		return "", false
	}
	hash, err := sessionHash(cookie.Value)
	if err != nil {
		problem(w, 401, "unauthenticated", "Sign in to Golf.")
		return "", false
	}
	var encrypted []byte
	err = s.db.QueryRowContext(r.Context(), `SELECT s.encrypted_token FROM golf_sessions s JOIN golf_users u ON u.id=s.user_id
		WHERE s.token_hash=$1 AND s.expires_at > now() AND u.forge_url=$2`, hash, s.config.GiteaURL).Scan(&encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		problem(w, 401, "unauthenticated", "Session expired. Sign in again.")
		return "", false
	}
	if err != nil {
		problem(w, 503, "database_unavailable", "Session storage is unavailable.")
		return "", false
	}
	token, err := s.unseal(encrypted, hash)
	if err != nil {
		problem(w, 503, "credential_unavailable", "Session credential cannot be decrypted. Sign in again.")
		return "", false
	}
	return token, true
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	token, ok := s.token(w, r)
	if !ok {
		return
	}
	user, err := s.currentUser(r.Context(), token)
	if err != nil {
		s.forgeProblem(w, err)
		return
	}
	respond(w, 200, map[string]any{"user": user})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(cookieName); err == nil {
		if hash, err := sessionHash(cookie.Value); err == nil {
			if err := s.deleteSession(r.Context(), hash); err != nil {
				problem(w, 503, "logout_failed", "Session storage is unavailable; sign-out was not completed.")
				return
			}
		}
	}
	s.setCookie(w, "", time.Unix(1, 0), -1)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteSession(ctx context.Context, hash []byte) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM golf_sessions WHERE token_hash=$1`, hash)
	return err
}

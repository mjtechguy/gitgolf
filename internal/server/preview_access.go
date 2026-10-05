package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"fmt"
	"html"
	"net/http"
	"strings"
	"time"
)

const previewCookie = "__Host-golf_preview"

func previewToken() (string, []byte, error) {
	raw := make([]byte, 32)
	if _, e := rand.Read(raw); e != nil {
		return "", nil, e
	}
	value := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(value))
	return value, sum[:], nil
}
func previewTokenHash(value string) ([]byte, error) {
	raw, e := base64.RawURLEncoding.DecodeString(value)
	if e != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != value {
		return nil, errUnauthenticated
	}
	sum := sha256.Sum256([]byte(value))
	return sum[:], nil
}

type previewCredential struct {
	user, native int64
	parent       []byte
	expires      time.Time
}

func (s *Server) previewCredential(ctx context.Context, token, id, kind string) (previewCredential, error) {
	var v previewCredential
	hash, e := previewTokenHash(token)
	if e != nil {
		return v, e
	}
	e = s.db.QueryRowContext(ctx, "SELECT user_id,native_actor_id,parent_session_hash,expires_at FROM golf_preview_credentials WHERE token_hash=$1 AND deployment_id=$2 AND kind=$3 AND expires_at>clock_timestamp()", hash, id, kind).Scan(&v.user, &v.native, &v.parent, &v.expires)
	if e != nil {
		return v, errUnauthenticated
	}
	return v, nil
}
func previewHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-same-origin")
}
func previewDenied(w http.ResponseWriter) {
	previewHeaders(w)
	http.Error(w, "Protected preview unavailable", http.StatusNotFound)
}

// Native form POST keeps the grant in a trusted document body, never a URL or
// project JS. This route is on Golf, not the untrusted project listener.
func (s *Server) DeploymentOpenHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		parts := strings.Split(r.URL.Path, "/")
		if r.Method != "POST" || len(parts) != 5 || parts[1] != "api" || parts[2] != "deployments" || parts[4] != "open" || !deploymentUUID(parts[3]) || r.URL.RawQuery != "" || r.Header.Get("Origin") != s.config.PublicURL || r.Header.Get("Authorization") != "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" || !s.previewAvailable() || r.TLS == nil || r.TLS.Version < tls.VersionTLS13 || len(r.Header.Values("Origin")) != 1 {
			previewDenied(w)
			return
		}
		session := s.cookieValue(r.Header)
		hash, e := sessionHash(session)
		if e != nil {
			previewDenied(w)
			return
		}
		token, e := s.sessionCredential(r.Context(), session)
		if e != nil {
			previewDenied(w)
			return
		}
		u, e := s.currentUser(r.Context(), token)
		if e != nil {
			previewDenied(w)
			return
		}
		d, e := s.deploymentRecord(r.Context(), parts[3])
		if e != nil {
			previewDenied(w)
			return
		}
		value, digest, e := previewToken()
		if e != nil {
			previewDenied(w)
			return
		}
		var deadline time.Time
		e = s.deploymentFence(r.Context(), d, hash, u.ID, func(tx *sql.Tx, current *deploymentRecord, expires time.Time) error {
			if current.wire.State != "READY" {
				return errDeployment
			}
			deadline = time.Now().Add(60 * time.Second)
			if expires.Before(deadline) {
				deadline = expires
			}
			var uid int64
			if tx.QueryRowContext(r.Context(), "SELECT user_id FROM golf_sessions WHERE token_hash=$1", hash).Scan(&uid) != nil {
				return errUnauthenticated
			}
			if _, e = tx.ExecContext(r.Context(), "DELETE FROM golf_preview_credentials WHERE deployment_id=$1 AND expires_at<=clock_timestamp()", d.wire.Id); e != nil {
				return errStorageUnavailable
			}
			var count int
			if tx.QueryRowContext(r.Context(), "SELECT count(*) FROM golf_preview_credentials WHERE deployment_id=$1 AND expires_at>clock_timestamp()", d.wire.Id).Scan(&count) != nil || count >= 100 {
				return errDeployment
			}
			_, e = tx.ExecContext(r.Context(), "INSERT INTO golf_preview_credentials(token_hash,deployment_id,user_id,native_actor_id,parent_session_hash,kind,expires_at) VALUES($1,$2,$3,$4,$5,'launch',$6)", digest, d.wire.Id, uid, u.ID, hash, deadline)
			if e != nil {
				return errStorageUnavailable
			}
			return nil
		})
		if e != nil {
			previewDenied(w)
			return
		}
		action := s.previewOrigin(d.wire.Id) + "/__golf/auth"
		nonce, _, e := previewToken()
		if e != nil {
			previewDenied(w)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-"+nonce+"'; form-action "+s.previewOrigin(d.wire.Id)+"; base-uri 'none'; frame-ancestors 'none'")
		fmt.Fprintf(w, `<!doctype html><html><head><meta name="referrer" content="no-referrer"><title>Opening protected preview</title></head><body><form method="post" action="%s"><input type="hidden" name="grant" value="%s"><button>Open protected preview</button></form><script nonce="%s">document.forms[0].submit()</script></body></html>`, html.EscapeString(action), html.EscapeString(value), html.EscapeString(nonce))
	}
}
func (s *Server) redeemPreview(w http.ResponseWriter, r *http.Request, d *deploymentRecord) {
	if r.Method != "POST" || r.Header.Get("Origin") != s.config.PublicURL || len(r.Header.Values("Origin")) != 1 || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "" {
		previewDenied(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256)
	if r.ParseForm() != nil || len(r.PostForm) != 1 || len(r.PostForm["grant"]) != 1 {
		previewDenied(w)
		return
	}
	launch := r.PostForm.Get("grant")
	credential, e := s.previewCredential(r.Context(), launch, d.wire.Id, "launch")
	if e != nil {
		previewDenied(w)
		return
	}
	value, digest, e := previewToken()
	if e != nil {
		previewDenied(w)
		return
	}
	launchHash, _ := previewTokenHash(launch)
	var expiry time.Time
	e = s.deploymentFence(r.Context(), d, credential.parent, credential.native, func(tx *sql.Tx, current *deploymentRecord, deadline time.Time) error {
		if current.wire.State != "READY" {
			return errDeployment
		}
		if credential.expires.Before(time.Now()) {
			return errUnauthenticated
		}
		result, e := tx.ExecContext(r.Context(), "DELETE FROM golf_preview_credentials WHERE token_hash=$1 AND kind='launch' AND expires_at>clock_timestamp()", launchHash)
		if e != nil {
			return errStorageUnavailable
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			return errUnauthenticated
		}
		expiry = deadline
		_, e = tx.ExecContext(r.Context(), "INSERT INTO golf_preview_credentials(token_hash,deployment_id,user_id,native_actor_id,parent_session_hash,kind,expires_at) VALUES($1,$2,$3,$4,$5,'viewer',$6)", digest, d.wire.Id, credential.user, credential.native, credential.parent, expiry)
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e != nil || !credential.expires.After(time.Now()) {
		previewDenied(w)
		return
	}
	previewHeaders(w)
	http.SetCookie(w, &http.Cookie{Name: previewCookie, Value: value, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode, Expires: expiry})
	w.Header().Set("Location", "/")
	w.WriteHeader(http.StatusSeeOther)
}

package server

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

// One operator-registered Access client; registration and secret rotation are
// explicit. Golf browser sessions never leave the issuer origin.
type accessOIDC struct {
	ClientID                           string `json:"client_id"`
	ClientSecret                       string `json:"client_secret"`
	TeamDomain                         string `json:"team_domain"`
	PrivateKeyPEM                      string `json:"private_key_pem"`
	key                                *rsa.PrivateKey
	issuer, callback, kid, fingerprint string
}

func privateConfiguration(path string, value any) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 32<<10 {
		return errors.New("Private configuration must be a bounded owner-only file")
	}
	decoder := json.NewDecoder(io.LimitReader(f, 32<<10))
	decoder.DisallowUnknownFields()
	if e = decoder.Decode(value); e != nil {
		return e
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("Invalid private configuration")
	}
	return nil
}

func loadAccessOIDC(public string, insecure bool, path string) (*accessOIDC, error) {
	if path == "" {
		return nil, nil
	}
	bad := errors.New("Cloudflare Access requires valid private OIDC configuration and a secure Golf origin")
	v := &accessOIDC{}
	if privateConfiguration(path, v) != nil || insecure || !strings.HasPrefix(public, "https://") || !regexp.MustCompile(`^[a-z0-9-]+\.cloudflareaccess\.com$`).MatchString(v.TeamDomain) || !regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`).MatchString(v.ClientID) {
		return nil, bad
	}
	if _, e := previewTokenHash(v.ClientSecret); e != nil {
		return nil, bad
	}
	block, rest := pem.Decode([]byte(v.PrivateKeyPEM))
	if block == nil || block.Type != "PRIVATE KEY" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, bad
	}
	parsed, e := x509.ParsePKCS8PrivateKey(block.Bytes)
	if e != nil {
		return nil, bad
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok || key.N.BitLen() < 2048 || key.N.BitLen() > 4096 || key.Validate() != nil {
		return nil, bad
	}
	v.key = key
	v.PrivateKeyPEM = ""
	v.issuer = strings.TrimRight(public, "/") + "/auth/access"
	v.callback = "https://" + v.TeamDomain + "/cdn-cgi/access/callback"
	raw, e := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if e != nil {
		return nil, bad
	}
	sum := sha256.Sum256(raw)
	v.kid = hex.EncodeToString(sum[:])
	sum = sha256.Sum256([]byte(v.issuer + "\x00" + v.ClientID + "\x00" + v.ClientSecret + "\x00" + v.callback + "\x00" + v.kid))
	v.fingerprint = hex.EncodeToString(sum[:])
	return v, nil
}

func accessReviewerEmail(native int64) string {
	return "golf-" + strconv.FormatInt(native, 10) + "@reviewer.invalid"
}

func (v *accessOIDC) identityToken(native int64, nonce string, expiry time.Time) (string, error) {
	encode := func(value any) string {
		raw, _ := json.Marshal(value)
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	claims := map[string]any{"iss": v.issuer, "aud": v.ClientID, "sub": strconv.FormatInt(native, 10), "email": accessReviewerEmail(native), "email_verified": false, "iat": time.Now().Unix(), "exp": expiry.Unix()}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	message := encode(map[string]string{"alg": "RS256", "typ": "JWT", "kid": v.kid}) + "." + encode(claims)
	hash := sha256.Sum256([]byte(message))
	signature, e := rsa.SignPKCS1v15(rand.Reader, v.key, crypto.SHA256, hash[:])
	if e != nil {
		return "", e
	}
	return message + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (s *Server) AccessOIDCHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		v := s.accessOIDC
		if v == nil {
			http.NotFound(w, r)
			return
		}
		fail := func() { respond(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"}) }
		switch r.URL.Path {
		case "/auth/access/.well-known/openid-configuration":
			if r.Method != "GET" || r.URL.RawQuery != "" {
				fail()
				return
			}
			respond(w, 200, map[string]any{"issuer": v.issuer, "authorization_endpoint": v.issuer + "/authorize", "token_endpoint": v.issuer + "/token", "jwks_uri": v.issuer + "/jwks", "response_types_supported": []string{"code"}, "grant_types_supported": []string{"authorization_code"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}, "scopes_supported": []string{"openid", "email", "profile"}, "token_endpoint_auth_methods_supported": []string{"client_secret_basic", "client_secret_post"}, "code_challenge_methods_supported": []string{"S256"}})
		case "/auth/access/jwks":
			if r.Method != "GET" || r.URL.RawQuery != "" {
				fail()
				return
			}
			exponent := []byte{byte(v.key.E >> 16), byte(v.key.E >> 8), byte(v.key.E)}
			exponent = bytes.TrimLeft(exponent, "\x00")
			respond(w, 200, map[string]any{"keys": []any{map[string]string{"kty": "RSA", "use": "sig", "alg": "RS256", "kid": v.kid, "n": base64.RawURLEncoding.EncodeToString(v.key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(exponent)}}})
		case "/auth/access/authorize":
			if r.Method != "GET" || len(r.URL.RawQuery) > 4096 || r.Header.Get("Authorization") != "" {
				fail()
				return
			}
			q, e := url.ParseQuery(r.URL.RawQuery)
			if e != nil {
				fail()
				return
			}
			allowed := map[string]bool{"client_id": true, "redirect_uri": true, "response_type": true, "scope": true, "state": true, "nonce": true, "code_challenge": true, "code_challenge_method": true, "domain": true}
			for k, values := range q {
				if !allowed[k] || len(values) != 1 {
					fail()
					return
				}
			}
			scope := strings.Fields(q.Get("scope"))
			openid := false
			for _, s := range scope {
				if s == "openid" {
					openid = true
				} else if s != "email" && s != "profile" {
					fail()
					return
				}
			}
			if (q.Has("domain") && q.Get("domain") != v.ClientID) || q.Get("client_id") != v.ClientID || q.Get("redirect_uri") != v.callback || q.Get("response_type") != "code" || !openid || q.Get("state") == "" || len(q.Get("state")) > 3072 || len(q.Get("nonce")) > 512 || q.Get("code_challenge_method") != "S256" {
				fail()
				return
			}
			if _, e = previewTokenHash(q.Get("code_challenge")); e != nil {
				fail()
				return
			}
			session := s.cookieValue(r.Header)
			token, e := s.sessionCredential(r.Context(), session)
			if e != nil {
				http.Redirect(w, r, "/?access_login="+url.QueryEscape(q.Encode()), http.StatusSeeOther)
				return
			}
			user, e := s.currentUser(r.Context(), token)
			if e != nil {
				http.Redirect(w, r, "/?access_login="+url.QueryEscape(q.Encode()), http.StatusSeeOther)
				return
			}
			code, hash, e := previewToken()
			if e != nil {
				fail()
				return
			}
			e = s.workflowTransaction(r.Context(), session, user.ID, func(tx *sql.Tx, _ database.LockManagedSessionRow, parent []byte) error {
				if _, e := tx.ExecContext(r.Context(), "DELETE FROM golf_access_oidc_codes WHERE expires_at<=clock_timestamp()"); e != nil {
					return e
				}
				var count int
				if tx.QueryRowContext(r.Context(), "SELECT count(*) FROM golf_access_oidc_codes WHERE session_hash=$1", parent).Scan(&count) != nil || count >= 100 {
					return errUnauthenticated
				}
				_, e := tx.ExecContext(r.Context(), "INSERT INTO golf_access_oidc_codes(token_hash,session_hash,native_actor_id,configuration_hash,challenge,nonce,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '60 seconds')", hash, parent, user.ID, v.fingerprint, q.Get("code_challenge"), q.Get("nonce"))
				return e
			})
			if e != nil {
				respond(w, 401, map[string]string{"error": "login_required"})
				return
			}
			http.Redirect(w, r, v.callback+"?"+url.Values{"code": {code}, "state": {q.Get("state")}}.Encode(), http.StatusFound)
		case "/auth/access/token":
			if r.Method != "POST" || r.URL.RawQuery != "" || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") || r.Header.Get("Origin") != "" {
				fail()
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 8192)
			if r.ParseForm() != nil {
				fail()
				return
			}
			allowed := map[string]bool{"grant_type": true, "code": true, "redirect_uri": true, "code_verifier": true, "client_id": true, "client_secret": true}
			for k, values := range r.PostForm {
				if !allowed[k] || len(values) != 1 {
					fail()
					return
				}
			}
			client, secret, basic := r.BasicAuth()
			if basic {
				if r.PostForm.Has("client_secret") || r.PostForm.Has("client_id") {
					fail()
					return
				}
			} else {
				if r.Header.Get("Authorization") != "" {
					fail()
					return
				}
				client = r.PostForm.Get("client_id")
				secret = r.PostForm.Get("client_secret")
			}
			presented := sha256.Sum256([]byte(secret))
			expected := sha256.Sum256([]byte(v.ClientSecret))
			if client != v.ClientID || subtle.ConstantTimeCompare(presented[:], expected[:]) != 1 {
				respond(w, 401, map[string]string{"error": "invalid_client"})
				return
			}
			if r.PostForm.Get("grant_type") != "authorization_code" || r.PostForm.Get("redirect_uri") != v.callback || !regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`).MatchString(r.PostForm.Get("code_verifier")) {
				fail()
				return
			}
			hash, e := previewTokenHash(r.PostForm.Get("code"))
			if e != nil {
				fail()
				return
			}
			challenge := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
			var parent []byte
			var native int64
			var nonce string
			e = s.db.QueryRowContext(r.Context(), "DELETE FROM golf_access_oidc_codes WHERE token_hash=$1 AND configuration_hash=$2 AND challenge=$3 AND expires_at>clock_timestamp() RETURNING session_hash,native_actor_id,nonce", hash, v.fingerprint, base64.RawURLEncoding.EncodeToString(challenge[:])).Scan(&parent, &native, &nonce)
			if e != nil {
				respond(w, 400, map[string]string{"error": "invalid_grant"})
				return
			}
			_, expiry, _, e := s.deploymentSession(r.Context(), parent, native)
			if e != nil {
				respond(w, 400, map[string]string{"error": "invalid_grant"})
				return
			}
			deadline := time.Now().Add(60 * time.Second)
			if expiry.Before(deadline) {
				deadline = expiry
			}
			id, e := v.identityToken(native, nonce, deadline)
			if e != nil || !deadline.After(time.Now()) {
				fail()
				return
			}
			// Access's ID token is not a Golf API credential or a preview grant.
			access, _, e := previewToken()
			if e != nil {
				fail()
				return
			}
			respond(w, 200, map[string]any{"id_token": id, "access_token": access, "token_type": "Bearer", "expires_in": int(time.Until(deadline).Seconds())})
		default:
			http.NotFound(w, r)
		}
	})
}

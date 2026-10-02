package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"golang.org/x/oauth2"
)

const oauthCookieName = "golf_oauth_binding"
const oauthCallbackPath = "/auth/gitea/callback"
const oauthAttemptLifetime = 10 * time.Minute
const maxOAuthResponse = 16 << 10

var oauthScopes = []string{"write:user", "write:repository", "write:issue", "read:organization"}

// Kind is stored separately on the session row: PAT bytes are never interpreted
// as an OAuth envelope. Verified is false only after a rotated token could not
// yet be checked against the session's immutable upstream user ID.
type oauthEnvelope struct {
	Version      int       `json:"version"`
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	Expiry       time.Time `json:"expiry"`
	Verified     bool      `json:"verified"`
}

func validateOAuthConfig(config Config) error {
	if config.GiteaPublicURL == "" && config.GiteaOAuthClientID == "" && config.GiteaOAuthClientSecret == "" {
		return nil
	}
	if config.GiteaPublicURL == "" || strings.TrimSpace(config.GiteaOAuthClientID) == "" || strings.TrimSpace(config.GiteaOAuthClientSecret) == "" {
		return errors.New("GITEA_PUBLIC_URL, GITEA_OAUTH_CLIENT_ID and GITEA_OAUTH_CLIENT_SECRET must all be configured for OAuth")
	}
	u, err := url.Parse(config.GiteaPublicURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return errors.New("GITEA_PUBLIC_URL must be an HTTP(S) URL without credentials or query")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "https" && !(config.AllowInsecureCookies && (u.Hostname() == "localhost" || ip != nil && ip.IsLoopback())) {
		return errors.New("GITEA_PUBLIC_URL requires HTTPS outside explicit loopback development")
	}
	return nil
}
func (s *Server) oauthConfig() *oauth2.Config {
	return &oauth2.Config{ClientID: s.config.GiteaOAuthClientID, ClientSecret: s.config.GiteaOAuthClientSecret,
		RedirectURL: s.config.PublicURL + oauthCallbackPath, Scopes: append([]string(nil), oauthScopes...),
		Endpoint: oauth2.Endpoint{AuthURL: s.config.GiteaPublicURL + "/login/oauth/authorize", TokenURL: s.config.GiteaURL + "/login/oauth/access_token", AuthStyle: oauth2.AuthStyleInParams}}
}
func (s *Server) oauthAvailable(ctx context.Context) bool {
	if s.config.GiteaOAuthClientID == "" {
		return false
	}
	_, ready := s.dependencyChecks(ctx)
	return ready
}
func (s *Server) GetAuthenticationOptions(ctx context.Context, _ *connect.Request[golfv1.GetAuthenticationOptionsRequest]) (*connect.Response[golfv1.GetAuthenticationOptionsResponse], error) {
	enabled := s.oauthAvailable(ctx)
	return connect.NewResponse(&golfv1.GetAuthenticationOptionsResponse{GiteaOauthEnabled: enabled, ProviderLabel: "Gitea", LocalPasswordEnabled: s.db != nil, Scopes: append([]string(nil), oauthScopes...)}), nil
}
func (s *Server) oauthCookie(value string, expires time.Time, maxAge int) *http.Cookie {
	return &http.Cookie{Name: oauthCookieName, Value: value, Path: oauthCallbackPath, HttpOnly: true, Secure: !s.config.AllowInsecureCookies, SameSite: http.SameSiteLaxMode, Expires: expires, MaxAge: maxAge}
}
func randomOpaque() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func (s *Server) BeginGiteaOAuth(ctx context.Context, _ *connect.Request[golfv1.BeginGiteaOAuthRequest]) (*connect.Response[golfv1.BeginGiteaOAuthResponse], error) {
	if !s.oauthAvailable(ctx) {
		return nil, rpcError(errOAuthDisabled)
	}
	state, binding, verifier := randomOpaque(), randomOpaque(), oauth2.GenerateVerifier()
	stateHash, _ := sessionHash(state)
	bindingHash, _ := sessionHash(binding)
	expires := time.Now().UTC().Add(oauthAttemptLifetime)
	queries := database.New(s.db)
	if err := queries.DeleteExpiredOAuthAttempts(ctx); err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	encrypted, keyID, err := s.keyring.seal(oauthAttemptDomain, verifier, stateHash)
	if err != nil {
		return nil, rpcError(err)
	}
	if err := queries.CreateKeyedOAuthAttempt(ctx, database.CreateKeyedOAuthAttemptParams{StateHash: stateHash, BindingHash: bindingHash, EncryptedVerifier: encrypted, ExpiresAt: expires, CredentialKeyID: keyID}); err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	response := connect.NewResponse(&golfv1.BeginGiteaOAuthResponse{AuthorizationUrl: s.oauthConfig().AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))})
	response.Header().Add("Set-Cookie", s.oauthCookie(binding, expires, int(oauthAttemptLifetime.Seconds())).String())
	return response, nil
}

// Limit the entire provider response before oauth2 parses either a success or
// an error. This client never follows redirects or probes alternate auth styles.
type oauthTransport struct{ base http.RoundTripper }

func (t oauthTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, errForgeUnavailable
	}
	defer response.Body.Close()
	if response.ContentLength > maxOAuthResponse {
		return nil, errInvalidForgeResponse
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxOAuthResponse+1))
	if err != nil || len(body) > maxOAuthResponse {
		return nil, errInvalidForgeResponse
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	return response, nil
}
func (s *Server) oauthContext(ctx context.Context) context.Context {
	transport := s.client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client := &http.Client{Timeout: 10 * time.Second, Transport: oauthTransport{transport}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return context.WithValue(ctx, oauth2.HTTPClient, client)
}
func envelopeFor(token *oauth2.Token) (oauthEnvelope, error) {
	if token == nil || !strings.EqualFold(token.TokenType, "Bearer") || token.AccessToken == "" || token.RefreshToken == "" || len(token.AccessToken) > maxOAuthResponse || len(token.RefreshToken) > maxOAuthResponse || strings.ContainsAny(token.AccessToken, "\r\n\t ") || token.Expiry.IsZero() || !token.Expiry.After(time.Now()) {
		return oauthEnvelope{}, errInvalidForgeResponse
	}
	return oauthEnvelope{Version: 1, AccessToken: token.AccessToken, RefreshToken: token.RefreshToken, Expiry: token.Expiry.UTC()}, nil
}
func decodeOAuth(payload string) (oauthEnvelope, error) {
	var envelope oauthEnvelope
	if err := json.Unmarshal([]byte(payload), &envelope); err != nil || envelope.Version != 1 || envelope.AccessToken == "" || envelope.RefreshToken == "" || envelope.Expiry.IsZero() {
		return envelope, errCredentialUnavailable
	}
	return envelope, nil
}
func encodeOAuth(envelope oauthEnvelope) string {
	data, _ := json.Marshal(envelope)
	return string(data)
}
func (s *Server) oauthCallback(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, s.oauthCookie("", time.Unix(1, 0), -1))
	fail := func() { http.Redirect(w, r, "/?auth_error=oauth_failed", http.StatusSeeOther) }
	if s.config.GiteaOAuthClientID == "" || s.db == nil || len(r.URL.RawQuery) > maxOAuthResponse {
		fail()
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query["state"]) != 1 {
		fail()
		return
	}
	stateHash, err := sessionHash(query.Get("state"))
	if err != nil {
		fail()
		return
	}
	binding, err := r.Cookie(oauthCookieName)
	if err != nil {
		fail()
		return
	}
	bindingHash, err := sessionHash(binding.Value)
	if err != nil {
		fail()
		return
	}
	verifier, err := s.consumeOAuthVerifier(r.Context(), stateHash, bindingHash)
	if err != nil {
		fail()
		return
	}
	// Even denied or malformed callbacks consume an otherwise valid attempt.
	if query.Has("error") || len(query["code"]) != 1 || query.Get("code") == "" {
		fail()
		return
	}
	token, err := s.oauthConfig().Exchange(s.oauthContext(r.Context()), query.Get("code"), oauth2.VerifierOption(verifier))
	if err != nil {
		fail()
		return
	}
	envelope, err := envelopeFor(token)
	if err != nil {
		fail()
		return
	}
	user, err := s.currentUser(r.Context(), forgeCredential{Kind: "oauth", Token: envelope.AccessToken})
	if err != nil {
		fail()
		return
	}
	envelope.Verified = true
	session, err := s.createSession(r.Context(), user, "oauth", encodeOAuth(envelope), s.cookieValue(r.Header))
	if err != nil {
		fail()
		return
	}
	http.SetCookie(w, s.sessionCookie(session.Value, session.Expires, int(sessionLifetime.Seconds())))
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func oauthExpired(envelope oauthEnvelope) bool {
	return !envelope.Expiry.After(time.Now().Add(5 * time.Second))
}

func (s *Server) oauthCredential(ctx context.Context, hash []byte, payload string) (forgeCredential, error) {
	if s.config.GiteaOAuthClientID == "" {
		return forgeCredential{}, errUnauthenticated
	}
	envelope, err := decodeOAuth(payload)
	if err != nil {
		return forgeCredential{}, err
	}
	if !oauthExpired(envelope) && envelope.Verified {
		return forgeCredential{Kind: "oauth", Token: envelope.AccessToken}, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return forgeCredential{}, errStorageUnavailable
	}
	defer tx.Rollback()
	queries := database.New(s.db).WithTx(tx)
	row, err := queries.LockSessionCredential(ctx, database.LockSessionCredentialParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return forgeCredential{}, errUnauthenticated
	}
	if err != nil {
		return forgeCredential{}, errStorageUnavailable
	}
	if !row.ExpiresAt.After(time.Now()) {
		return forgeCredential{}, errUnauthenticated
	}
	if row.CredentialKind != "oauth" {
		return forgeCredential{}, errCredentialUnavailable
	}
	payload, err = s.keyring.open(row.CredentialKeyID, sessionDomain, row.EncryptedToken, hash)
	if err != nil {
		return forgeCredential{}, errCredentialUnavailable
	}
	envelope, err = decodeOAuth(payload)
	if err != nil {
		return forgeCredential{}, err
	}
	deny := func() (forgeCredential, error) {
		if err := queries.DeleteSession(ctx, hash); err != nil {
			return forgeCredential{}, errStorageUnavailable
		}
		if err := tx.Commit(); err != nil {
			return forgeCredential{}, errStorageUnavailable
		}
		return forgeCredential{}, errUnauthenticated
	}
	if oauthExpired(envelope) {
		// Construct a fresh TokenSource only while holding the database lock;
		// local TokenSource caching cannot coordinate refresh across replicas.
		token, err := s.oauthConfig().TokenSource(s.oauthContext(ctx), &oauth2.Token{RefreshToken: envelope.RefreshToken}).Token()
		if err != nil {
			classified := oauthRefreshError(err)
			if errors.Is(classified, errUnauthenticated) {
				return deny()
			}
			return forgeCredential{}, classified
		}
		envelope, err = envelopeFor(token)
		if err != nil {
			return forgeCredential{}, errInvalidForgeResponse
		}
	}
	if !envelope.Verified {
		user, err := s.currentUser(ctx, forgeCredential{Kind: "oauth", Token: envelope.AccessToken})
		var upstream forgeError
		if err == nil && user.ID != row.ForgeUserID || errors.As(err, &upstream) && (upstream.status == 401 || upstream.status == 403) {
			return deny()
		}
		if err == nil {
			envelope.Verified = true
		}
		// If user lookup is temporarily unavailable, preserve the newly rotated
		// refresh token, but do not allow it to authorize a request yet.
		encrypted, keyID, sealErr := s.keyring.seal(sessionDomain, encodeOAuth(envelope), hash)
		if sealErr != nil {
			return forgeCredential{}, sealErr
		}
		if saveErr := queries.UpdateKeyedSessionCredential(ctx, database.UpdateKeyedSessionCredentialParams{TokenHash: hash, EncryptedToken: encrypted, CredentialKeyID: keyID}); saveErr != nil {
			return forgeCredential{}, errStorageUnavailable
		}
		if commitErr := tx.Commit(); commitErr != nil {
			return forgeCredential{}, errStorageUnavailable
		}
		if err != nil {
			return forgeCredential{}, err
		}
	} else if err := tx.Commit(); err != nil {
		return forgeCredential{}, errStorageUnavailable
	}
	return forgeCredential{Kind: "oauth", Token: envelope.AccessToken}, nil
}

// Gitea 1.27.3 refresh errors distinguish the application from the user's
// grant. An invalid client can be a recoverable operator secret/config issue
// (and Gitea even uses it for app lookup database errors), so preserve the
// encrypted grant. Its unauthorized_client code also covers expired/reused
// refresh tokens. Never treat a 5xx/429 error body as proof of revocation.
// https://github.com/go-gitea/gitea/blob/v1.27.3/routers/web/auth/oauth2_provider.go#L536-L598
func oauthRefreshError(err error) error {
	var retrieve *oauth2.RetrieveError
	if !errors.As(err, &retrieve) || retrieve.Response == nil || (retrieve.Response.StatusCode != http.StatusBadRequest && retrieve.Response.StatusCode != http.StatusUnauthorized) {
		return errForgeUnavailable
	}
	switch retrieve.ErrorCode {
	case "invalid_grant", "invalid_token", "unauthorized_client":
		return errUnauthenticated
	case "invalid_client":
		return errOAuthClientRejected
	default:
		return errForgeUnavailable
	}
}

// Decrypt before committing consumption. Unknown keys or failed authentication
// preserve the verifier for operator recovery; a valid attempt remains one-use.
func (s *Server) consumeOAuthVerifier(ctx context.Context, stateHash, bindingHash []byte) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", errStorageUnavailable
	}
	defer tx.Rollback()
	queries := database.New(s.db).WithTx(tx)
	row, err := queries.LockOAuthAttempt(ctx, database.LockOAuthAttemptParams{StateHash: stateHash, BindingHash: bindingHash})
	if errors.Is(err, sql.ErrNoRows) {
		return "", errUnauthenticated
	}
	if err != nil {
		return "", errStorageUnavailable
	}
	if !row.ExpiresAt.After(time.Now()) {
		return "", errUnauthenticated
	}
	verifier, err := s.keyring.open(row.CredentialKeyID, oauthAttemptDomain, row.EncryptedVerifier, stateHash)
	if err != nil {
		return "", err
	}
	// Recheck against database time after waiting for the row lock. Do not
	// rely on the application and PostgreSQL clocks having zero skew.
	count, err := queries.DeleteOAuthAttempt(ctx, database.DeleteOAuthAttemptParams{StateHash: stateHash, BindingHash: bindingHash})
	if err != nil {
		return "", errStorageUnavailable
	}
	if count != 1 {
		return "", errUnauthenticated
	}
	if !row.ExpiresAt.After(time.Now()) {
		return "", errUnauthenticated
	}
	if err := tx.Commit(); err != nil {
		return "", errStorageUnavailable
	}
	return verifier, nil
}

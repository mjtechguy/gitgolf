package server

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type Config struct {
	PublicURL, GiteaURL, EncryptionKey                         string
	GiteaPublicURL, GiteaOAuthClientID, GiteaOAuthClientSecret string
	AllowInsecureCookies                                       bool
	WebDir                                                     string
}
type Server struct {
	config  Config
	db      *sql.DB
	cipher  cipher.AEAD
	client  *http.Client
	handler http.Handler
}

func New(config Config, db *sql.DB) (*Server, error) {
	public, err := url.Parse(config.PublicURL)
	if err != nil || public.Host == "" || public.User != nil || public.RawQuery != "" || public.Fragment != "" || (public.Path != "" && public.Path != "/") || (public.Scheme != "https" && public.Scheme != "http") {
		return nil, errors.New("GOLF_PUBLIC_URL must be an HTTP(S) origin without credentials, path or query")
	}
	if config.AllowInsecureCookies {
		host := public.Hostname()
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return nil, errors.New("insecure cookies are allowed only for a loopback public URL")
		}
	} else if public.Scheme != "https" {
		return nil, errors.New("HTTP loopback development requires GOLF_ALLOW_INSECURE_COOKIES=true")
	}
	forge, err := url.Parse(config.GiteaURL)
	if err != nil || forge.Host == "" || forge.User != nil || forge.RawQuery != "" || forge.Fragment != "" || (forge.Scheme != "http" && forge.Scheme != "https") {
		return nil, errors.New("GITEA_URL must be an HTTP(S) URL without credentials or query")
	}
	if err := validateOAuthConfig(config); err != nil {
		return nil, err
	}
	config.GiteaPublicURL = strings.TrimRight(config.GiteaPublicURL, "/")
	key, err := base64.StdEncoding.DecodeString(config.EncryptionKey)
	if err != nil || len(key) != 32 {
		return nil, errors.New("GOLF_ENCRYPTION_KEY must be base64 encoding of exactly 32 random bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	config.PublicURL = public.Scheme + "://" + public.Host
	config.GiteaURL = strings.TrimRight(config.GiteaURL, "/")
	s := &Server{config: config, db: db, cipher: aead, client: &http.Client{Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}

	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(15 * time.Second))
	r.Use(s.security)
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]string{"status": "ok"}) })
	r.Get("/readyz", s.readiness)
	r.Get("/auth/gitea/callback", s.oauthCallback)
	rpc := s.rpcBoundary(http.StripPrefix("/rpc", s.rpcHandler()))
	r.Handle("/rpc", rpc)
	r.Handle("/rpc/*", rpc)
	// Removed application REST paths are never served as SPA documents.
	r.Handle("/api", http.NotFoundHandler())
	r.Handle("/api/*", http.NotFoundHandler())
	if config.WebDir != "" {
		if root, err := os.OpenRoot(config.WebDir); err == nil {
			files := root.FS()
			fileServer := http.FileServerFS(files)
			r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "..") {
					http.NotFound(w, r)
					return
				}
				name := strings.TrimPrefix(r.URL.Path, "/")
				if name == "" {
					name = "index.html"
				}
				if f, err := files.Open(name); err == nil {
					info, statErr := f.Stat()
					f.Close()
					if statErr == nil && !info.IsDir() {
						fileServer.ServeHTTP(w, r)
						return
					}
				}
				if strings.Contains(r.Header.Get("Accept"), "text/html") {
					http.ServeFileFS(w, r, files, "index.html")
					return
				}
				http.NotFound(w, r)
			})
		}
	}
	r.NotFound(http.NotFound)
	s.handler = r
	return s, nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }
func (s *Server) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if r.URL.Path == "/rpc" || strings.HasPrefix(r.URL.Path, "/rpc/") || strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/auth/") {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "no-referrer")
		}
		next.ServeHTTP(w, r)
	})
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func (s *Server) dependencyChecks(ctx context.Context) (map[string]string, bool) {
	checks := map[string]string{"database": "ready", "gitea": "ready"}
	ready := true
	if s.db == nil || s.db.PingContext(ctx) != nil {
		checks["database"] = "unavailable"
		ready = false
	}
	var version struct {
		Version string `json:"version"`
	}
	if _, err := s.forge(ctx, "GET", "/version", forgeCredential{}, nil, &version); err != nil || version.Version == "" {
		checks["gitea"] = "unavailable"
		ready = false
	} else if strings.TrimPrefix(version.Version, "v") != "1.27.3" {
		checks["gitea"] = "unsupported_version"
		ready = false
	}
	return checks, ready
}
func (s *Server) readiness(w http.ResponseWriter, r *http.Request) {
	checks, ready := s.dependencyChecks(r.Context())
	status := 200
	if !ready {
		status = 503
	}
	respond(w, status, map[string]any{"checks": checks})
}

package server

import (
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type Config struct {
	PublicURL            string
	GiteaURL             string
	EncryptionKey        string
	AllowInsecureCookies bool
	WebDir               string
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
	r.Route("/api", func(r chi.Router) {
		r.Get("/capabilities", s.capabilities)
		r.Post("/session", s.login)
		r.Get("/session", s.session)
		r.Delete("/session", s.logout)
		r.Get("/repositories", s.repositories)
		r.Post("/repositories", s.createRepository)
		r.NotFound(func(w http.ResponseWriter, r *http.Request) { problem(w, 404, "not_found", "API route not found.") })
	})
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
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		problem(w, 404, "not_found", "Route not found. Build the web application or use the API.")
	})
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
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			if r.Header.Get("Origin") != s.config.PublicURL || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				problem(w, 403, "origin_rejected", "Request origin must match the configured Golf public URL.")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func readJSON(w http.ResponseWriter, r *http.Request, output any) bool {
	typeName, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || typeName != "application/json" {
		problem(w, 415, "content_type", "Use application/json.")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(output); err != nil {
		problem(w, 400, "invalid_json", "Request body is invalid or exceeds 16 KiB.")
		return false
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		problem(w, 400, "invalid_json", "Request must contain one JSON value.")
		return false
	}
	return true
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func problem(w http.ResponseWriter, status int, code, message string) {
	respond(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func (s *Server) forgeProblem(w http.ResponseWriter, err error) {
	var upstream forgeError
	if errors.As(err, &upstream) {
		switch upstream.status {
		case 401:
			problem(w, 401, "forge_unauthorized", "Gitea rejected this credential. Sign in with a current token.")
			return
		case 403:
			problem(w, 403, "forge_forbidden", "Gitea denied this operation. Check token scopes and repository access.")
			return
		case 409, 422:
			problem(w, 409, "forge_conflict", "Gitea could not create this repository. Check its name and your permissions.")
			return
		case 429:
			problem(w, 429, "forge_rate_limited", "Gitea rate limit reached. Retry later.")
			return
		}
	}
	problem(w, 502, "forge_unavailable", "Gitea is unavailable or returned an unexpected response.")
}

func (s *Server) readiness(w http.ResponseWriter, r *http.Request) {
	status := 200
	checks := map[string]string{"database": "ready", "gitea": "ready"}
	if s.db == nil || s.db.PingContext(r.Context()) != nil {
		checks["database"] = "unavailable"
		status = 503
	}
	var version struct {
		Version string `json:"version"`
	}
	if _, err := s.forge(r.Context(), "GET", "/version", "", nil, &version); err != nil || version.Version == "" {
		checks["gitea"] = "unavailable"
		status = 503
	}
	respond(w, status, map[string]any{"checks": checks})
}

func (s *Server) capabilities(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, map[string]any{"capabilities": []map[string]string{
		{"id": "repositories", "label": "Gitea repositories", "state": "configured", "reason": "Repository listing and creation use your Gitea permissions. Check readiness for live dependency health."},
		{"id": "cloudflare", "label": "Cloudflare integration", "state": "disabled", "reason": "Planned; not implemented in this initial slice."},
		{"id": "pipelines", "label": "Pipeline execution", "state": "disabled", "reason": "Planned; no CI runner or pipeline execution is implemented."},
		{"id": "agents", "label": "Coding agents", "state": "disabled", "reason": "Optional; not implemented in this initial slice."},
		{"id": "deployments", "label": "Protected previews and deployment", "state": "disabled", "reason": "Planned; not implemented in this initial slice."},
	}})
}

func (s *Server) repositories(w http.ResponseWriter, r *http.Request) {
	token, ok := s.token(w, r)
	if !ok {
		return
	}
	page, limit := 1, 20
	for _, entry := range []struct {
		name   string
		target *int
		max    int
	}{{"page", &page, 10000}, {"limit", &limit, 100}} {
		if raw := r.URL.Query().Get(entry.name); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || n > entry.max {
				problem(w, 400, "invalid_pagination", "Page must be 1–10000 and limit must be 1–100.")
				return
			}
			*entry.target = n
		}
	}
	repos := []Repository{}
	headers, err := s.forge(r.Context(), "GET", fmt.Sprintf("/user/repos?page=%d&limit=%d", page, limit), token, nil, &repos)
	if err != nil {
		s.forgeProblem(w, err)
		return
	}
	if repos == nil {
		repos = []Repository{}
	}
	result := map[string]any{"repositories": repos}
	if strings.Contains(headers.Get("Link"), `rel="next"`) && page < 10000 {
		result["next_page"] = page + 1
	}
	respond(w, 200, result)
}

var repositoryName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

func (s *Server) createRepository(w http.ResponseWriter, r *http.Request) {
	token, ok := s.token(w, r)
	if !ok {
		return
	}
	var input struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Private     *bool  `json:"private"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if !repositoryName.MatchString(input.Name) || len(input.Description) > 2000 || input.Private == nil {
		problem(w, 400, "invalid_repository", "Provide a 1–100 character repository name, description up to 2000 bytes, and explicit private boolean.")
		return
	}
	var repo Repository
	_, err := s.forge(r.Context(), "POST", "/user/repos", token, input, &repo)
	if err != nil {
		s.forgeProblem(w, err)
		return
	}
	if repo.ID <= 0 {
		problem(w, 502, "invalid_forge_response", "Gitea did not return the created repository. Check Gitea before retrying.")
		return
	}
	respond(w, 201, map[string]any{"repository": repo})
}

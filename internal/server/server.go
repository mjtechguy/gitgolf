package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/mjtechguy/golf-git/internal/objectstore"
	"github.com/mjtechguy/golf-git/internal/telemetry"
)

var immutableWebAsset = regexp.MustCompile(`^assets/[^/]+-[A-Za-z0-9_-]{8}\.(js|css|woff2?)$`)

type Config struct {
	WebhookEgressPolicyJSON                                    string
	AgentImage, ReviewImage, ReviewPublisherToken              string
	ClaudeBinary, OpenCodeBinary, CodexBinary                  string
	PushCIEnabled                                              bool
	ObjectStoreConfig                                          objectstore.Config
	DatabaseEndpoint, DatabaseTLSMode, NativeDatabaseEndpoint  string
	PublicURL, GiteaURL, EncryptionKey                         string
	EncryptionKeysJSON, EncryptionActiveKeyID                  string
	GiteaPublicURL, GiteaOAuthClientID, GiteaOAuthClientSecret string
	AllowInsecureCookies                                       bool
	WebDir                                                     string
	RunnerKeysJSON, RunnerImagesJSON                           string
	ActionsEngineCatalog, ActionsEngineBinary                  string
	RepositoryEventConnectionsJSON                             string
	Telemetry                                                  *telemetry.Runtime
}
type Server struct {
	preview                       *previewConfiguration
	previewBound                  atomic.Bool
	previewRequests               chan struct{}
	managedGit                    managedGitConfiguration
	activity                      activityLimits
	codexMu                       sync.Mutex
	codexRuntimes                 map[string]*codexRuntime
	pushCoordinatorSeen           atomic.Int64
	config                        Config
	db                            *sql.DB
	keyring                       *Keyring
	client                        *http.Client
	handler                       http.Handler
	runnerKeys                    map[string][32]byte
	runnerImages                  map[string]string
	repositoryEventConnections    map[string]repositoryEventConnection
	defaultObjectStore            *objectstore.Store
	defaultObjectStoreFingerprint string
}

func New(config Config, db *sql.DB) (*Server, error) {
	preview, previewErr := previewConfig(config.PublicURL, config.AllowInsecureCookies, os.Getenv)
	if previewErr != nil {
		return nil, previewErr
	}
	gitConfig, gitErr := managedGitConfig(os.Getenv)
	if gitErr != nil {
		return nil, gitErr
	}
	if err := ValidateEmailEgressPolicy(os.Getenv("GOLF_EMAIL_EGRESS_POLICY")); err != nil {
		return nil, errors.New("Email operator egress policy is invalid")
	}
	if _, err := parseWebhookEgress(config.WebhookEgressPolicyJSON); err != nil {
		return nil, errors.New("Webhook operator egress policy is invalid")
	}
	if config.ReviewImage != "" && !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(config.ReviewImage) {
		return nil, errors.New("GOLF_REVIEW_IMAGE must identify an exact local image")
	}
	if config.AgentImage != "" && !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(config.AgentImage) {
		return nil, errors.New("GOLF_AGENT_IMAGE must identify an exact local image")
	}
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
	keyring, err := ParseKeyring(config.EncryptionKey, config.EncryptionKeysJSON, config.EncryptionActiveKeyID)
	if err != nil {
		return nil, err
	}
	if db != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if err := checkRuntimeKeys(ctx, db, keyring); err != nil {
			return nil, err
		}
	}
	config.PublicURL = public.Scheme + "://" + public.Host
	config.GiteaURL = strings.TrimRight(config.GiteaURL, "/")
	s := &Server{previewRequests: make(chan struct{}, 8), preview: preview, managedGit: gitConfig, config: config, db: db, keyring: keyring, client: &http.Client{Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	if config.Telemetry != nil {
		s.client.Transport = config.Telemetry.HTTPTransport(http.DefaultTransport)
	}

	if err := s.configureObjectStore(context.Background()); err != nil {
		return nil, err
	}
	if err := s.configureRepositoryEvents(); err != nil {
		return nil, err
	}
	if err := s.configureRunners(); err != nil {
		return nil, err
	}
	if err := s.ensureInstanceRunnerLimits(context.Background()); err != nil {
		return nil, err
	}
	if err := s.validateActionsEngineConfig(); err != nil {
		return nil, err
	}
	if config.PushCIEnabled && (len(s.repositoryEventConnections) == 0 || len(s.runnerImages) == 0 || len(s.runnerKeys) == 0) {
		return nil, errors.New("push CI requires repository event connections and enrolled runner images")
	}
	r := chi.NewRouter()
	r.Use(middleware.Timeout(15 * time.Second))
	r.Use(s.security)
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]string{"status": "ok"}) })
	r.Get("/readyz", s.readiness)
	r.Get("/auth/gitea/callback", s.oauthCallback)
	r.Handle("/notifications/unsubscribe", s.EmailUnsubscribeHandler())
	r.Post("/hooks/gitea/{connectionID}", s.repositoryEventWebhook)
	r.Post("/internal/ci/poll", s.runnerPoll)
	r.Post("/internal/ci/recover", s.runnerRecover)
	r.Post("/internal/ci/attempt/{id}/heartbeat", s.runnerAttempt)
	r.Post("/internal/ci/attempt/{id}/logs", s.runnerAttempt)
	r.Post("/internal/ci/attempt/{id}/progress", s.runnerAttempt)
	r.Post("/internal/ci/attempt/{id}/graph", s.runnerAttempt)
	r.Post("/internal/ci/attempt/{id}/finish", s.runnerAttempt)
	r.Post("/internal/ci/attempt/{id}/artifact", s.runnerAttempt)
	r.Get("/internal/ci/attempt/{id}/source", s.runnerAttempt)
	r.Get("/internal/ci/attempt/{id}/git/info/refs", s.runnerAttempt)
	r.Post("/internal/ci/attempt/{id}/git/git-upload-pack", s.runnerAttempt)
	r.Post("/internal/ci/attempt/{id}/job-git-credential", s.runnerAttempt)
	r.Get("/{owner}/{repo}/info/refs", s.jobGitTransport)
	r.Post("/{owner}/{repo}/git-upload-pack", s.jobGitTransport)
	rpc := s.rpcBoundary(http.StripPrefix("/rpc", s.rpcHandler()))
	r.Handle("/rpc", rpc)
	r.Handle("/rpc/*", rpc)
	r.Get("/api/workflow-runs/{id}/artifact", s.WorkflowArtifactDownloadHandler())
	r.Get("/api/repositories/{owner}/{name}/{repositoryId}/releases/{releaseId}/assets/{assetId}/download", s.RepositoryReleaseAssetDownloadHandler())
	// Removed application REST paths are never served as SPA documents.
	r.Handle("/api", http.NotFoundHandler())
	r.Handle("/api/*", http.NotFoundHandler())
	webEnabled := false
	if config.WebDir != "" {
		if root, err := os.OpenRoot(config.WebDir); err == nil {
			webEnabled = true
			files := root.FS()
			fileServer := http.FileServerFS(files)
			r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Cache-Control", "no-cache")
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
						if immutableWebAsset.MatchString(name) {
							w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
						}
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
	ordinary := s.observeHTTP(r, webEnabled)
	// The smart-HTTP exchange has its own bounded context. RPC's 15s middleware
	// must not truncate it; security and request observation still apply.
	git := s.observeHTTP(s.security(http.HandlerFunc(s.managedGitTransport)), false)
	s.handler = http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if managedGitRouteNamespace(request.URL.Path) {
			git.ServeHTTP(w, request)
			return
		}
		ordinary.ServeHTTP(w, request)
	})
	return s, nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/deployments/") {
		s.DeploymentOpenHandler().ServeHTTP(w, r)
		return
	}
	s.handler.ServeHTTP(w, r)
}
func (s *Server) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if r.URL.Path == "/rpc" || strings.HasPrefix(r.URL.Path, "/rpc/") || strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/auth/") || strings.HasPrefix(r.URL.Path, "/internal/ci/") || strings.HasPrefix(r.URL.Path, "/hooks/") {
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

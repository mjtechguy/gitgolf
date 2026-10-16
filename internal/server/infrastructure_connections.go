package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/cloudflare"
	"github.com/mjtechguy/golf-git/internal/objectstore"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

func infrastructureRPCError(err error) error {
	var connectError *connect.Error
	if errors.As(err, &connectError) {
		return connectError
	}
	return rpcError(err)
}

var errInfrastructureConflict = errors.New("Infrastructure connection changed; refresh before trying again.")

type infrastructureConnectionConfig struct {
	Label, Kind, DatabaseRole, Backend, Endpoint, Region, Bucket, TLSMode, DatabaseName, DatabaseUser, Prefix string
	PathStyle, AllowInsecure                                                                                  bool
	CloudflareAccountID, ArtifactsNamespace                                                                   string
}
type infrastructureConnectionSecret struct{ DatabasePassword, AccessKeyID, SecretAccessKey, SessionToken, CloudflareAPIToken string }
type infrastructureConnectionRecord struct {
	ID                                     string
	Version                                int64
	Config                                 infrastructureConnectionConfig
	EncryptedCredential, CredentialBinding []byte
	CredentialKeyID                        string
	CreatedAt                              time.Time
}

func infrastructureBinding(id string, version int64) []byte {
	h := sha256.Sum256([]byte("golf:infrastructure_connection:v1\x00" + id + "\x00" + strconv.FormatInt(version, 10)))
	return h[:]
}
func (s *Server) loadInfrastructureConnection(ctx context.Context, id string, version int64) (infrastructureConnectionRecord, error) {
	var row infrastructureConnectionRecord
	var config []byte
	if !creationKey.MatchString(id) || version < 1 {
		return row, invalid("Provide a canonical profile ID and positive version.")
	}
	err := s.db.QueryRowContext(ctx, `SELECT profile_id::text,version,config,encrypted_credential,credential_binding,credential_key_id,created_at FROM golf_infrastructure_connection_versions WHERE profile_id=$1 AND version=$2`, id, version).Scan(&row.ID, &row.Version, &config, &row.EncryptedCredential, &row.CredentialBinding, &row.CredentialKeyID, &row.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return row, errResourceNotFound
	}
	if err != nil {
		return row, errStorageUnavailable
	}
	if json.Unmarshal(config, &row.Config) != nil {
		return row, errStorageUnavailable
	}
	return row, nil
}
func wireInfrastructureConnection(row infrastructureConnectionRecord) *golfv1.InfrastructureConnection {
	c := row.Config
	return &golfv1.InfrastructureConnection{Id: row.ID, Version: strconv.FormatInt(row.Version, 10), Label: c.Label, Kind: c.Kind, DatabaseRole: c.DatabaseRole, Backend: c.Backend, Endpoint: c.Endpoint, Region: c.Region, Bucket: c.Bucket, PathStyle: c.PathStyle, TlsMode: c.TLSMode, DatabaseName: c.DatabaseName, DatabaseUser: c.DatabaseUser, HasCredential: true, ActivationState: "saved_not_active", Prefix: c.Prefix, AllowInsecure: c.AllowInsecure, CreatedAt: row.CreatedAt.UTC().Format(time.RFC3339Nano), CloudflareAccountId: c.CloudflareAccountID, ArtifactsNamespace: c.ArtifactsNamespace}
}
func validateInfrastructureConnection(p *golfv1.InfrastructureConnection) (infrastructureConnectionConfig, error) {
	if p == nil {
		return infrastructureConnectionConfig{}, invalid("Provide connection configuration.")
	}
	c := infrastructureConnectionConfig{Label: p.Label, Kind: p.Kind, DatabaseRole: p.DatabaseRole, Backend: p.Backend, Endpoint: p.Endpoint, Region: p.Region, Bucket: p.Bucket, TLSMode: p.TlsMode, DatabaseName: p.DatabaseName, DatabaseUser: p.DatabaseUser, Prefix: p.Prefix, PathStyle: p.PathStyle, AllowInsecure: p.AllowInsecure}
	c.CloudflareAccountID, c.ArtifactsNamespace = p.CloudflareAccountId, p.ArtifactsNamespace
	clean := func(value string, max int) bool {
		return len(value) <= max && strings.IndexFunc(value, unicode.IsControl) < 0
	}
	if c.Label == "" || !clean(c.Label, 120) || !clean(c.Endpoint, 1024) || !clean(c.DatabaseName, 128) || !clean(c.DatabaseUser, 128) || !clean(c.Region, 128) || !clean(c.Bucket, 128) || !clean(c.Prefix, 255) {
		return c, invalid("Connection metadata exceeds its safe bounds.")
	}
	if c.Kind != "CLOUDFLARE" && (c.CloudflareAccountID != "" || c.ArtifactsNamespace != "") {
		return c, invalid("Cloudflare account fields require a Cloudflare management profile.")
	}
	if c.Kind == "DATABASE" {
		if c.Backend != "POSTGRESQL" || c.DatabaseRole != "GOLF" && c.DatabaseRole != "NATIVE" || c.DatabaseName == "" || c.DatabaseUser == "" || c.Bucket != "" || c.Region != "" || c.Prefix != "" || c.PathStyle {
			return c, invalid("Provide a PostgreSQL role, database and user only.")
		}
		host, port, err := net.SplitHostPort(c.Endpoint)
		n, e := strconv.Atoi(port)
		if err != nil || e != nil || n < 1 || n > 65535 || host == "" || strings.ContainsAny(host, "/?#@\\ ") {
			return c, invalid("Database endpoint must be a plain host:port.")
		}
		if c.TLSMode != "require" && c.TLSMode != "verify-full" && !(c.TLSMode == "disable" && c.AllowInsecure) {
			return c, invalid("Select require/verify-full TLS, or explicitly permit an insecure local connection.")
		}
	} else if c.Kind == "OBJECT_STORAGE" {
		if c.Backend != "RUSTFS" && c.Backend != "S3" && c.Backend != "R2" || c.DatabaseRole != "" || c.DatabaseName != "" || c.DatabaseUser != "" || c.TLSMode != "" || c.Bucket == "" || c.Region == "" {
			return c, invalid("Provide an object-storage backend, region and bucket only.")
		}
		u, err := url.Parse(c.Endpoint)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || u.Scheme != "https" && !(u.Scheme == "http" && c.AllowInsecure) {
			return c, invalid("Object endpoint must be an HTTPS origin, or explicitly permitted local HTTP origin.")
		}
		c.Endpoint = strings.TrimRight(c.Endpoint, "/")
		c.Prefix = strings.TrimSuffix(c.Prefix, "/")
		if strings.HasPrefix(c.Prefix, "/") || strings.Contains(c.Prefix, "..") || strings.Contains(c.Prefix, "\\") {
			return c, invalid("Object prefix must be a plain relative prefix.")
		}
		if err := objectstore.ValidateConfig(objectstore.Config{Endpoint: c.Endpoint, Bucket: c.Bucket, Region: c.Region, Prefix: c.Prefix, PathStyle: c.PathStyle, AllowHTTP: c.AllowInsecure}); err != nil {
			return c, invalid("Object storage configuration is invalid.")
		}
	} else if c.Kind == "CLOUDFLARE" {
		if c.Backend != "CLOUDFLARE" || c.Endpoint != cloudflare.APIOrigin || !cloudflare.ValidManagementTarget(c.CloudflareAccountID, c.ArtifactsNamespace) || c.DatabaseRole != "" || c.DatabaseName != "" || c.DatabaseUser != "" || c.TLSMode != "" || c.Region != "" || c.Bucket != "" || c.Prefix != "" || c.PathStyle || c.AllowInsecure {
			return c, invalid("Provide a Cloudflare account ID, optional Artifacts namespace and the official HTTPS API origin only.")
		}
	} else {
		return c, invalid("Select DATABASE, OBJECT_STORAGE or CLOUDFLARE.")
	}
	return c, nil
}
func validateInfrastructureSecret(c infrastructureConnectionConfig, p *golfv1.InfrastructureConnectionCredential) (infrastructureConnectionSecret, error) {
	if p == nil {
		return infrastructureConnectionSecret{}, invalid("Provide credentials or explicitly retain the previous credentials.")
	}
	v := infrastructureConnectionSecret{p.DatabasePassword, p.AccessKeyId, p.SecretAccessKey, p.SessionToken, p.CloudflareApiToken}
	for _, s := range []string{v.DatabasePassword, v.AccessKeyID, v.SecretAccessKey, v.SessionToken, v.CloudflareAPIToken} {
		if len(s) > 8192 || strings.ContainsRune(s, 0) {
			return v, invalid("Credential exceeds its safe bound.")
		}
	}
	if c.Kind == "CLOUDFLARE" {
		if !cloudflare.ValidAPIToken(v.CloudflareAPIToken) || v.DatabasePassword != "" || v.AccessKeyID != "" || v.SecretAccessKey != "" || v.SessionToken != "" {
			return v, invalid("Provide only the Cloudflare management API token.")
		}
		return v, nil
	}
	if v.CloudflareAPIToken != "" {
		return v, invalid("Cloudflare API tokens require a Cloudflare management profile.")
	}
	if c.Kind == "DATABASE" {
		if v.DatabasePassword == "" || v.AccessKeyID != "" || v.SecretAccessKey != "" || v.SessionToken != "" {
			return v, invalid("Provide only the database password.")
		}
	} else if v.DatabasePassword != "" || v.AccessKeyID == "" || v.SecretAccessKey == "" {
		return v, invalid("Provide an access key ID and secret key.")
	}
	return v, nil
}

// Confirmation snapshot is private and is checked again under user/account/session
// locks before any mutation. Network tests additionally recheck after their wait.
func (s *Server) confirmInfrastructureAdmin(ctx context.Context, value string, credential forgeCredential, password string) (database.GetAdminPasswordConfirmationRow, error) {
	var empty database.GetAdminPasswordConfirmationRow
	if err := s.requireInstanceAdmin(ctx, value, credential); err != nil {
		return empty, err
	}
	if !validLocalPassword(password) {
		return empty, errPasswordConfirmation
	}
	hash, err := s.authSessionHash(ctx, value, nil)
	if err != nil {
		return empty, err
	}
	row, err := database.New(s.db).GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.ForgeURL})
	if errors.Is(err, sql.ErrNoRows) {
		return empty, errUnauthenticated
	}
	if err != nil {
		return empty, errStorageUnavailable
	}
	correct, err := s.verifyLocalPasswordAttempt(ctx, row.Username, password, row.PasswordHash)
	if err != nil {
		return empty, err
	}
	if !correct {
		return empty, errPasswordConfirmation
	}
	if err = s.requireInstanceAdmin(ctx, value, credential); err != nil {
		return empty, err
	}
	return row, nil
}
func (s *Server) infrastructureAdminTransaction(ctx context.Context, value string, initial database.GetAdminPasswordConfirmationRow, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	q := database.New(s.db).WithTx(tx)
	hash, err := s.authSessionHash(ctx, value, nil)
	if err != nil {
		return err
	}
	identity, err := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: hash, ForgeURL: s.config.ForgeURL})
	if errors.Is(err, sql.ErrNoRows) {
		return errUnauthenticated
	}
	if err != nil {
		return errStorageUnavailable
	}
	if identity.ID != initial.UserID {
		return errUnauthenticated
	}
	account, err := q.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: initial.ID, UserID: initial.UserID})
	if err != nil {
		return errStorageUnavailable
	}
	if !account.IsInstanceAdmin || account.DisabledAt.Valid || account.PasswordHash != initial.PasswordHash || account.CredentialVersion != initial.CredentialVersion {
		return errUnauthenticated
	}
	if _, err = q.LockSessionCredential(ctx, database.LockSessionCredentialParams{TokenHash: hash, ForgeURL: s.config.ForgeURL}); err != nil {
		return errUnauthenticated
	}
	check := func() error {
		current, e := q.GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.ForgeURL})
		if errors.Is(e, sql.ErrNoRows) {
			return errUnauthenticated
		}
		if e != nil {
			return errStorageUnavailable
		}
		if current != initial {
			return errUnauthenticated
		}
		return nil
	}
	if err = check(); err != nil {
		return err
	}
	if err = fn(tx); err != nil {
		return err
	}
	if err = check(); err != nil {
		return err
	}
	if tx.Commit() != nil {
		return errStorageUnavailable
	}
	return nil
}

// Defaults describe actual startup configuration; they neither infer an
// unreported native database nor claim a successful health/connection probe.
func (s *Server) deploymentInfrastructureDefaults() []*golfv1.InfrastructureConnection {
	safeEndpoint := func(value string) string {
		host, port, err := net.SplitHostPort(value)
		if err != nil || host == "" || strings.ContainsAny(host, "/?#@\\ ") || strings.IndexFunc(value, unicode.IsControl) >= 0 {
			return "Not reported"
		}
		if n, e := strconv.Atoi(port); e != nil || n < 1 || n > 65535 {
			return "Not reported"
		}
		return value
	}
	defaults := []*golfv1.InfrastructureConnection{
		{Label: "Golf database from deployment", Kind: "DATABASE", DatabaseRole: "GOLF", Backend: "POSTGRESQL", Endpoint: safeEndpoint(s.config.DatabaseEndpoint), TlsMode: s.config.DatabaseTLSMode, Version: "0", ActivationState: "deployment_default"},
		{Label: "Native database (operator-reported endpoint)", Kind: "DATABASE", DatabaseRole: "NATIVE", Backend: "UNREPORTED", Endpoint: safeEndpoint(s.config.NativeDatabaseEndpoint), Version: "0", ActivationState: "deployment_default"},
	}
	if s.config.NativeDatabaseEndpoint != "" && defaults[1].Endpoint != "Not reported" {
		defaults[1].Backend = "POSTGRESQL"
	}
	c := s.config.ObjectStoreConfig
	if s.defaultObjectStore != nil {
		defaults = append(defaults, &golfv1.InfrastructureConnection{Label: "Object storage from deployment (fallback)", Kind: "OBJECT_STORAGE", Backend: "S3", Endpoint: c.Endpoint, Region: c.Region, Bucket: c.Bucket, Prefix: c.Prefix, PathStyle: c.PathStyle, AllowInsecure: c.AllowHTTP, Version: "0", ActivationState: "deployment_default"})
	}
	return defaults
}

func (s *Server) ListInfrastructureConnections(ctx context.Context, req *connect.Request[golfv1.ListInfrastructureConnectionsRequest]) (*connect.Response[golfv1.ListInfrastructureConnectionsResponse], error) {
	credential, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	value := s.cookieValue(req.Header())
	if err = s.requireInstanceAdmin(ctx, value, credential); err != nil {
		return nil, err
	}
	page, limit, err := pagination(pageFrom(req.Msg.Page))
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT v.profile_id::text,v.version,v.config,v.created_at FROM golf_infrastructure_connections p JOIN golf_infrastructure_connection_versions v ON v.profile_id=p.id AND v.version=p.current_version ORDER BY p.created_at,p.id LIMIT $1 OFFSET $2`, limit+1, (page-1)*limit)
	if err != nil {
		return nil, infrastructureRPCError(errStorageUnavailable)
	}
	defer rows.Close()
	result := &golfv1.ListInfrastructureConnectionsResponse{Page: wirePage(0), DeploymentDefaults: s.deploymentInfrastructureDefaults()}
	var activeRevision int64
	var activeID sql.NullString
	var activeVersion sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT profile_id::text,version,revision FROM golf_active_object_connection WHERE singleton`).Scan(&activeID, &activeVersion, &activeRevision); err != nil {
		return nil, infrastructureRPCError(errStorageUnavailable)
	}
	result.ActiveRevision = strconv.FormatInt(activeRevision, 10)
	if activeID.Valid {
		result.ActiveConnectionId = activeID.String
		result.ActiveConnectionVersion = strconv.FormatInt(activeVersion.Int64, 10)
		// Read the immutable active version, rather than attributing a newer
		// saved draft's endpoint/bucket to the currently active binding.
		var current infrastructureConnectionRecord
		var config []byte
		if err := s.db.QueryRowContext(ctx, `SELECT profile_id::text,version,config,created_at FROM golf_infrastructure_connection_versions WHERE profile_id=$1 AND version=$2`, activeID.String, activeVersion.Int64).Scan(&current.ID, &current.Version, &config, &current.CreatedAt); err != nil || json.Unmarshal(config, &current.Config) != nil {
			return nil, infrastructureRPCError(errStorageUnavailable)
		}
		result.ActiveConnection = wireInfrastructureConnection(current)
		result.ActiveConnection.ActivationState = "active_ci_source_storage"
	}
	for rows.Next() {
		var row infrastructureConnectionRecord
		var config []byte
		if rows.Scan(&row.ID, &row.Version, &config, &row.CreatedAt) != nil || json.Unmarshal(config, &row.Config) != nil {
			return nil, infrastructureRPCError(errStorageUnavailable)
		}
		public := wireInfrastructureConnection(row)
		if activeID.Valid && activeID.String == row.ID && activeVersion.Int64 == row.Version {
			public.ActivationState = "active_ci_source_storage"
		}
		result.Connections = append(result.Connections, public)
	}
	if rows.Err() != nil {
		return nil, infrastructureRPCError(errStorageUnavailable)
	}
	if len(result.Connections) > int(limit) {
		if page == 10000 {
			return nil, infrastructureRPCError(invalid("Connection listing exceeds its pagination bound."))
		}
		result.Connections = result.Connections[:limit]
		result.Page.NextPage = page + 1
	}
	if err = s.requireInstanceAdmin(ctx, value, credential); err != nil {
		return nil, err
	}
	return connect.NewResponse(result), nil
}
func (s *Server) SaveInfrastructureConnection(ctx context.Context, req *connect.Request[golfv1.SaveInfrastructureConnectionRequest]) (*connect.Response[golfv1.SaveInfrastructureConnectionResponse], error) {
	credential, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	value := s.cookieValue(req.Header())
	initial, err := s.confirmInfrastructureAdmin(ctx, value, credential, req.Msg.PasswordConfirmation)
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	c, err := validateInfrastructureConnection(req.Msg.Connection)
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	id := req.Msg.Connection.Id
	expected := int64(0)
	if id == "" {
		if req.Msg.ExpectedVersion != "0" {
			return nil, infrastructureRPCError(invalid("New connections require expected version zero."))
		}
		id, err = repositoryCreationKey("")
	} else {
		expected, err = discussionID(req.Msg.ExpectedVersion)
		if !creationKey.MatchString(id) {
			err = invalid("Provide a canonical profile ID.")
		}
	}
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	var secret infrastructureConnectionSecret
	if req.Msg.RetainCredential {
		if expected == 0 || req.Msg.Credential != nil {
			return nil, infrastructureRPCError(invalid("Retain existing credentials only when editing without replacement."))
		}
		old, e := s.loadInfrastructureConnection(ctx, id, expected)
		if e != nil {
			return nil, infrastructureRPCError(e)
		}
		if old.Config.Kind != c.Kind {
			return nil, infrastructureRPCError(invalid("Credential kind cannot change while retaining credentials."))
		}
		if c.Kind == "CLOUDFLARE" && old.Config.CloudflareAccountID != c.CloudflareAccountID {
			return nil, infrastructureRPCError(invalid("Changing Cloudflare accounts requires replacement credentials."))
		}
		plain, e := s.keyring.open(old.CredentialKeyID, infrastructureConnectionDomain, old.EncryptedCredential, old.CredentialBinding)
		if e != nil {
			return nil, infrastructureRPCError(e)
		}
		if json.Unmarshal([]byte(plain), &secret) != nil {
			return nil, infrastructureRPCError(errCredentialUnavailable)
		}
	} else {
		secret, err = validateInfrastructureSecret(c, req.Msg.Credential)
		if err != nil {
			return nil, infrastructureRPCError(err)
		}
	}
	binding := infrastructureBinding(id, expected+1)
	plain, _ := json.Marshal(secret)
	if len(plain) > 16384 {
		return nil, infrastructureRPCError(invalid("Combined credential exceeds its safe bound."))
	}
	encrypted, keyID, err := s.keyring.seal(infrastructureConnectionDomain, string(plain), binding)
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	config, _ := json.Marshal(c)
	err = s.infrastructureAdminTransaction(ctx, value, initial, func(tx *sql.Tx) error {
		if expected == 0 {
			if _, e := tx.ExecContext(ctx, `INSERT INTO golf_infrastructure_connections(id,current_version) VALUES($1,1)`, id); e != nil {
				return errStorageUnavailable
			}
		} else {
			var version int64
			if e := tx.QueryRowContext(ctx, `SELECT current_version FROM golf_infrastructure_connections WHERE id=$1 FOR UPDATE`, id).Scan(&version); errors.Is(e, sql.ErrNoRows) {
				return errResourceNotFound
			} else if e != nil {
				return errStorageUnavailable
			}
			if version != expected {
				return errInfrastructureConflict
			}
			if _, e := tx.ExecContext(ctx, `UPDATE golf_infrastructure_connections SET current_version=current_version+1 WHERE id=$1`, id); e != nil {
				return errStorageUnavailable
			}
		}
		_, e := tx.ExecContext(ctx, `INSERT INTO golf_infrastructure_connection_versions(profile_id,version,config,encrypted_credential,credential_binding,credential_key_id,actor_user_id,actor_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, expected+1, config, encrypted, binding, keyID, initial.UserID, initial.SessionID)
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	row, err := s.loadInfrastructureConnection(ctx, id, expected+1)
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	if err = s.requireInstanceAdmin(ctx, value, credential); err != nil {
		return nil, err
	}
	return connect.NewResponse(&golfv1.SaveInfrastructureConnectionResponse{Connection: wireInfrastructureConnection(row)}), nil
}
func (s *Server) TestInfrastructureConnection(ctx context.Context, req *connect.Request[golfv1.TestInfrastructureConnectionRequest]) (*connect.Response[golfv1.TestInfrastructureConnectionResponse], error) {
	credential, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	value := s.cookieValue(req.Header())
	initial, err := s.confirmInfrastructureAdmin(ctx, value, credential, req.Msg.PasswordConfirmation)
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	version, err := discussionID(req.Msg.ExpectedVersion)
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	row, err := s.loadInfrastructureConnection(ctx, req.Msg.Id, version)
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	var observed int64
	if e := s.db.QueryRowContext(ctx, `SELECT current_version FROM golf_infrastructure_connections WHERE id=$1`, row.ID).Scan(&observed); e != nil {
		return nil, infrastructureRPCError(errStorageUnavailable)
	}
	if observed != version {
		return nil, infrastructureRPCError(errInfrastructureConflict)
	}
	plain, err := s.keyring.open(row.CredentialKeyID, infrastructureConnectionDomain, row.EncryptedCredential, row.CredentialBinding)
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	var secret infrastructureConnectionSecret
	if json.Unmarshal([]byte(plain), &secret) != nil {
		return nil, infrastructureRPCError(errCredentialUnavailable)
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	scope := "postgresql_ping_no_migrations"
	var capabilities []*golfv1.InfrastructureCapability
	if row.Config.Kind == "DATABASE" {
		u := url.URL{Scheme: "postgres", Host: row.Config.Endpoint, Path: "/" + row.Config.DatabaseName, User: url.UserPassword(row.Config.DatabaseUser, secret.DatabasePassword)}
		query := url.Values{"sslmode": {row.Config.TLSMode}, "connect_timeout": {"4"}}
		u.RawQuery = query.Encode()
		var db *sql.DB
		db, err = sql.Open("pgx", u.String())
		if err == nil {
			db.SetMaxOpenConns(1)
			err = db.PingContext(probe)
			db.Close()
		}
	} else if row.Config.Kind == "CLOUDFLARE" {
		scope = "cloudflare_account_service_reads_only"
		var report cloudflare.Report
		report, err = cloudflare.InspectManagement(probe, row.Config.CloudflareAccountID, row.Config.ArtifactsNamespace, secret.CloudflareAPIToken)
		if err == nil {
			for _, o := range report.Observations {
				capabilities = append(capabilities, &golfv1.InfrastructureCapability{Service: o.Service, State: o.State, Scope: o.Scope, HttpStatus: uint32(o.HTTPStatus)})
				if o.State != "accessible" {
					err = errors.New("Cloudflare service read unavailable")
				}
			}
		}
	} else {
		scope = "bucket_head_accessibility_only"
		var store *objectstore.Store
		store, err = objectstore.New(probe, objectstore.Config{Endpoint: row.Config.Endpoint, Bucket: row.Config.Bucket, Region: row.Config.Region, Prefix: row.Config.Prefix, PathStyle: row.Config.PathStyle, AllowHTTP: row.Config.AllowInsecure, AccessKeyID: secret.AccessKeyID, SecretAccessKey: secret.SecretAccessKey, SessionToken: secret.SessionToken})
		if err == nil {
			err = store.ProbeBucket(probe)
		}
	}
	accessible := err == nil
	if e := s.requireInstanceAdmin(ctx, value, credential); e != nil {
		return nil, e
	}
	if e := s.infrastructureAdminTransaction(ctx, value, initial, func(tx *sql.Tx) error {
		var current int64
		if e := tx.QueryRowContext(ctx, `SELECT current_version FROM golf_infrastructure_connections WHERE id=$1`, row.ID).Scan(&current); e != nil {
			return errStorageUnavailable
		}
		if current != version {
			return errInfrastructureConflict
		}
		return nil
	}); e != nil {
		return nil, infrastructureRPCError(e)
	}
	code := "connection_failed"
	if accessible {
		code = "accessible"
	}
	return connect.NewResponse(&golfv1.TestInfrastructureConnectionResponse{Accessible: accessible, ResultCode: code, CheckedAt: time.Now().UTC().Format(time.RFC3339Nano), QualificationScope: scope, Capabilities: capabilities}), nil
}

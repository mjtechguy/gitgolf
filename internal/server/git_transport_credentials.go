package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const gitCredentialPrefix = "golf_git_"

var errGitBackgroundUnqualified = errors.New("Managed Git writes require a separately qualified fresh private-native bootstrap; background writers are unqualified")
var errGitTransportDisabled = errors.New("Managed HTTP Git is disabled")
var errGitReceiveRecorded = errors.New("This managed Git receive was already recorded; inspect the original outcome instead of resending")
var errGitReceiveUnknown = errors.New("Managed Git receive outcome is unresolved; do not resend or replace the credential")

type managedGitConfiguration struct {
	Enabled, AllowLoopback bool
	PublicURL, Incarnation string
}

func managedGitConfig(getenv func(string) string) (managedGitConfiguration, error) {
	c := managedGitConfiguration{Enabled: getenv("GOLF_MANAGED_HTTP_GIT") == "true", AllowLoopback: getenv("GOLF_MANAGED_HTTP_GIT_ALLOW_LOOPBACK") == "true", PublicURL: getenv("GOLF_MANAGED_HTTP_GIT_PUBLIC_URL"), Incarnation: getenv("GOLF_MANAGED_HTTP_GIT_INCARNATION")}
	for _, key := range []string{"GOLF_MANAGED_HTTP_GIT", "GOLF_MANAGED_HTTP_GIT_ALLOW_LOOPBACK"} {
		if v := getenv(key); v != "" && v != "false" && v != "true" {
			return c, invalid("Managed Git boolean configuration is invalid.")
		}
	}
	if !c.Enabled {
		if c.PublicURL != "" || c.Incarnation != "" || c.AllowLoopback {
			return c, invalid("Managed Git settings require explicit enablement.")
		}
		return c, nil
	}
	u, e := url.Parse(c.PublicURL)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || u.Scheme != "https" && u.Scheme != "http" {
		return c, invalid("Managed Git public URL must be an explicit HTTPS origin.")
	}
	if u.Scheme == "http" && (!c.AllowLoopback || !isLoopbackHost(u.Hostname())) {
		return c, invalid("Plain HTTP Git is permitted only for explicitly enabled loopback development.")
	}
	if c.AllowLoopback && !isLoopbackHost(u.Hostname()) {
		return c, invalid("Loopback Git development requires a loopback public origin.")
	}
	if c.Incarnation != "" {
		id, e := uuid.Parse(c.Incarnation)
		if e != nil || id.String() != c.Incarnation || id.Version() != 4 {
			return c, invalid("Managed Git incarnation must be a canonical UUIDv4.")
		}
	}
	c.PublicURL = strings.TrimRight(c.PublicURL, "/")
	return c, nil
}
func isLoopbackHost(host string) bool {
	ip := net.ParseIP(host)
	return host == "localhost" || ip != nil && ip.IsLoopback()
}
func (s *Server) gitConfiguration() (managedGitConfiguration, error) {
	return s.managedGit, nil
}
func gitTokenHash(secret string) ([]byte, error) {
	if len(secret) != len(gitCredentialPrefix)+43 || !strings.HasPrefix(secret, gitCredentialPrefix) {
		return nil, errUnauthenticated
	}
	raw, e := base64.RawURLEncoding.DecodeString(secret[len(gitCredentialPrefix):])
	if e != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != secret[len(gitCredentialPrefix):] {
		return nil, errUnauthenticated
	}
	h := sha256.Sum256([]byte(secret))
	return h[:], nil
}
func gitMode(mode golfv1.GitCredentialMode) (string, error) {
	switch mode {
	case golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_READ:
		return "READ", nil
	case golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_WRITE:
		return "WRITE", nil
	}
	return "", invalid("Choose a supported Golf Git credential mode.")
}
func gitTarget(key repositoryKey, repoID, ownerID string) error {
	if _, e := repositoryPath(key); e != nil {
		return e
	}
	if _, e := discussionID(repoID); e != nil {
		return invalid("Provide the exact repository and owner identities.")
	}
	if _, e := discussionID(ownerID); e != nil {
		return invalid("Provide the exact repository and owner identities.")
	}
	return nil
}

type gitNativeRepository struct {
	Repository
	Owner         *User                       `json:"owner"`
	Archived      *bool                       `json:"archived"`
	Mirror        *bool                       `json:"mirror"`
	NativeActions *bool                       `json:"has_actions"`
	Permissions   *struct{ Pull, Push *bool } `json:"permissions"`
}

func (s *Server) gitCurrentTarget(ctx context.Context, credential forgeCredential, key repositoryKey, repoID, ownerID string, write bool) (gitNativeRepository, User, error) {
	var actor struct {
		User
		SiteAdmin *bool `json:"is_admin"`
	}
	var repo gitNativeRepository
	if _, e := s.forge(ctx, http.MethodGet, "/user", credential, nil, &actor); e != nil {
		return repo, User{}, e
	}
	if actor.ID <= 0 || !validOrganizationName(actor.Login) || actor.SiteAdmin == nil {
		return repo, User{}, errInvalidForgeResponse
	}
	base, e := repositoryPath(key)
	if e != nil {
		return repo, User{}, e
	}
	if _, e = s.forge(ctx, http.MethodGet, base, credential, nil, &repo); e != nil {
		return repo, User{}, e
	}
	if !validRepository(repo.Repository) || repo.Owner == nil || repo.ID <= 0 || repo.Owner.ID <= 0 || repoID != strconv.FormatInt(repo.ID, 10) || ownerID != strconv.FormatInt(repo.Owner.ID, 10) || repo.FullName != key.Owner+"/"+key.Name || repo.Owner.Login != key.Owner || repo.Permissions == nil || repo.Permissions.Pull == nil || !*repo.Permissions.Pull {
		return repo, User{}, errResourceNotFound
	}
	if repo.Archived == nil || repo.Mirror == nil || repo.NativeActions == nil {
		return repo, User{}, errInvalidForgeResponse
	}
	if write && (repo.Permissions.Push == nil || !*repo.Permissions.Push || *repo.Archived || *repo.Mirror) {
		return repo, User{}, errResourceNotFound
	}
	// A native site administrator's effective permission is not ordinary Git authority.
	// Actual ownership, own direct collaboration or actual organization ownership is positive proof.
	if *actor.SiteAdmin && actor.ID != repo.Owner.ID {
		direct, e := s.directCollaborator(ctx, credential, base, actor.User)
		if e != nil {
			return repo, User{}, e
		}
		permission, e := s.repositoryPermission(ctx, credential, base, actor.User)
		if e != nil {
			return repo, User{}, e
		}
		acceptable := direct && (permission == "read" || permission == "write" || permission == "admin")
		if write {
			acceptable = direct && (permission == "write" || permission == "admin")
		}
		if !acceptable {
			org, e := s.repositoryOwnerKind(ctx, credential, *repo.Owner)
			if e != nil {
				return repo, User{}, e
			}
			if org {
				var nativeOrg forgeOrganization
				if _, e = s.forge(ctx, http.MethodGet, "/orgs/"+key.Owner, credential, nil, &nativeOrg); e == nil {
					acceptable, e = s.organizationOwner(ctx, credential, nativeOrg, actor.User)
				}
				if e != nil {
					return repo, User{}, e
				}
			}
		}
		if !acceptable {
			return repo, User{}, errResourceNotFound
		}
	}
	return repo, actor.User, nil
}
func (s *Server) gitWritePrerequisites(ctx context.Context, db database.DBTX, credential forgeCredential, key repositoryKey, repo gitNativeRepository, c managedGitConfiguration) error {
	// No public enrollment RPC or checkbox can establish native queue/process quiescence.
	// This packet has no profile enrollment command. WRITE remains unavailable until
	// the independent fresh-bootstrap qualifier and operator enrollment are reviewed.
	if c.Incarnation == "" || s.db == nil || db == nil {
		return errGitBackgroundUnqualified
	}
	var qualified bool
	if e := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_git_transport_profiles WHERE forge_url=$1 AND incarnation=$2 AND native_version='1.27.3' AND suspended_at IS NULL)`, s.config.GiteaURL, c.Incarnation).Scan(&qualified); e != nil {
		return errStorageUnavailable
	}
	if !qualified || *repo.Mirror || *repo.NativeActions {
		return errGitBackgroundUnqualified
	}
	base, _ := repositoryPath(key)
	for _, endpoint := range []string{"/branch_protections", "/tag_protections", "/push_mirrors"} {
		var rows []map[string]any
		url := base + endpoint
		if endpoint == "/push_mirrors" {
			url += "?page=1&limit=1"
		}
		h, e := s.forge(ctx, http.MethodGet, url, credential, nil, &rows)
		if e != nil {
			return errGitBackgroundUnqualified
		}
		if !gitEmptyInventory(endpoint, rows, h) {
			return errGitBackgroundUnqualified
		}
	}
	return nil
}
func gitTransportError(e error) error {
	switch {
	case errors.Is(e, errGitBackgroundUnqualified):
		return connect.NewError(connect.CodeFailedPrecondition, errGitBackgroundUnqualified)
	case errors.Is(e, errGitTransportDisabled):
		return connect.NewError(connect.CodeFailedPrecondition, errGitTransportDisabled)
	case errors.Is(e, errGitReceiveUnknown), errors.Is(e, errGitReceiveRecorded):
		return connect.NewError(connect.CodeFailedPrecondition, errGitReceiveUnknown)
	case errors.Is(e, errGitProtocol):
		return connect.NewError(connect.CodeInvalidArgument, errGitProtocol)
	}
	return rpcError(e)
}

func gitBrowserCredential(ctx context.Context) (forgeCredential, error) {
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated {
		return forgeCredential{}, rpcError(errApiCredentialReadOnly)
	}
	return rpcToken(ctx)
}
func (s *Server) GetGitTransport(ctx context.Context, req *connect.Request[golfv1.GetGitTransportRequest]) (*connect.Response[golfv1.GetGitTransportResponse], error) {
	credential, e := gitBrowserCredential(ctx)
	if e != nil {
		return nil, e
	}
	key := keyFrom(req.Msg.Repository)
	if e = gitTarget(key, req.Msg.RepositoryId, req.Msg.OwnerId); e != nil {
		return nil, gitTransportError(e)
	}
	c, e := s.gitConfiguration()
	if e != nil {
		return nil, gitTransportError(e)
	}
	out := &golfv1.GetGitTransportResponse{Repository: req.Msg.Repository, RepositoryId: req.Msg.RepositoryId, OwnerId: req.Msg.OwnerId, Enabled: c.Enabled, WriteNotice: errGitTransportDisabled.Error()}
	e = s.withForgeCaller(ctx, s.cookieValue(req.Header()), credential, func(actor User) error {
		repo, current, e := s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, false)
		if e != nil {
			return e
		}
		if current.ID != actor.ID {
			return errUnauthenticated
		}
		if c.Enabled {
			out.ReadCredentialAvailable = true
			out.CloneUrl = c.PublicURL + "/git/" + repo.FullName + ".git"
			out.WriteNotice = errGitBackgroundUnqualified.Error()
			wrepo, _, werr := s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, true)
			if werr == nil && s.gitWritePrerequisites(ctx, s.db, credential, key, wrepo, c) == nil {
				var blocked bool
				var active int64
				if e := s.db.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked($1,$2),golf_repository_lifecycle_active($1,$2)`, s.config.GiteaURL, wrepo.ID).Scan(&blocked, &active); e == nil && !blocked && active == 0 {
					out.WriteCredentialAvailable = true
					out.WriteNotice = "Only unprotected ordinary Git updates are admitted; protected publication remains unavailable."
				}
			}
		}
		_, current, e = s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, false)
		if e != nil {
			return e
		}
		if current.ID != actor.ID {
			return errUnauthenticated
		}
		return nil
	})
	if e != nil {
		return nil, gitTransportError(e)
	}
	return connect.NewResponse(out), nil
}

type gitCredentialRecord struct {
	ID, UserID, RepositoryID, OwnerID, NativeUserID, SourceSessionID int64
	ForgeURL, Label, Mode                                            string
	SourceHash, TokenHash                                            []byte
	Created, Expires                                                 time.Time
	Revoked                                                          sql.NullTime
	Active                                                           bool
}

const gitCredentialColumns = `c.id,c.user_id,c.forge_url,c.repository_id,c.owner_id,c.native_user_id,c.source_session_id,c.source_token_hash,c.token_hash,c.label,c.mode,c.created_at,c.expires_at,c.revoked_at,EXISTS(SELECT 1 FROM golf_sessions s WHERE s.session_id=c.source_session_id AND s.token_hash=c.source_token_hash AND s.user_id=c.user_id AND s.expires_at>clock_timestamp() AND (s.local_account_id IS NULL OR EXISTS(SELECT 1 FROM golf_local_accounts a WHERE a.id=s.local_account_id AND a.user_id=s.user_id AND a.disabled_at IS NULL AND a.credential_version=s.local_credential_version)))`

func scanGitCredential(row interface{ Scan(...any) error }) (gitCredentialRecord, error) {
	var c gitCredentialRecord
	e := row.Scan(&c.ID, &c.UserID, &c.ForgeURL, &c.RepositoryID, &c.OwnerID, &c.NativeUserID, &c.SourceSessionID, &c.SourceHash, &c.TokenHash, &c.Label, &c.Mode, &c.Created, &c.Expires, &c.Revoked, &c.Active)
	return c, e
}
func wireGitCredential(c gitCredentialRecord) *golfv1.GitCredential {
	mode := golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_READ
	if c.Mode == "WRITE" {
		mode = golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_WRITE
	}
	out := &golfv1.GitCredential{Id: strconv.FormatInt(c.ID, 10), Label: c.Label, RepositoryId: strconv.FormatInt(c.RepositoryID, 10), OwnerId: strconv.FormatInt(c.OwnerID, 10), Mode: mode, CreatedAt: c.Created.UTC().Format(time.RFC3339Nano), ExpiresAt: c.Expires.UTC().Format(time.RFC3339Nano), SourceSessionId: strconv.FormatInt(c.SourceSessionID, 10), SourceSessionActive: c.Active}
	if c.Revoked.Valid {
		out.RevokedAt = c.Revoked.Time.UTC().Format(time.RFC3339Nano)
	}
	return out
}
func (s *Server) CreateGitCredential(ctx context.Context, req *connect.Request[golfv1.CreateGitCredentialRequest]) (*connect.Response[golfv1.CreateGitCredentialResponse], error) {
	credential, e := gitBrowserCredential(ctx)
	if e != nil {
		return nil, e
	}
	key := keyFrom(req.Msg.Repository)
	if e = gitTarget(key, req.Msg.RepositoryId, req.Msg.OwnerId); e != nil {
		return nil, gitTransportError(e)
	}
	mode, e := gitMode(req.Msg.Mode)
	if e != nil {
		return nil, gitTransportError(e)
	}
	if !validApiCredentialLabel(req.Msg.Label) {
		return nil, gitTransportError(invalid("Choose a trimmed Git credential name of at most 64 bytes."))
	}
	lifetime := req.Msg.LifetimeSeconds
	if lifetime == 0 {
		lifetime = 3600
	}
	if lifetime < 60 || lifetime > 3600 {
		return nil, gitTransportError(invalid("Git credentials expire in 60–3600 seconds."))
	}
	c, e := s.gitConfiguration()
	if e != nil {
		return nil, gitTransportError(e)
	}
	if !c.Enabled {
		return nil, gitTransportError(errGitTransportDisabled)
	}
	repo, actor, e := s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, mode == "WRITE")
	if e != nil {
		return nil, gitTransportError(e)
	}
	if mode == "WRITE" {
		if e = s.gitWritePrerequisites(ctx, s.db, credential, key, repo, c); e != nil {
			return nil, gitTransportError(e)
		}
	}
	var raw [32]byte
	if _, e = rand.Read(raw[:]); e != nil {
		return nil, gitTransportError(errStorageUnavailable)
	}
	secret := gitCredentialPrefix + base64.RawURLEncoding.EncodeToString(raw[:])
	hash, _ := gitTokenHash(secret)
	var record gitCredentialRecord
	e = s.workflowTransaction(ctx, s.cookieValue(req.Header()), actor.ID, func(tx *sql.Tx, caller database.LockManagedSessionRow, sourceHash []byte) error {
		var count int
		if e := tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_git_credentials WHERE user_id=$1 AND forge_url=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, caller.UserID, s.config.GiteaURL).Scan(&count); e != nil {
			return errStorageUnavailable
		}
		if count >= 100 {
			return invalid("Revoke or wait for existing Git credentials before adding another.")
		}
		if mode == "WRITE" {
			if _, e := s.lockRepositoryLifecycleTransaction(ctx, tx, repo.ID); e != nil {
				return e
			}
		}
		repo, current, e := s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, mode == "WRITE")
		if e != nil {
			return e
		}
		if current.ID != actor.ID {
			return errUnauthenticated
		}
		if mode == "WRITE" {
			if e = s.gitWritePrerequisites(ctx, tx, credential, key, repo, c); e != nil {
				return e
			}
		}
		e = tx.QueryRowContext(ctx, `WITH timing AS MATERIALIZED(SELECT clock_timestamp() AS created_at) INSERT INTO golf_git_credentials(user_id,forge_url,repository_id,owner_id,native_user_id,source_session_id,source_token_hash,token_hash,label,mode,created_at,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,created_at,LEAST($11,created_at+$12::integer * interval '1 second') FROM timing RETURNING id,created_at,expires_at`, caller.UserID, s.config.GiteaURL, repo.ID, repo.Owner.ID, actor.ID, caller.SessionID, sourceHash, hash, req.Msg.Label, mode, caller.ExpiresAt, int32(lifetime)).Scan(&record.ID, &record.Created, &record.Expires)
		if e != nil {
			return errStorageUnavailable
		}
		record.UserID = caller.UserID
		record.RepositoryID = repo.ID
		record.OwnerID = repo.Owner.ID
		record.NativeUserID = actor.ID
		record.SourceSessionID = caller.SessionID
		record.Label = req.Msg.Label
		record.Mode = mode
		record.Active = true
		_, current, e = s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, mode == "WRITE")
		if e != nil {
			return e
		}
		if current.ID != actor.ID {
			return errUnauthenticated
		}
		return nil
	})
	if e != nil {
		return nil, gitTransportError(e)
	}
	return connect.NewResponse(&golfv1.CreateGitCredentialResponse{Credential: wireGitCredential(record), Secret: secret}), nil
}
func (s *Server) ListGitCredentials(ctx context.Context, req *connect.Request[golfv1.ListGitCredentialsRequest]) (*connect.Response[golfv1.ListGitCredentialsResponse], error) {
	credential, e := gitBrowserCredential(ctx)
	if e != nil {
		return nil, e
	}
	key := keyFrom(req.Msg.Repository)
	if e = gitTarget(key, req.Msg.RepositoryId, req.Msg.OwnerId); e != nil {
		return nil, gitTransportError(e)
	}
	page, limit, e := pagination(pageFrom(req.Msg.Page))
	if e != nil {
		return nil, gitTransportError(e)
	}
	_, actor, e := s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, false)
	if e != nil {
		return nil, gitTransportError(e)
	}
	out := &golfv1.ListGitCredentialsResponse{Page: wirePage(0)}
	e = s.workflowTransaction(ctx, s.cookieValue(req.Header()), actor.ID, func(tx *sql.Tx, caller database.LockManagedSessionRow, _ []byte) error {
		rows, e := tx.QueryContext(ctx, `SELECT `+gitCredentialColumns+` FROM golf_git_credentials c WHERE c.user_id=$1 AND c.forge_url=$2 AND c.repository_id=$3 AND c.owner_id=$4 ORDER BY c.id DESC LIMIT $5 OFFSET $6`, caller.UserID, s.config.GiteaURL, req.Msg.RepositoryId, req.Msg.OwnerId, limit+1, (page-1)*limit)
		if e != nil {
			return errStorageUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			record, e := scanGitCredential(rows)
			if e != nil {
				return errStorageUnavailable
			}
			out.Credentials = append(out.Credentials, wireGitCredential(record))
		}
		if e = rows.Err(); e != nil {
			return errStorageUnavailable
		}
		if len(out.Credentials) > int(limit) {
			out.Credentials = out.Credentials[:limit]
			out.Page.NextPage = page + 1
		}
		_, current, e := s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, false)
		if e != nil {
			return e
		}
		if current.ID != actor.ID {
			return errUnauthenticated
		}
		return nil
	})
	if e != nil {
		return nil, gitTransportError(e)
	}
	return connect.NewResponse(out), nil
}
func (s *Server) RevokeGitCredential(ctx context.Context, req *connect.Request[golfv1.RevokeGitCredentialRequest]) (*connect.Response[golfv1.RevokeGitCredentialResponse], error) {
	credential, e := gitBrowserCredential(ctx)
	if e != nil {
		return nil, e
	}
	key := keyFrom(req.Msg.Repository)
	if e = gitTarget(key, req.Msg.RepositoryId, req.Msg.OwnerId); e != nil {
		return nil, gitTransportError(e)
	}
	id, e := discussionID(req.Msg.CredentialId)
	if e != nil {
		return nil, gitTransportError(e)
	}
	_, actor, e := s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, false)
	if e != nil {
		return nil, gitTransportError(e)
	}
	e = s.workflowTransaction(ctx, s.cookieValue(req.Header()), actor.ID, func(tx *sql.Tx, caller database.LockManagedSessionRow, _ []byte) error {
		var exists bool
		if e := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_git_credentials WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND repository_id=$4 AND owner_id=$5)`, id, caller.UserID, s.config.GiteaURL, req.Msg.RepositoryId, req.Msg.OwnerId).Scan(&exists); e != nil {
			return errStorageUnavailable
		}
		if !exists {
			return errResourceNotFound
		}
		if _, e := tx.ExecContext(ctx, `UPDATE golf_git_credentials SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL`, id); e != nil {
			return errStorageUnavailable
		}
		_, current, e := s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, false)
		if e != nil {
			return e
		}
		if current.ID != actor.ID {
			return errUnauthenticated
		}
		return nil
	})
	if e != nil {
		return nil, gitTransportError(e)
	}
	return connect.NewResponse(&golfv1.RevokeGitCredentialResponse{CredentialId: req.Msg.CredentialId, Revoked: true}), nil
}

// Opt-in changes the product clone destination, never default deployments or
// bearer read authority. No native SSH URL is advertised in this profile.
func (s *Server) wireGitRepository(repo Repository) *golfv1.Repository {
	result := wireRepository(repo)
	if !s.managedGit.Enabled {
		return result
	}
	result.CloneUrl = ""
	result.SshUrl = ""
	parts := strings.Split(repo.FullName, "/")
	if len(parts) != 2 {
		return result
	}
	key := repositoryKey{parts[0], parts[1]}
	if _, err := repositoryPath(key); err != nil || repo.Name != key.Name {
		return result
	}
	result.CloneUrl = s.managedGit.PublicURL + "/git/" + key.Owner + "/" + key.Name + ".git"
	return result
}

// Protections are unpaged in pinned1.27.3. Push mirrors are paged and can omit
// rows whose converter fails, so only native total0 proves complete absence.
func gitEmptyInventory(endpoint string, rows []map[string]any, headers http.Header) bool {
	if rows == nil || len(rows) != 0 || len(headers.Values("Link")) != 0 {
		return false
	}
	counts := headers.Values("X-Total-Count")
	if endpoint == "/push_mirrors" {
		return len(counts) == 1 && counts[0] == "0"
	}
	return len(counts) == 0 || len(counts) == 1 && counts[0] == "0"
}

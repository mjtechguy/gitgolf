package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

// These personal connections are used only by explicitly selected imports.
// No provider discovery traverses a user's private repositories.
func providerOrigin(provider string) (api string, e error) {
	switch provider {
	case "github":
		return "https://api.github.com", nil
	case "gitlab":
		return "https://gitlab.com/api/v4", nil
	}
	return "", invalid("Choose GitHub or GitLab at its supported fixed HTTPS origin.")
}
func providerTokenValid(token string) bool {
	return len(token) >= 20 && len(token) <= 512 && !strings.ContainsFunc(token, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-')
	})
}
func (s *Server) providerJSON(ctx context.Context, provider, token, path string, output any) error {
	origin, e := providerOrigin(provider)
	if e != nil {
		return e
	}
	if !providerTokenValid(token) || !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "?#\\") {
		return errCredentialUnavailable
	}
	request, e := http.NewRequestWithContext(ctx, http.MethodGet, origin+path, nil)
	if e != nil {
		return errCredentialUnavailable
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Golf-provider-import")
	if provider == "github" {
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	} else {
		request.Header.Set("PRIVATE-TOKEN", token)
	}
	response, e := s.client.Do(request)
	if e != nil {
		return errForgeUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return forgeError{http.StatusForbidden}
	}
	if response.ContentLength > 256<<10 {
		return errForgeResponseTooLarge
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, (256<<10)+1))
	if e != nil || len(data) > 256<<10 || json.Unmarshal(data, output) != nil {
		return errInvalidForgeResponse
	}
	return nil
}
func (s *Server) providerAccount(ctx context.Context, provider, token string) (id, login string, e error) {
	var row struct {
		ID       int64  `json:"id"`
		Login    string `json:"login"`
		Username string `json:"username"`
	}
	e = s.providerJSON(ctx, provider, token, "/user", &row)
	if e != nil {
		return
	}
	login = row.Login
	if provider == "gitlab" {
		login = row.Username
	}
	if row.ID < 1 || !validOrganizationName(login) {
		return "", "", errInvalidForgeResponse
	}
	return strconv.FormatInt(row.ID, 10), login, nil
}

type providerConnectionRecord struct {
	ID, Forge, Provider, Name, ProviderID, Login, KeyID string
	UserID, ActorID, Version                            int64
	Revoked                                             bool
	Cipher, Binding                                     []byte
	Created                                             time.Time
}

const providerConnectionColumns = `id::text,user_id,forge_url,actor_id,provider,name,provider_account_id,provider_login,version,revoked,encrypted_credential,credential_binding,credential_key_id,created_at`

func scanProviderConnection(row interface{ Scan(...any) error }) (r providerConnectionRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.Forge, &r.ActorID, &r.Provider, &r.Name, &r.ProviderID, &r.Login, &r.Version, &r.Revoked, &r.Cipher, &r.Binding, &r.KeyID, &r.Created)
	return
}
func providerConnectionWire(r providerConnectionRecord) *golfv1.ProviderConnection {
	return &golfv1.ProviderConnection{Id: r.ID, Version: strconv.FormatInt(r.Version, 10), Provider: r.Provider, Name: r.Name, ProviderAccountId: r.ProviderID, ProviderLogin: r.Login, Revoked: r.Revoked, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano)}
}
func providerConnectionBinding(id string) []byte {
	h := sha256.Sum256([]byte("golf:personal-provider-connection:v1\x00" + id))
	return h[:]
}

type providerSecret struct {
	Contract     string
	ConnectionID string
	UserID       int64
	Forge        string
	Provider     string
	ProviderID   string
	Token        string
}

func (s *Server) providerSecret(r providerConnectionRecord) (string, error) {
	if !bytes.Equal(r.Binding, providerConnectionBinding(r.ID)) {
		return "", errCredentialUnavailable
	}
	plain, e := s.keyring.open(r.KeyID, infrastructureConnectionDomain, r.Cipher, r.Binding)
	if e != nil {
		return "", e
	}
	var secret providerSecret
	if json.Unmarshal([]byte(plain), &secret) != nil || secret.Contract != "golf.personal-provider-connection.v1" || secret.ConnectionID != r.ID || secret.UserID != r.UserID || secret.Forge != r.Forge || secret.Provider != r.Provider || secret.ProviderID != r.ProviderID || !providerTokenValid(secret.Token) {
		return "", errCredentialUnavailable
	}
	return secret.Token, nil
}
func (s *Server) ownProviderConnection(ctx context.Context, session string, token forgeCredential, id, version string, active bool) (record providerConnectionRecord, e error) {
	if !creationKey.MatchString(id) {
		return record, invalid("Choose the original provider connection.")
	}
	if version != "" {
		v, e := discussionID(version)
		if e != nil || v < 1 {
			return record, invalid("Choose a current connection version.")
		}
	}
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return record, e
	}
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
		var e error
		record, e = scanProviderConnection(s.db.QueryRowContext(ctx, `SELECT `+providerConnectionColumns+` FROM golf_provider_connections WHERE id=$1 AND user_id=$2 AND forge_url=$3`, id, caller.UserID, s.config.ForgeURL))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		if record.ActorID != actor.ID || version != "" && strconv.FormatInt(record.Version, 10) != version || active && record.Revoked {
			return errRepositoryAccessConflict
		}
		return nil
	})
	return
}
func (s *Server) ListProviderConnections(ctx context.Context, req *connect.Request[golfv1.ListProviderConnectionsRequest]) (*connect.Response[golfv1.ListProviderConnectionsResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, rpcError(e)
	}
	result := &golfv1.ListProviderConnectionsResponse{}
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		rows, e := s.db.QueryContext(ctx, `SELECT `+providerConnectionColumns+` FROM golf_provider_connections WHERE user_id=$1 AND forge_url=$2 ORDER BY created_at DESC,id LIMIT 101`, c.UserID, s.config.ForgeURL)
		if e != nil {
			return errStorageUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			r, e := scanProviderConnection(rows)
			if e != nil {
				return errStorageUnavailable
			}

			if r.ActorID != actor.ID {
				return errUnauthenticated
			}
			result.Connections = append(result.Connections, providerConnectionWire(r))
		}
		if rows.Err() != nil {
			return errStorageUnavailable
		}
		if len(result.Connections) > 100 {
			return errForgeResponseTooLarge
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) CreateProviderConnection(ctx context.Context, req *connect.Request[golfv1.CreateProviderConnectionRequest]) (*connect.Response[golfv1.CreateProviderConnectionResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if !creationKey.MatchString(m.ConnectionId) || !pullTitle(m.Name) || len(m.Name) > 120 || !providerTokenValid(m.Token) {
		return nil, rpcError(invalid("Use a new UUID, connection name up to120 bytes and a personal provider token."))
	}
	if _, e = providerOrigin(m.Provider); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, rpcError(e)
	}
	if e = s.withManagedSession(ctx, session, token, func(*database.Queries, database.LockManagedSessionRow, []byte) error { return nil }); e != nil {
		return nil, rpcError(e)
	}
	providerID, login, e := s.providerAccount(ctx, m.Provider, m.Token)
	if e != nil {
		return nil, rpcError(e)
	}
	var r providerConnectionRecord
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		q := database.New(tx)
		active, e := q.ShareEncryptionPolicy(ctx)
		if e != nil || active != s.keyring.active {
			return errKeyPolicy
		}
		var count int64
		if e = tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_provider_connections WHERE user_id=$1 AND forge_url=$2`, c.UserID, s.config.ForgeURL).Scan(&count); e != nil {
			return errStorageUnavailable
		}
		if count >= 100 {
			return errForgeResponseTooLarge
		}
		binding := providerConnectionBinding(m.ConnectionId)
		plain, _ := json.Marshal(providerSecret{Contract: "golf.personal-provider-connection.v1", ConnectionID: m.ConnectionId, UserID: c.UserID, Forge: s.config.ForgeURL, Provider: m.Provider, ProviderID: providerID, Token: m.Token})
		cipher, key, e := s.keyring.seal(infrastructureConnectionDomain, string(plain), binding)
		if e != nil {
			return e
		}
		r, e = scanProviderConnection(tx.QueryRowContext(ctx, `INSERT INTO golf_provider_connections(id,user_id,forge_url,actor_id,provider,name,provider_account_id,provider_login,encrypted_credential,credential_binding,credential_key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING `+providerConnectionColumns, m.ConnectionId, c.UserID, s.config.ForgeURL, actor.ID, m.Provider, m.Name, providerID, login, cipher, binding, key))
		if e != nil {
			return errStorageUnavailable
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_provider_connection_events(connection_id,version,action) VALUES($1,1,'CREATED')`, r.ID); e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	if _, e = s.ownProviderConnection(ctx, session, token, r.ID, "1", true); e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.CreateProviderConnectionResponse{Connection: providerConnectionWire(r)}), nil
}
func (s *Server) UpdateProviderConnection(ctx context.Context, req *connect.Request[golfv1.UpdateProviderConnectionRequest]) (*connect.Response[golfv1.UpdateProviderConnectionResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if !pullTitle(m.Name) || len(m.Name) > 120 {
		return nil, rpcError(invalid("Use a current connection name up to120 bytes."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	r, e := s.ownProviderConnection(ctx, session, token, m.ConnectionId, m.ExpectedVersion, true)
	if e != nil {
		return nil, rpcError(e)
	}
	e = s.workflowTransaction(ctx, session, r.ActorID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanProviderConnection(tx.QueryRowContext(ctx, `UPDATE golf_provider_connections SET name=$1,revoked=$2,version=version+1 WHERE id=$3 AND user_id=$4 AND forge_url=$5 AND version=$6 AND NOT revoked RETURNING `+providerConnectionColumns, m.Name, m.Revoke, m.ConnectionId, c.UserID, s.config.ForgeURL, r.Version))
		if errors.Is(e, sql.ErrNoRows) {
			return errRepositoryAccessConflict
		}
		if e != nil {
			return errStorageUnavailable
		}
		action := "RENAMED"
		if m.Revoke {
			action = "REVOKED"
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_provider_connection_events(connection_id,version,action) VALUES($1,$2,$3)`, r.ID, r.Version, action); e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	if _, e = s.ownProviderConnection(ctx, session, token, r.ID, strconv.FormatInt(r.Version, 10), false); e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.UpdateProviderConnectionResponse{Connection: providerConnectionWire(r)}), nil
}
func (s *Server) providerImportPreview(ctx context.Context, session string, token forgeCredential, id, version, source string) (result *golfv1.ProviderImportPreview, e error) {
	r, e := s.ownProviderConnection(ctx, session, token, id, version, true)
	if e != nil {
		return nil, e
	}
	canonical, endpoint, e := publicImportURL(source)
	if e != nil || canonical == "" {
		return nil, invalid("Choose an exact canonical GitHub/GitLab source URL.")
	}
	provider := "github"
	origin := "https://api.github.com"
	if strings.HasPrefix(canonical, "https://gitlab.com/") {
		provider = "gitlab"
		origin = "https://gitlab.com/api/v4"
	}
	if provider != r.Provider {
		return nil, invalid("Source and provider connection must match.")
	}
	secret, e := s.providerSecret(r)
	if e != nil {
		return nil, e
	}
	account, login, e := s.providerAccount(ctx, r.Provider, secret)
	if e != nil {
		return nil, e
	}
	if account != r.ProviderID || login != r.Login {
		return nil, errUnauthenticated
	}
	var info struct {
		ID         int64  `json:"id"`
		FullName   string `json:"full_name"`
		Namespace  string `json:"path_with_namespace"`
		Private    *bool  `json:"private"`
		Visibility string `json:"visibility"`
		Clone      string `json:"clone_url"`
		HTTPClone  string `json:"http_url_to_repo"`
		Branch     string `json:"default_branch"`
	}
	if e = s.providerJSON(ctx, provider, secret, strings.TrimPrefix(endpoint, origin), &info); e != nil {
		return nil, e
	}
	path := strings.TrimSuffix(strings.TrimPrefix(canonical, "https://"+provider+".com/"), ".git")
	isPrivate := false
	clone := info.Clone
	fullname := info.FullName
	if provider == "github" {
		if info.Private == nil {
			return nil, errInvalidForgeResponse
		}
		isPrivate = *info.Private
	} else {
		if info.Visibility != "private" && info.Visibility != "internal" && info.Visibility != "public" {
			return nil, errInvalidForgeResponse
		}
		isPrivate = info.Visibility != "public"
		clone = info.HTTPClone
		fullname = info.Namespace
	}
	if info.ID < 1 || clone != canonical || fullname != path || info.Branch == "" || !validRef(info.Branch) || len(info.Branch) > 255 {
		return nil, errInvalidForgeResponse
	}
	branchPath := strings.TrimPrefix(endpoint, origin) + "/branches/" + url.PathEscape(info.Branch)
	if provider == "gitlab" {
		branchPath = strings.TrimPrefix(endpoint, origin) + "/repository/branches/" + url.PathEscape(info.Branch)
	}
	var head struct {
		Name   string `json:"name"`
		Commit struct {
			SHA string `json:"sha"`
			ID  string `json:"id"`
		} `json:"commit"`
	}
	if e = s.providerJSON(ctx, provider, secret, branchPath, &head); e != nil {
		return nil, e
	}
	sha := head.Commit.SHA
	if provider == "gitlab" {
		sha = head.Commit.ID
	}
	if head.Name != info.Branch || !objectID.MatchString(sha) {
		return nil, errInvalidForgeResponse
	}
	result = &golfv1.ProviderImportPreview{ConnectionId: r.ID, ConnectionVersion: strconv.FormatInt(r.Version, 10), SourceUrl: canonical, ProviderRepositoryId: strconv.FormatInt(info.ID, 10), ProviderFullName: fullname, SourcePrivate: isPrivate, DefaultBranch: info.Branch, SourceHeadCommitId: sha}
	result.SourceRevision = resourceHash([]any{r.ID, r.Version, r.ProviderID, canonical, info.ID, fullname, isPrivate, info.Branch, sha})
	if _, e = s.ownProviderConnection(ctx, session, token, id, version, true); e != nil {
		return nil, e
	}
	return result, nil
}
func (s *Server) PreviewProviderImport(ctx context.Context, req *connect.Request[golfv1.PreviewProviderImportRequest]) (*connect.Response[golfv1.PreviewProviderImportResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result, e := s.providerImportPreview(ctx, session, token, req.Msg.ConnectionId, req.Msg.ConnectionVersion, req.Msg.SourceUrl)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.PreviewProviderImportResponse{Preview: result}), nil
}

type providerImportRecord struct {
	ID, UserID, ActorID, Version, RepositoryID                                            int64
	Forge, Operation, Connection, Source, ProviderRepo, Head, Destination, Phase, Failure string
	Fingerprint                                                                           []byte
}

const providerImportColumns = `id,user_id,forge_url,actor_id,operation_id::text,connection_id::text,connection_version,source_url,provider_repository_id,source_head_commit_id,destination_name,input_fingerprint,phase,repository_id,failure_code`

func scanProviderImport(row interface{ Scan(...any) error }) (r providerImportRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.Forge, &r.ActorID, &r.Operation, &r.Connection, &r.Version, &r.Source, &r.ProviderRepo, &r.Head, &r.Destination, &r.Fingerprint, &r.Phase, &r.RepositoryID, &r.Failure)
	return
}
func providerImportFingerprint(m *golfv1.SubmitProviderImportRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitProviderImportRequest)
	c.OperationId = ""
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	h := sha256.Sum256(b)
	return h[:]
}
func providerImportWire(r providerImportRecord) *golfv1.ProviderImportOperation {
	v := &golfv1.ProviderImportOperation{Contract: "golf.provider-import.v1", OperationId: r.Operation, ActorId: strconv.FormatInt(r.ActorID, 10), ConnectionId: r.Connection, ConnectionVersion: strconv.FormatInt(r.Version, 10), SourceUrl: r.Source, ProviderRepositoryId: r.ProviderRepo, SourceHeadCommitId: r.Head, DestinationName: r.Destination, InputSha256: hex.EncodeToString(r.Fingerprint), Phase: golfv1.RepositoryReleasePublicationPhase(golfv1.RepositoryReleasePublicationPhase_value["REPOSITORY_RELEASE_PUBLICATION_PHASE_"+r.Phase]), FailureCode: r.Failure, FidelityUnqualified: []string{"all branches/tags and historical objects", "Git LFS", "issues, pull requests, reviews and comments", "labels, milestones, releases and attachments", "wiki, packages and project boards", "provider identities and attribution mappings", "upstream CI and protected policy migration"}}
	if r.RepositoryID > 0 {
		v.RepositoryId = strconv.FormatInt(r.RepositoryID, 10)
		v.FidelityVerified = []string{"private own-account native destination identity", "independent default branch exact source HEAD"}
	}
	return v
}
func (s *Server) providerImportReceipt(ctx context.Context, session string, token forgeCredential, r providerImportRecord) (repo *Repository, e error) {
	var native User
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID {
			return errUnauthenticated
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	native, e = s.currentUser(ctx, token)
	if e != nil || native.ID != r.ActorID {
		return nil, errUnauthenticated
	}
	if r.RepositoryID > 0 {
		row, e := s.getRepository(ctx, token, repositoryKey{native.Login, r.Destination})
		if e != nil {
			return nil, e
		}
		if row.ID != r.RepositoryID || !row.Private || row.FullName != native.Login+"/"+r.Destination {
			return nil, errResourceNotFound
		}
		repo = &row
	}
	return
}
func (s *Server) GetProviderImport(ctx context.Context, req *connect.Request[golfv1.GetProviderImportRequest]) (*connect.Response[golfv1.GetProviderImportResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	if !creationKey.MatchString(req.Msg.OperationId) {
		return nil, rpcError(invalid("Inspect the original provider import UUID."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r providerImportRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanProviderImport(s.db.QueryRowContext(ctx, `SELECT `+providerImportColumns+` FROM golf_provider_import_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, req.Msg.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	repo, e := s.providerImportReceipt(ctx, session, token, r)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetProviderImportResponse{Operation: providerImportWire(r), Repository: wireOptionalRepository(repo)}), nil
}
func wireOptionalRepository(r *Repository) *golfv1.Repository {
	if r == nil {
		return nil
	}
	return wireRepository(*r)
}
func validateProviderImport(m *golfv1.SubmitProviderImportRequest) error {
	p := m.Preview
	if p == nil || !creationKey.MatchString(p.ConnectionId) || !creationKey.MatchString(m.OperationId) || !repositoryName.MatchString(m.DestinationName) || !discussionText(m.Description, 2000) || !validAccessRevision(p.SourceRevision) || !objectID.MatchString(p.SourceHeadCommitId) || !validRef(p.DefaultBranch) {
		return invalid("Bind an exact provider preview, original import UUID and safe destination metadata.")
	}
	if _, e := discussionID(p.ConnectionVersion); e != nil {
		return e
	}
	if _, e := discussionID(p.ProviderRepositoryId); e != nil {
		return e
	}
	canonical, _, e := publicImportURL(p.SourceUrl)
	if e != nil || canonical == "" || canonical != p.SourceUrl {
		return invalid("Use the exact canonical preview URL.")
	}
	return nil
}
func (s *Server) SubmitProviderImport(ctx context.Context, req *connect.Request[golfv1.SubmitProviderImportRequest]) (*connect.Response[golfv1.SubmitProviderImportResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateProviderImport(m); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, rpcError(e)
	}
	version, _ := discussionID(m.Preview.ConnectionVersion)
	fp := providerImportFingerprint(m)
	var r providerImportRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanProviderImport(tx.QueryRowContext(ctx, `SELECT `+providerImportColumns+` FROM golf_provider_import_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(r.Fingerprint, fp) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		var connection providerConnectionRecord
		connection, e = scanProviderConnection(tx.QueryRowContext(ctx, `SELECT `+providerConnectionColumns+` FROM golf_provider_connections WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND NOT revoked AND version=$4 FOR UPDATE`, m.Preview.ConnectionId, c.UserID, s.config.ForgeURL, version))
		if e != nil || connection.ActorID != actor.ID {
			return errResourceNotFound
		}
		r, e = scanProviderImport(tx.QueryRowContext(ctx, `INSERT INTO golf_provider_import_operations(user_id,forge_url,actor_id,operation_id,connection_id,connection_version,source_url,provider_repository_id,source_head_commit_id,destination_name,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING `+providerImportColumns, c.UserID, s.config.ForgeURL, actor.ID, m.OperationId, connection.ID, version, m.Preview.SourceUrl, m.Preview.ProviderRepositoryId, m.Preview.SourceHeadCommitId, m.DestinationName, fp))
		if e != nil {
			return errStorageUnavailable
		}
		fresh = true
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	if fresh {
		observed, e := s.providerImportPreview(ctx, session, token, m.Preview.ConnectionId, m.Preview.ConnectionVersion, m.Preview.SourceUrl)
		phase, failure := "DISPATCH_UNKNOWN", ""
		if e != nil || !proto.Equal(observed, m.Preview) {
			phase, failure = "REJECTED", "preflight_refused"
		}
		e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
			if c.UserID != r.UserID {
				return errUnauthenticated
			}
			if _, e := tx.ExecContext(ctx, `UPDATE golf_provider_import_operations SET phase=$1,failure_code=$2 WHERE id=$3 AND phase='RESERVED'`, phase, failure, r.ID); e != nil {
				return errStorageUnavailable
			}
			r.Phase, r.Failure = phase, failure
			return nil
		})
		if e != nil {
			return nil, rpcError(e)
		}
		if phase == "DISPATCH_UNKNOWN" {
			connection, e := s.ownProviderConnection(ctx, session, token, r.Connection, strconv.FormatInt(r.Version, 10), true)
			if e != nil {
				return nil, rpcError(e)
			}
			providerToken, e := s.providerSecret(connection)
			if e != nil {
				return nil, rpcError(e)
			}
			observed, e = s.providerImportPreview(ctx, session, token, connection.ID, strconv.FormatInt(connection.Version, 10), r.Source)
			if e == nil && proto.Equal(observed, m.Preview) {
				var result struct {
					Repository
					Owner *User `json:"owner"`
				}
				authUser := "x-access-token"
				if connection.Provider == "gitlab" {
					authUser = "oauth2"
				}
				// Explicit trust boundary: this credential is supplied only to the configured,
				// privileged native forge for this one supported nonmirror Git clone. It is
				// never a URL, journal field, execution-job credential or model input.
				payload := map[string]any{"clone_addr": r.Source, "repo_owner": actor.Login, "repo_name": r.Destination, "description": m.Description, "private": true, "mirror": false, "service": "git"}
				if m.Preview.SourcePrivate {
					payload["auth_username"] = authUser
					payload["auth_password"] = providerToken
				}
				_, e = s.forgeJSON(ctx, http.MethodPost, "/repos/migrate", token, payload, &result, http.StatusCreated)
				if e == nil && result.ID > 0 && result.Owner != nil && result.Owner.ID == actor.ID && result.Private && result.Name == r.Destination && result.FullName == actor.Login+"/"+r.Destination {
					key := repositoryKey{actor.Login, r.Destination}
					base, _ := repositoryPath(key)
					native, e := s.getRepository(ctx, token, key)
					if e == nil && native.ID == result.ID && native.Private && native.DefaultBranch == m.Preview.DefaultBranch {
						var branch struct {
							Name   string `json:"name"`
							Commit struct {
								ID string `json:"id"`
							} `json:"commit"`
						}
						_, e = s.forge(ctx, http.MethodGet, base+"/branches/"+url.PathEscape(native.DefaultBranch), token, nil, &branch)
						if e == nil && branch.Name == native.DefaultBranch && branch.Commit.ID == r.Head {
							if _, e = s.ownProviderConnection(ctx, session, token, connection.ID, strconv.FormatInt(connection.Version, 10), true); e == nil {
								e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
									if c.UserID != r.UserID {
										return errUnauthenticated
									}
									var current int64
									if e := tx.QueryRowContext(ctx, `SELECT version FROM golf_provider_connections WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND NOT revoked FOR SHARE`, connection.ID, c.UserID, s.config.ForgeURL).Scan(&current); e != nil || current != r.Version {
										return errRepositoryAccessConflict
									}
									if _, e = tx.ExecContext(ctx, `UPDATE golf_provider_import_operations SET phase='SUCCEEDED',repository_id=$1 WHERE id=$2 AND phase='DISPATCH_UNKNOWN'`, result.ID, r.ID); e != nil {
										return errStorageUnavailable
									}
									r.Phase, r.RepositoryID = "SUCCEEDED", result.ID
									return nil
								})
								if e != nil {
									return nil, rpcError(e)
								}
							}
						}
					}
				}
			}
		}
	}
	repo, e := s.providerImportReceipt(ctx, session, token, r)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.SubmitProviderImportResponse{Operation: providerImportWire(r), Repository: wireOptionalRepository(repo)}), nil
}

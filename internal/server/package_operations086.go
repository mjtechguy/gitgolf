package server

import (
	"bytes"
	"connectrpc.com/connect"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"time"
)

var genericPackageName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$`)

func (s *Server) packagePublicationAccess(ctx context.Context, session string, token forgeCredential, key repositoryKey, id string) (actor User, access *golfv1.RepositoryAccess, publicAck bool, allowed bool, reason string, e error) {
	e = s.withForgeCaller(ctx, session, token, func(user User) error {
		actor = user
		var e error
		access, e = s.rulesAuthority(ctx, token, key, user)
		if e != nil {
			return e
		}
		if access.RepositoryId != id {
			return errResourceNotFound
		}
		var settings struct {
			ID          int64 `json:"id"`
			Private     bool  `json:"private"`
			HasPackages *bool `json:"has_packages"`
			Archived    *bool `json:"archived"`
			Mirror      *bool `json:"mirror"`
		}
		base, _ := repositoryPath(key)
		if _, e = s.forge(ctx, http.MethodGet, base, token, nil, &settings); e != nil {
			return e
		}
		if settings.ID != mustID(id) || settings.HasPackages == nil || !*settings.HasPackages || settings.Archived == nil || *settings.Archived || settings.Mirror == nil || *settings.Mirror {
			return errRepositoryAccessConflict
		}
		if access.OrganizationOwned || access.OwnerId != strconv.FormatInt(user.ID, 10) {
			reason = "Generic publication currently requires the repository's personal native owner. Organization package access is not repository-scoped."
			return nil
		}
		var owner struct {
			User
			Visibility string `json:"visibility"`
		}
		if _, e = s.forge(ctx, http.MethodGet, "/users/"+url.PathEscape(key.Owner), token, nil, &owner); e != nil {
			return e
		}
		if owner.ID != user.ID || owner.Login != key.Owner || (owner.Visibility != "public" && owner.Visibility != "private" && owner.Visibility != "limited") {
			return errInvalidForgeResponse
		}
		publicAck = owner.Visibility != "private"
		if settings.Private && owner.Visibility != "private" {
			reason = "Private repository publication is blocked: this native owner namespace does not restrict packages to its owner independently of repository privacy."
			return nil
		}
		allowed = true
		reason = "Generic package access follows the native owner namespace, independently of repository permissions."
		return nil
	})
	return
}
func (s *Server) GetPackagePublicationAccess(ctx context.Context, req *connect.Request[golfv1.GetPackagePublicationAccessRequest]) (*connect.Response[golfv1.GetPackagePublicationAccessResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, access, ack, allowed, reason, e := s.packagePublicationAccess(ctx, session, token, keyFrom(req.Msg.Repository), req.Msg.RepositoryId)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetPackagePublicationAccessResponse{Access: access, Allowed: allowed, Reason: reason, PublicNamespaceAcknowledgementRequired: ack}), nil
}
func packagePublicationFingerprint(m *golfv1.SubmitPackagePublicationRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitPackagePublicationRequest)
	c.OperationId = ""
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	h := sha256.Sum256(b)
	return h[:]
}
func validatePackagePublication(m *golfv1.SubmitPackagePublicationRequest) error {
	if e := validateRepositoryAccess(keyFrom(m.Repository), m.RepositoryId, m.OwnerId, m.AccessRevision, ""); e != nil {
		return e
	}
	if !creationKey.MatchString(m.OperationId) || !genericPackageName.MatchString(m.PackageName) || !genericPackageName.MatchString(m.Version) || !genericPackageName.MatchString(m.FileName) || len(m.Content) > 256<<10 {
		return invalid("Use an original UUID and safe generic package/version/file names; uploads support at most256 KiB.")
	}
	return nil
}

type packagePublicationRecord struct {
	ID, UserID, ActorID, RepoID, OwnerID, Size, PackageID, FileID                             int64
	Forge, Operation, Owner, Name, Access, Package, Version, File, ContentSHA, Phase, Failure string
	Fingerprint                                                                               []byte
}

const packagePublicationColumns = `id,user_id,forge_url,actor_id,operation_id::text,repository_owner,repository_name,repository_id,owner_id,access_revision,package_name,version,file_name,input_fingerprint,content_sha256,content_size,phase,result_package_id,result_file_id,failure_code`

func scanPackagePublication(row interface{ Scan(...any) error }) (r packagePublicationRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.Forge, &r.ActorID, &r.Operation, &r.Owner, &r.Name, &r.RepoID, &r.OwnerID, &r.Access, &r.Package, &r.Version, &r.File, &r.Fingerprint, &r.ContentSHA, &r.Size, &r.Phase, &r.PackageID, &r.FileID, &r.Failure)
	return
}
func packagePublicationWire(r packagePublicationRecord) *golfv1.PackagePublicationOperation {
	v := &golfv1.PackagePublicationOperation{Contract: "golf.generic-package-publication.v1", OperationId: r.Operation, ActorId: strconv.FormatInt(r.ActorID, 10), Repository: &golfv1.RepositoryKey{Owner: r.Owner, Name: r.Name}, RepositoryId: strconv.FormatInt(r.RepoID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), PackageName: r.Package, Version: r.Version, FileName: r.File, InputSha256: hex.EncodeToString(r.Fingerprint), ContentSha256: r.ContentSHA, SizeBytes: strconv.FormatInt(r.Size, 10), Phase: golfv1.RepositoryReleasePublicationPhase(golfv1.RepositoryReleasePublicationPhase_value["REPOSITORY_RELEASE_PUBLICATION_PHASE_"+r.Phase]), FailureCode: r.Failure}
	if r.PackageID > 0 {
		v.ResultPackageId = strconv.FormatInt(r.PackageID, 10)
		v.ResultFileId = strconv.FormatInt(r.FileID, 10)
	}
	return v
}
func (s *Server) packagePublicationAuthority(ctx context.Context, session string, token forgeCredential, r packagePublicationRecord) error {
	actor, access, _, allowed, _, e := s.packagePublicationAccess(ctx, session, token, repositoryKey{r.Owner, r.Name}, strconv.FormatInt(r.RepoID, 10))
	if e != nil {
		return e
	}
	if actor.ID != r.ActorID || access.OwnerId != strconv.FormatInt(r.OwnerID, 10) || !allowed {
		return errResourceNotFound
	}
	return nil
}
func (s *Server) genericPackageVersions(ctx context.Context, token forgeCredential, owner, name string) ([]nativePackage, error) {
	var rows []nativePackage
	_, e := s.forge(ctx, http.MethodGet, "/packages/"+url.PathEscape(owner)+"/generic/"+url.PathEscape(name)+"?page=1&limit=2", token, nil, &rows)
	var native forgeError
	if errors.As(e, &native) && native.status == http.StatusNotFound {
		return []nativePackage{}, nil
	}
	if e != nil {
		return nil, e
	}
	if rows == nil || len(rows) > 2 {
		return nil, errInvalidForgeResponse
	}
	return rows, nil
}
func (s *Server) packagePublicationPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitPackagePublicationRequest) error {
	_, access, ack, allowed, _, e := s.packagePublicationAccess(ctx, session, token, keyFrom(m.Repository), m.RepositoryId)
	if e != nil {
		return e
	}
	if !allowed || access.OwnerId != m.OwnerId || access.Revision != m.AccessRevision || ack && !m.PublicNamespaceAcknowledged {
		return forgeError{http.StatusForbidden}
	}
	rows, e := s.genericPackageVersions(ctx, token, m.Repository.Owner, m.PackageName)
	if e != nil {
		return e
	}
	if len(rows) != 0 {
		return errRepositoryAccessConflict
	}
	return nil
}
func (s *Server) genericPackageBytes(ctx context.Context, token forgeCredential, owner, name, version, file string, max int64) ([]byte, error) {
	if token.Token == "" || token.Kind != "pat" && token.Kind != "oauth" || !genericPackageName.MatchString(name) || !genericPackageName.MatchString(version) || !releaseAssetName(file) {
		return nil, errCredentialUnavailable
	}
	endpoint := s.config.GiteaURL + "/api/packages/" + url.PathEscape(owner) + "/generic/" + url.PathEscape(name) + "/" + url.PathEscape(version) + "/" + url.PathEscape(file)
	r, e := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if e != nil {
		return nil, errInvalidForgeResponse
	}
	scheme := "token"
	if token.Kind == "oauth" {
		scheme = "Bearer"
	}
	r.Header.Set("Authorization", scheme+" "+token.Token)
	r.Header.Set("Accept", "application/octet-stream")
	response, e := s.client.Do(r)
	if e != nil {
		return nil, errForgeUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, forgeError{response.StatusCode}
	}
	if response.ContentLength > max {
		return nil, errForgeResponseTooLarge
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, max+1))
	if e != nil {
		return nil, errForgeUnavailable
	}
	if int64(len(data)) > max {
		return nil, errForgeResponseTooLarge
	}
	return data, nil
}
func (s *Server) DownloadGenericPackageFile(ctx context.Context, req *connect.Request[golfv1.DownloadGenericPackageFileRequest]) (*connect.Response[golfv1.DownloadGenericPackageFileResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	m := req.Msg
	p := m.Package
	if p == nil || p.Type != "generic" || !genericPackageName.MatchString(p.Name) || !genericPackageName.MatchString(p.Version) {
		return nil, rpcError(invalid("Choose a supported generic package version."))
	}
	if _, e = discussionID(p.Id); e != nil {
		return nil, rpcError(e)
	}
	if _, e = discussionID(m.FileId); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.DownloadGenericPackageFileResponse{RepositoryId: m.RepositoryId, PackageId: p.Id, FileId: m.FileId}
	e = s.withPackageRead(ctx, s.cookieValue(req.Header()), token, keyFrom(m.Repository), m.RepositoryId, func(base string, repo Repository, ownerID int64) error {
		path := base + "/generic/" + url.PathEscape(p.Name) + "/" + url.PathEscape(p.Version)
		var row nativePackage
		if _, e := s.forge(ctx, http.MethodGet, path, token, nil, &row); e != nil {
			return e
		}
		wire, e := packageWire(row, repo, ownerID)
		if e != nil || wire.Id != p.Id || wire.Name != p.Name || wire.Version != p.Version {
			return errResourceNotFound
		}
		var files []nativeGenericFile
		if _, e = s.forge(ctx, http.MethodGet, path+"/files", token, nil, &files); e != nil {
			return e
		}
		if files == nil || len(files) > 1000 {
			return errInvalidForgeResponse
		}
		var found *nativeGenericFile
		for i := range files {
			f := &files[i]
			if strconv.FormatInt(f.ID, 10) == m.FileId {
				if found != nil {
					return errInvalidForgeResponse
				}
				found = f
			}
		}
		if found == nil || found.Size == nil || *found.Size < 0 || *found.Size > repositoryReleaseAssetMaxBytes || !releaseAssetName(found.Name) || !validAccessRevision(found.SHA256) {
			return errResourceNotFound
		}
		data, e := s.genericPackageBytes(ctx, token, m.Repository.Owner, p.Name, p.Version, found.Name, repositoryReleaseAssetMaxBytes)
		if e != nil {
			return e
		}
		if int64(len(data)) != *found.Size || releasePublicationTextHash(string(data)) != found.SHA256 {
			return errInvalidForgeResponse
		}
		var after nativePackage
		if _, e = s.forge(ctx, http.MethodGet, path, token, nil, &after); e != nil {
			return e
		}
		if !reflect.DeepEqual(row, after) {
			return errPullSnapshotChanged
		}
		var repeat []nativeGenericFile
		if _, e = s.forge(ctx, http.MethodGet, path+"/files", token, nil, &repeat); e != nil {
			return e
		}
		if !reflect.DeepEqual(files, repeat) {
			return errPullSnapshotChanged
		}
		result.FileName, result.Sha256, result.Content = found.Name, found.SHA256, data
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(result), nil
}

type nativeGenericFile struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Size   *int64 `json:"size"`
	SHA256 string `json:"sha256"`
}

func (s *Server) GetPackagePublication(ctx context.Context, req *connect.Request[golfv1.GetPackagePublicationRequest]) (*connect.Response[golfv1.GetPackagePublicationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if _, e = repositoryPath(keyFrom(m.Repository)); e != nil {
		return nil, rpcError(e)
	}
	for _, id := range []string{m.RepositoryId, m.OwnerId} {
		if _, e = discussionID(id); e != nil {
			return nil, rpcError(e)
		}
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, rpcError(invalid("Inspect the original publication UUID."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r packagePublicationRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanPackagePublication(s.db.QueryRowContext(ctx, `SELECT `+packagePublicationColumns+` FROM golf_package_publications WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e == nil && (r.Owner != m.Repository.Owner || r.Name != m.Repository.Name || strconv.FormatInt(r.RepoID, 10) != m.RepositoryId || strconv.FormatInt(r.OwnerID, 10) != m.OwnerId) {
		e = errResourceNotFound
	}
	if e == nil {
		e = s.packagePublicationAuthority(ctx, session, token, r)
	}
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetPackagePublicationResponse{Operation: packagePublicationWire(r)}), nil
}
func (s *Server) SubmitPackagePublication(ctx context.Context, req *connect.Request[golfv1.SubmitPackagePublicationRequest]) (*connect.Response[golfv1.SubmitPackagePublicationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validatePackagePublication(m); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, access, _, allowed, _, e := s.packagePublicationAccess(ctx, session, token, keyFrom(m.Repository), m.RepositoryId)
	if e != nil {
		return nil, rpcError(e)
	}
	if !allowed || access.OwnerId != m.OwnerId {
		return nil, rpcError(forgeError{http.StatusForbidden})
	}
	repoID, _ := discussionID(m.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	fp := packagePublicationFingerprint(m)
	var r packagePublicationRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockWikiOperation(ctx, tx, repoID)
		if e != nil {
			return e
		}
		if _, e := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, s.config.GiteaURL+"/package-name/"+m.OwnerId+"/"+m.PackageName); e != nil {
			return errStorageUnavailable
		}
		r, e = scanPackagePublication(tx.QueryRowContext(held, `SELECT `+packagePublicationColumns+` FROM golf_package_publications WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(r.Fingerprint, fp) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanPackagePublication(tx.QueryRowContext(held, `INSERT INTO golf_package_publications(user_id,forge_url,actor_id,operation_id,repository_owner,repository_name,repository_id,owner_id,access_revision,package_name,version,file_name,input_fingerprint,content_sha256,content_size) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING `+packagePublicationColumns, c.UserID, s.config.GiteaURL, actor.ID, m.OperationId, m.Repository.Owner, m.Repository.Name, repoID, ownerID, m.AccessRevision, m.PackageName, m.Version, m.FileName, fp, releasePublicationTextHash(string(m.Content)), len(m.Content)))
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
		phase, failure := "DISPATCH_UNKNOWN", ""
		if e = s.packagePublicationPreflight(ctx, session, token, m); e != nil {
			phase, failure = "REJECTED", "preflight_refused"
		}
		e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
			held, e := s.lockWikiOperation(ctx, tx, repoID)
			if e != nil {
				return e
			}
			if c.UserID != r.UserID {
				return errUnauthenticated
			}
			if e = s.packagePublicationAuthority(held, session, token, r); e != nil {
				return e
			}
			if _, e = tx.ExecContext(held, `UPDATE golf_package_publications SET phase=$1,failure_code=$2 WHERE id=$3 AND phase='RESERVED'`, phase, failure, r.ID); e != nil {
				return errStorageUnavailable
			}
			r.Phase, r.Failure = phase, failure
			return nil
		})
		if e != nil {
			return nil, rpcError(e)
		}
		if phase == "DISPATCH_UNKNOWN" {
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				held, e := s.lockWikiOperation(ctx, tx, repoID)
				if e != nil {
					return e
				}
				if c.UserID != r.UserID {
					return errUnauthenticated
				}
				if e = s.packagePublicationPreflight(held, session, token, m); e != nil {
					return e
				}
				var blocked bool
				if e = tx.QueryRowContext(held, `SELECT golf_repository_lifecycle_blocked_before_package_publication($1,$2) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.Forge, r.RepoID).Scan(&blocked); e != nil {
					return errStorageUnavailable
				}
				if blocked {
					return errLifecycleBlocked
				}
				if e = s.protectionDispatchAllowed(held, tx, r.RepoID); e != nil {
					return e
				}
				if _, e = tx.ExecContext(held, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, r.Forge+"/package-name/"+strconv.FormatInt(r.OwnerID, 10)+"/"+r.Package); e != nil {
					return errStorageUnavailable
				}
				endpoint := s.config.GiteaURL + "/api/packages/" + url.PathEscape(r.Owner) + "/generic/" + url.PathEscape(r.Package) + "/" + url.PathEscape(r.Version) + "/" + url.PathEscape(r.File)
				request, e := http.NewRequestWithContext(held, http.MethodPut, endpoint, bytes.NewReader(m.Content))
				if e != nil {
					return errInvalidForgeResponse
				}
				scheme := "token"
				if token.Kind == "oauth" {
					scheme = "Bearer"
				}
				request.Header.Set("Authorization", scheme+" "+token.Token)
				request.Header.Set("Content-Type", "application/octet-stream")
				response, e := s.client.Do(request)
				if e != nil {
					return nil
				}
				response.Body.Close()
				if response.StatusCode != http.StatusCreated {
					return nil
				}
				versions, e := s.genericPackageVersions(held, token, r.Owner, r.Package)
				if e != nil || len(versions) != 1 {
					return nil
				}
				v := versions[0]
				if v.ID < 1 || v.Name != r.Package || v.Type != "generic" || v.Version != r.Version || v.Owner == nil || v.Owner.ID != r.OwnerID || v.Creator == nil || v.Creator.ID != r.ActorID || v.Repository != nil {
					return nil
				}
				if e = s.packagePublicationAuthority(held, session, token, r); e != nil {
					return nil
				}
				if e = s.protectionDispatchAllowed(held, tx, r.RepoID); e != nil {
					return nil
				}
				path := "/packages/" + url.PathEscape(r.Owner) + "/generic/" + url.PathEscape(r.Package)
				if _, e = s.forgeJSON(held, http.MethodPost, path+"/-/link/"+url.PathEscape(r.Name), token, nil, nil, http.StatusCreated); e != nil {
					return nil
				}
				var linked nativePackage
				if _, e = s.forge(held, http.MethodGet, path+"/"+url.PathEscape(r.Version), token, nil, &linked); e != nil {
					return nil
				}
				repo, e := s.getRepository(held, token, repositoryKey{r.Owner, r.Name})
				if e != nil {
					return nil
				}
				wire, e := packageWire(linked, repo, r.OwnerID)
				if e != nil || wire.Id != strconv.FormatInt(v.ID, 10) {
					return nil
				}
				var files []nativeGenericFile
				if _, e = s.forge(held, http.MethodGet, path+"/"+url.PathEscape(r.Version)+"/files", token, nil, &files); e != nil || len(files) != 1 || files[0].ID < 1 || files[0].Name != r.File || files[0].Size == nil || *files[0].Size != r.Size || files[0].SHA256 != r.ContentSHA {
					return nil
				}
				data, e := s.genericPackageBytes(held, token, r.Owner, r.Package, r.Version, r.File, 256<<10)
				if e != nil || !bytes.Equal(data, m.Content) {
					return nil
				}
				if e = s.packagePublicationAuthority(held, session, token, r); e != nil {
					return nil
				}
				if _, e = tx.ExecContext(held, `UPDATE golf_package_publications SET phase='SUCCEEDED',result_package_id=$1,result_file_id=$2 WHERE id=$3 AND phase='DISPATCH_UNKNOWN'`, v.ID, files[0].ID, r.ID); e != nil {
					return errStorageUnavailable
				}
				r.Phase, r.PackageID, r.FileID = "SUCCEEDED", v.ID, files[0].ID
				return nil
			})
			if e != nil {
				return nil, rpcError(e)
			}
		}
	}
	if e = s.packagePublicationAuthority(ctx, session, token, r); e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.SubmitPackagePublicationResponse{Operation: packagePublicationWire(r)}), nil
}

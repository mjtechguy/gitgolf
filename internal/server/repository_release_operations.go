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
	"mime/multipart"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

const releaseOperationContract = "golf.repository.release-operation.v1"
const releaseUploadMaxBytes = 256 << 10

// Download counts are mutable read side effects, never revision identity.
func releaseRevision(row forgeRepositoryRelease) string {
	ordered := append([]forgeReleaseAsset{}, row.Assets...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	assets := make([]any, 0, len(ordered))
	for _, a := range ordered {
		assets = append(assets, []any{a.ID, a.Name, a.Size, a.CreatedAt})
	}
	actor := int64(0)
	if row.Author != nil {
		actor = row.Author.ID
	}
	return resourceHash([]any{row.ID, row.Title, row.TagName, row.TargetCommitish, row.Body, row.Draft, row.Prerelease, row.CreatedAt, row.PublishedAt, actor, assets})
}
func releaseOperationFingerprint(m *golfv1.SubmitRepositoryReleaseOperationRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitRepositoryReleaseOperationRequest)
	c.OperationId = ""
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	h := sha256.Sum256(b)
	return h[:]
}
func validReleaseRevision(v string) bool { return validAccessRevision(v) }
func releaseAssetName(name string) bool {
	return name != "" && strings.TrimSpace(name) == name && name != "." && name != ".." && len(name) <= 255 && profileText(name, 255, false) && !strings.ContainsAny(name, "/\\")
}
func validateReleaseOperation(m *golfv1.SubmitRepositoryReleaseOperationRequest) error {
	if e := validateRepositoryAccess(keyFrom(m.Repository), m.RepositoryId, m.OwnerId, m.AccessRevision, ""); e != nil {
		return e
	}
	if _, e := discussionID(m.ReleaseId); e != nil {
		return e
	}
	if !creationKey.MatchString(m.OperationId) || !validReleaseRevision(m.ExpectedRevision) {
		return invalid("Bind the original operation and release revision.")
	}
	k := int32(m.Kind)
	if k < 1 || k > 5 {
		return invalid("Select a supported release operation.")
	}
	if k == 1 {
		if !pullTitle(m.Title) || len(m.Title) > 255 || !discussionText(m.BodyMarkdown, 16<<10) {
			return invalid("Use a trimmed release title and notes of at most 16 KiB.")
		}
	} else if m.Title != "" || m.BodyMarkdown != "" || m.Draft || m.Prerelease {
		return invalid("Only release edits accept replacement release metadata.")
	}
	if k == 4 || k == 5 {
		if _, e := discussionID(m.AssetId); e != nil {
			return e
		}
	} else if m.AssetId != "" {
		return invalid("Only existing asset operations accept an asset identity.")
	}
	if k == 3 || k == 4 {
		if !releaseAssetName(m.AssetName) {
			return invalid("Use a filename of at most255 bytes without path separators.")
		}
	} else if m.AssetName != "" {
		return invalid("This operation cannot rename an asset.")
	}
	if k == 3 {
		if len(m.AssetContent) > releaseUploadMaxBytes {
			return invalid("Asset uploads are limited to256 KiB.")
		}
	} else if len(m.AssetContent) > 0 {
		return invalid("Only uploads accept file bytes.")
	}
	return nil
}

type releaseOperationRecord struct {
	ID, UserID, ActorID, RepositoryID, OwnerID, ReleaseID, AssetID, ResultAssetID        int64
	ForgeURL, OperationID, Owner, Name, AccessRevision, ExpectedRevision, Phase, Failure string
	Kind                                                                                 int32
	Fingerprint                                                                          []byte
	Created, Updated                                                                     time.Time
}

const releaseOperationColumns = `id,user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,access_revision,release_id,asset_id,kind,expected_revision,input_fingerprint,phase,result_asset_id,failure_code,created_at,updated_at`

func scanReleaseOperation(row interface{ Scan(...any) error }) (r releaseOperationRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ForgeURL, &r.ActorID, &r.OperationID, &r.RepositoryID, &r.OwnerID, &r.Owner, &r.Name, &r.AccessRevision, &r.ReleaseID, &r.AssetID, &r.Kind, &r.ExpectedRevision, &r.Fingerprint, &r.Phase, &r.ResultAssetID, &r.Failure, &r.Created, &r.Updated)
	return
}
func releaseOperationWire(r releaseOperationRecord) *golfv1.RepositoryReleaseOperation {
	v := &golfv1.RepositoryReleaseOperation{Contract: releaseOperationContract, OperationId: r.OperationID, Repository: &golfv1.RepositoryKey{Owner: r.Owner, Name: r.Name}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), ActorId: strconv.FormatInt(r.ActorID, 10), ReleaseId: strconv.FormatInt(r.ReleaseID, 10), Kind: golfv1.RepositoryReleaseOperationKind(r.Kind), ExpectedRevision: r.ExpectedRevision, InputSha256: hex.EncodeToString(r.Fingerprint), Phase: golfv1.RepositoryReleasePublicationPhase(golfv1.RepositoryReleasePublicationPhase_value["REPOSITORY_RELEASE_PUBLICATION_PHASE_"+r.Phase]), FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}
	if r.AssetID > 0 {
		v.AssetId = strconv.FormatInt(r.AssetID, 10)
	}
	if r.ResultAssetID > 0 {
		v.AssetId = strconv.FormatInt(r.ResultAssetID, 10)
	}
	return v
}
func (s *Server) lockReleaseOperation(ctx context.Context, tx *sql.Tx, id int64) (context.Context, error) {
	if _, e := tx.ExecContext(ctx, `SELECT golf_release_operation_lock($1,$2)`, s.config.GiteaURL, id); e != nil {
		return nil, errStorageUnavailable
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.GiteaURL, id, tx}), nil
}
func (s *Server) releaseOperationAuthority(ctx context.Context, session string, token forgeCredential, r releaseOperationRecord) error {
	actor, e := s.releasePublicationAuthority(ctx, session, token, repositoryKey{r.Owner, r.Name}, strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10))
	if e != nil {
		return e
	}
	if actor.ID != r.ActorID {
		return errUnauthenticated
	}
	return nil
}
func (s *Server) releaseOperationReceiptAuthority(ctx context.Context, session string, token forgeCredential, r releaseOperationRecord) error {
	return s.withForgeCaller(ctx, session, token, func(actor User) error {
		if actor.ID != r.ActorID {
			return errUnauthenticated
		}
		access, e := s.readRepositoryAccess(ctx, token, repositoryKey{r.Owner, r.Name}, actor)
		if e != nil {
			return e
		}
		return accessMatches(access, strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10), r.AccessRevision)
	})
}
func (s *Server) releaseOperationPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitRepositoryReleaseOperationRequest) (row forgeRepositoryRelease, e error) {
	actor, e := s.releasePublicationAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	if e != nil {
		return row, e
	}
	e = s.withRepositoryRead(ctx, session, token, keyFrom(m.Repository), func(base string, repo Repository) error {
		access, e := s.readRepositoryAccess(ctx, token, keyFrom(m.Repository), actor)
		if e != nil {
			return e
		}
		if e = accessMatches(access, m.RepositoryId, m.OwnerId, m.AccessRevision); e != nil {
			return e
		}
		var config struct {
			forgeRepositorySettings
			HasReleases *bool `json:"has_releases"`
		}
		if _, e = s.forge(ctx, http.MethodGet, base, token, nil, &config); e != nil {
			return e
		}
		if _, e = wireRepositorySettings(config.forgeRepositorySettings, keyFrom(m.Repository)); e != nil {
			return e
		}
		if config.ID != repo.ID || config.HasReleases == nil || !*config.HasReleases || *config.Archived || *config.Mirror {
			return errReleasePublicationUnavailable
		}
		if _, e = s.forge(ctx, http.MethodGet, base+"/releases/"+m.ReleaseId, token, nil, &row); e != nil {
			return e
		}
		if _, e = wireRepositoryRelease(row); e != nil {
			return e
		}
		if strconv.FormatInt(row.ID, 10) != m.ReleaseId || releaseRevision(row) != m.ExpectedRevision {
			return errRepositoryAccessConflict
		}
		found := false
		for _, a := range row.Assets {
			if strconv.FormatInt(a.ID, 10) == m.AssetId {
				found = true
			}
			if (int32(m.Kind) == 3 || int32(m.Kind) == 4) && a.Name == m.AssetName && strconv.FormatInt(a.ID, 10) != m.AssetId {
				return errRepositoryAccessConflict
			}
		}
		if (int32(m.Kind) == 4 || int32(m.Kind) == 5) && !found {
			return errResourceNotFound
		}
		if int32(m.Kind) == 3 && len(row.Assets) >= 100 {
			return errForgeResponseTooLarge
		}
		return nil
	})
	if e == nil {
		_, e = s.releasePublicationAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	}
	return
}
func releaseOperationNative(m *golfv1.SubmitRepositoryReleaseOperationRequest) (method, suffix string, payload any) {
	suffix = "/releases/" + m.ReleaseId
	switch int32(m.Kind) {
	case 1:
		return http.MethodPatch, suffix, map[string]any{"name": m.Title, "body": m.BodyMarkdown, "draft": m.Draft, "prerelease": m.Prerelease}
	case 2:
		return http.MethodDelete, suffix, nil
	case 3:
		return http.MethodPost, suffix + "/assets", map[string]any{"name": m.AssetName, "size": len(m.AssetContent), "sha256": releasePublicationTextHash(string(m.AssetContent))}
	case 4:
		return http.MethodPatch, suffix + "/assets/" + m.AssetId, map[string]string{"name": m.AssetName}
	default:
		return http.MethodDelete, suffix + "/assets/" + m.AssetId, nil
	}
}

type releaseOperationPermitKey struct{}
type releaseOperationPermit struct {
	record  releaseOperationRecord
	request *golfv1.SubmitRepositoryReleaseOperationRequest
}

func (s *Server) validateReleaseOperationPermit(ctx context.Context, tx *sql.Tx, p releaseOperationPermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	want, suffix, payload := releaseOperationNative(p.request)
	base, _ := repositoryPath(key)
	if tx == nil || repo.ID != r.RepositoryID || key.Owner != r.Owner || key.Name != r.Name || method != want || path != base+suffix || !bytes.Equal(r.Fingerprint, releaseOperationFingerprint(p.request)) {
		return errLifecycleBlocked
	}
	a, e := json.Marshal(input)
	b, f := json.Marshal(payload)
	if e != nil || f != nil || !bytes.Equal(a, b) {
		return errLifecycleBlocked
	}
	row, e := scanReleaseOperation(tx.QueryRowContext(ctx, `SELECT `+releaseOperationColumns+` FROM golf_repository_release_operations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, r.ForgeURL))
	if e != nil || row.ActorID != r.ActorID || !bytes.Equal(row.Fingerprint, r.Fingerprint) {
		return errLifecycleBlocked
	}
	var blocked bool
	e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked_before_release_operation($1,$2) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.ForgeURL, r.RepositoryID).Scan(&blocked)
	if e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}
func (s *Server) releaseUpload(ctx context.Context, token forgeCredential, path string, m *golfv1.SubmitRepositoryReleaseOperationRequest) (row forgeReleaseDownloadAsset, e error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, e := writer.CreateFormFile("attachment", m.AssetName)
	if e != nil {
		return row, e
	}
	if _, e = part.Write(m.AssetContent); e != nil {
		return row, e
	}
	if e = writer.Close(); e != nil {
		return row, e
	}
	request, e := http.NewRequestWithContext(ctx, http.MethodPost, s.config.GiteaURL+"/api/v1"+path, &body)
	if e != nil {
		return row, e
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Accept", "application/json")
	scheme := "token"
	if token.Kind == "oauth" {
		scheme = "Bearer"
	} else if token.Kind != "pat" {
		return row, errUnauthenticated
	}
	request.Header.Set("Authorization", scheme+" "+token.Token)
	_, _, manifest := releaseOperationNative(m)
	done, e := s.beginRepositoryLifecycleWrite(ctx, http.MethodPost, path, token, manifest, request)
	if e != nil {
		return row, e
	}
	defer done()
	response, e := s.client.Do(request)
	if e != nil {
		return row, errForgeUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		return row, forgeError{response.StatusCode}
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if e != nil || len(data) >= 64<<10 || json.Unmarshal(data, &row) != nil {
		return row, errInvalidForgeResponse
	}
	if !validReleaseDownloadAsset(row, row.ID) || row.Name != m.AssetName || *row.Size != int64(len(m.AssetContent)) {
		return row, errInvalidForgeResponse
	}
	return
}

// Confirm effects only in this original dispatch. Historical inspection does not
// adopt subsequent matching external state and never resends a native request.
func (s *Server) confirmReleaseOperation(ctx context.Context, session string, token forgeCredential, r releaseOperationRecord, m *golfv1.SubmitRepositoryReleaseOperationRequest, before forgeRepositoryRelease, assetID int64) error {
	if e := s.releaseOperationReceiptAuthority(ctx, session, token, r); e != nil {
		return e
	}
	base, _ := repositoryPath(keyFrom(m.Repository))
	var after forgeRepositoryRelease
	_, e := s.forge(ctx, http.MethodGet, base+"/releases/"+m.ReleaseId, token, nil, &after)
	if int32(m.Kind) == 2 {
		var f forgeError
		if errors.As(e, &f) && f.status == http.StatusNotFound {
			return s.releaseOperationReceiptAuthority(ctx, session, token, r)
		}
		if e != nil {
			return e
		}
		return errInvalidForgeResponse
	}
	if e != nil {
		return e
	}
	if _, e = wireRepositoryRelease(after); e != nil {
		return e
	}
	expected := before
	switch int32(m.Kind) {
	case 1:
		expected.Title = m.Title
		expected.Body = m.BodyMarkdown
		expected.Draft = &m.Draft
		expected.Prerelease = &m.Prerelease
	case 3:
		asset, e := s.readReleaseDownloadAsset(ctx, token, base, r.ReleaseID, assetID)
		if e != nil {
			return e
		}
		if asset.Name != m.AssetName || *asset.Size != int64(len(m.AssetContent)) {
			return errInvalidForgeResponse
		}
		data, e := s.releaseAssetBytes(ctx, token, keyFrom(m.Repository), asset)
		if e != nil {
			return e
		}
		if !bytes.Equal(data, m.AssetContent) {
			return errInvalidForgeResponse
		}
		expected.Assets = append(append([]forgeReleaseAsset{}, before.Assets...), asset.forgeReleaseAsset)
	case 4, 5:
		expected.Assets = append([]forgeReleaseAsset{}, before.Assets...)
		for i, a := range expected.Assets {
			if a.ID == r.AssetID {
				if r.Kind == 4 {
					expected.Assets[i].Name = m.AssetName
				} else {
					expected.Assets = append(expected.Assets[:i], expected.Assets[i+1:]...)
				}
				break
			}
		}
	}
	if releaseRevision(expected) != releaseRevision(after) {
		return errInvalidForgeResponse
	}
	return s.releaseOperationReceiptAuthority(ctx, session, token, r)
}
func (s *Server) advanceReleaseOperation(ctx context.Context, session string, token forgeCredential, r releaseOperationRecord, phase string, assetID int64) (updated releaseOperationRecord, e error) {
	e = s.workflowTransaction(ctx, session, r.ActorID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID {
			return errUnauthenticated
		}
		held, e := s.lockReleaseOperation(ctx, tx, r.RepositoryID)
		if e != nil {
			return e
		}
		if e = s.releaseOperationAuthority(held, session, token, r); e != nil {
			return e
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		updated, e = scanReleaseOperation(tx.QueryRowContext(held, `UPDATE golf_repository_release_operations SET phase=$1,failure_code=$2,result_asset_id=$3 WHERE id=$4 AND user_id=$5 AND forge_url=$6 AND phase=$7 RETURNING `+releaseOperationColumns, phase, failure, assetID, r.ID, r.UserID, r.ForgeURL, r.Phase))
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return
}
func (s *Server) GetRepositoryReleaseOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryReleaseOperationRequest]) (*connect.Response[golfv1.GetRepositoryReleaseOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if _, e = repositoryPath(keyFrom(m.Repository)); e != nil {
		return nil, rpcError(e)
	}
	for _, v := range []string{m.RepositoryId, m.OwnerId} {
		if _, e = discussionID(v); e != nil {
			return nil, rpcError(e)
		}
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, rpcError(invalid("Inspect the original operation UUID."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r releaseOperationRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanReleaseOperation(s.db.QueryRowContext(ctx, `SELECT `+releaseOperationColumns+` FROM golf_repository_release_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e == nil && (r.Owner != m.Repository.Owner || r.Name != m.Repository.Name || strconv.FormatInt(r.RepositoryID, 10) != m.RepositoryId || strconv.FormatInt(r.OwnerID, 10) != m.OwnerId) {
		e = errRepositoryAccessConflict
	}
	if e == nil {
		e = s.releaseOperationAuthority(ctx, session, token, r)
	}
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryReleaseOperationResponse{Operation: releaseOperationWire(r)}), nil
}
func (s *Server) SubmitRepositoryReleaseOperation(ctx context.Context, req *connect.Request[golfv1.SubmitRepositoryReleaseOperationRequest]) (*connect.Response[golfv1.SubmitRepositoryReleaseOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateReleaseOperation(m); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.releasePublicationAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	repoID, _ := discussionID(m.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	releaseID, _ := discussionID(m.ReleaseId)
	assetID := int64(0)
	if m.AssetId != "" {
		assetID, _ = discussionID(m.AssetId)
	}
	fingerprint := releaseOperationFingerprint(m)
	var r releaseOperationRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockReleaseOperation(ctx, tx, repoID)
		if e != nil {
			return e
		}
		r, e = scanReleaseOperation(tx.QueryRowContext(held, `SELECT `+releaseOperationColumns+` FROM golf_repository_release_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(r.Fingerprint, fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanReleaseOperation(tx.QueryRowContext(held, `INSERT INTO golf_repository_release_operations(user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,access_revision,release_id,asset_id,kind,expected_revision,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING `+releaseOperationColumns, c.UserID, s.config.GiteaURL, actor.ID, m.OperationId, repoID, ownerID, m.Repository.Owner, m.Repository.Name, m.AccessRevision, releaseID, assetID, int32(m.Kind), m.ExpectedRevision, fingerprint))
		if e != nil {
			return errStorageUnavailable
		}
		fresh = true
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if fresh {
		if _, e = s.releaseOperationPreflight(ctx, session, token, m); e != nil {
			r, e = s.advanceReleaseOperation(ctx, session, token, r, "REJECTED", 0)
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
		} else {
			r, e = s.advanceReleaseOperation(ctx, session, token, r, "DISPATCH_UNKNOWN", 0)
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				if c.UserID != r.UserID {
					return errUnauthenticated
				}
				held, e := s.lockReleaseOperation(ctx, tx, repoID)
				if e != nil {
					return e
				}
				before, e := s.releaseOperationPreflight(held, session, token, m)
				if e != nil {
					return e
				}
				held = context.WithValue(held, releaseOperationPermitKey{}, releaseOperationPermit{r, proto.Clone(m).(*golfv1.SubmitRepositoryReleaseOperationRequest)})
				method, suffix, payload := releaseOperationNative(m)
				base, _ := repositoryPath(keyFrom(m.Repository))
				resultAssetID := int64(0)
				if r.Kind == 3 {
					var uploaded forgeReleaseDownloadAsset
					uploaded, e = s.releaseUpload(held, token, base+suffix, m)
					resultAssetID = uploaded.ID
				} else {
					status := http.StatusOK
					if method == http.MethodDelete {
						status = http.StatusNoContent
					}
					_, e = s.forgeJSON(held, method, base+suffix, token, payload, nil, status)
				}
				if e != nil {
					return nil
				}
				if e = s.confirmReleaseOperation(held, session, token, r, m, before, resultAssetID); e != nil {
					return nil
				}
				// Final authority and observed effect occur under the original exclusive
				// gate, immediately before the durable success outcome; no later adoption.
				r, e = scanReleaseOperation(tx.QueryRowContext(held, `UPDATE golf_repository_release_operations SET phase='SUCCEEDED',result_asset_id=$1 WHERE id=$2 AND phase='DISPATCH_UNKNOWN' RETURNING `+releaseOperationColumns, resultAssetID, r.ID))
				if e != nil {
					return errStorageUnavailable
				}
				return nil
			})
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
		}
	}
	if e = s.releaseOperationAuthority(ctx, session, token, r); e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.SubmitRepositoryReleaseOperationResponse{Operation: releaseOperationWire(r)}), nil
}

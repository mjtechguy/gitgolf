package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

const releasePublicationContract = "golf.repository.release-publication.v1"

var errReleasePublicationUnavailable = errors.New("release publication requires a current existing unprotected tag")
var errReleasePublicationUnresolved = errors.New("original release publication remains unresolved")

func releasePublicationRPCError(e error) error {
	if errors.Is(e, errRepositoryAccessConflict) {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("The original release publication intent or current repository identity changed."))
	}
	if errors.Is(e, errReleasePublicationUnavailable) {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("Publication requires an existing exact tag, enabled releases and no tag protections."))
	}
	if errors.Is(e, errReleasePublicationUnresolved) {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("Inspect the original publication; unresolved outcomes cannot be retried or replaced."))
	}
	return lifecycleRPCError(e)
}
func validateReleasePublication(m *golfv1.SubmitRepositoryReleasePublicationRequest) error {
	if e := validateRepositoryAccess(keyFrom(m.Repository), m.RepositoryId, m.OwnerId, m.AccessRevision, ""); e != nil {
		return e
	}
	if !creationKey.MatchString(m.OperationId) || len(m.TagName) > 1024 || !validRef(m.TagName) || strings.HasPrefix(m.TagName, "refs/") || !objectID.MatchString(m.TagObjectId) || !objectID.MatchString(m.CommitId) || len(m.TagObjectId) != len(m.CommitId) {
		return invalid("Bind the original operation and existing named tag object/full commit.")
	}
	if !pullTitle(m.Title) || len(m.Title) > 255 || !discussionText(m.BodyMarkdown, 16<<10) {
		return invalid("Provide a trimmed title of at most 255 bytes and notes of at most 16 KiB.")
	}
	return nil
}
func releasePublicationFingerprint(m *golfv1.SubmitRepositoryReleasePublicationRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitRepositoryReleasePublicationRequest)
	c.OperationId = ""
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	h := sha256.Sum256(b)
	return h[:]
}
func releasePublicationTextHash(text string) string {
	h := sha256.Sum256([]byte(text))
	return hex.EncodeToString(h[:])
}

type releasePublicationRecord struct {
	ID, UserID, ActorID, RepositoryID, OwnerID, ReleaseID                                                         int64
	ForgeURL, OperationID, Owner, Name, AccessRevision, Tag, TagObject, Commit, TitleSHA, BodySHA, Phase, Failure string
	Prerelease                                                                                                    bool
	Fingerprint                                                                                                   []byte
	Created, Updated                                                                                              time.Time
}

const releasePublicationColumns = `id,user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,access_revision,tag_name,tag_object_id,commit_id,title_sha256,body_sha256,prerelease,input_fingerprint,phase,release_id,failure_code,created_at,updated_at`

func scanReleasePublication(row interface{ Scan(...any) error }) (r releasePublicationRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ForgeURL, &r.ActorID, &r.OperationID, &r.RepositoryID, &r.OwnerID, &r.Owner, &r.Name, &r.AccessRevision, &r.Tag, &r.TagObject, &r.Commit, &r.TitleSHA, &r.BodySHA, &r.Prerelease, &r.Fingerprint, &r.Phase, &r.ReleaseID, &r.Failure, &r.Created, &r.Updated)
	return
}
func releasePublicationWire(r releasePublicationRecord) *golfv1.RepositoryReleasePublicationOperation {
	v := &golfv1.RepositoryReleasePublicationOperation{Contract: releasePublicationContract, OperationId: r.OperationID, ActorId: strconv.FormatInt(r.ActorID, 10), Repository: &golfv1.RepositoryKey{Owner: r.Owner, Name: r.Name}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), AccessRevision: r.AccessRevision, TagName: r.Tag, TagObjectId: r.TagObject, CommitId: r.Commit, TitleSha256: r.TitleSHA, BodySha256: r.BodySHA, Prerelease: r.Prerelease, Phase: golfv1.RepositoryReleasePublicationPhase(golfv1.RepositoryReleasePublicationPhase_value["REPOSITORY_RELEASE_PUBLICATION_PHASE_"+r.Phase]), FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}
	if r.ReleaseID > 0 {
		v.ReleaseId = strconv.FormatInt(r.ReleaseID, 10)
	}
	return v
}
func releasePublicationTarget(r releasePublicationRecord, m *golfv1.GetRepositoryReleasePublicationOperationRequest) bool {
	return r.Owner == m.Repository.GetOwner() && r.Name == m.Repository.GetName() && strconv.FormatInt(r.RepositoryID, 10) == m.RepositoryId && strconv.FormatInt(r.OwnerID, 10) == m.OwnerId
}
func releasePublicationStatus(m *golfv1.SubmitRepositoryReleasePublicationRequest) *golfv1.GetRepositoryReleasePublicationOperationRequest {
	return &golfv1.GetRepositoryReleasePublicationOperationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, OperationId: m.OperationId}
}

// Positive ordinary current ownership/direct admin, never a Golf/global/native
// site-admin exception. Historical reads do not require the original tag still H.
func (s *Server) releasePublicationAuthority(ctx context.Context, session string, token forgeCredential, key repositoryKey, repoID, ownerID string) (actor User, e error) {
	e = s.withForgeCaller(ctx, session, token, func(caller User) error {
		access, e := s.rulesAuthority(ctx, token, key, caller)
		if e != nil {
			return e
		}
		if access.RepositoryId != repoID || access.OwnerId != ownerID {
			return errRepositoryAccessConflict
		}
		actor = caller
		return nil
	})
	return
}
func (s *Server) ownReleasePublication(ctx context.Context, session string, token forgeCredential, id string) (r releasePublicationRecord, e error) {
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanReleasePublication(s.db.QueryRowContext(ctx, `SELECT `+releasePublicationColumns+` FROM golf_repository_release_publications WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, id))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return
}

// Existing tag object+peeled H are observations, not a native CAS. An external
// delete can race the request and native CreateRelease may recreate a tag at H.
func (s *Server) releasePublicationPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitRepositoryReleasePublicationRequest) error {
	actor, e := s.releasePublicationAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	if e != nil {
		return e
	}
	key := keyFrom(m.Repository)
	e = s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		access, e := s.readRepositoryAccess(ctx, token, key, actor)
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
		if _, e = wireRepositorySettings(config.forgeRepositorySettings, key); e != nil {
			return e
		}
		if repo.ID != config.ID || strconv.FormatInt(config.ID, 10) != m.RepositoryId || strconv.FormatInt(config.Owner.ID, 10) != m.OwnerId {
			return errRepositoryAccessConflict
		}
		if config.HasReleases == nil || !*config.HasReleases || *config.Archived || *config.Mirror {
			return errReleasePublicationUnavailable
		}
		var tags []forgeTagProtection
		if _, e = s.forge(ctx, http.MethodGet, base+"/tag_protections", token, nil, &tags); e != nil {
			return e
		}
		if tags == nil {
			return errInvalidForgeResponse
		}
		if len(tags) > 0 {
			return errReleasePublicationUnavailable
		}
		tag, e := s.exactSourceTag(ctx, base, token, m.TagName)
		if e != nil {
			return e
		}
		if tag.ID != m.TagObjectId || tag.Commit.SHA != m.CommitId {
			return errRepositoryAccessConflict
		}
		// Native tag-only rows return404 here; POST converts them into a release.
		_, e = s.forge(ctx, http.MethodGet, base+"/releases/tags/"+escapedSourcePath(m.TagName), token, nil, nil)
		var native forgeError
		if e == nil {
			return errReleasePublicationUnavailable
		}
		if !errors.As(e, &native) || native.status != http.StatusNotFound {
			return e
		}
		return nil
	})
	if e != nil {
		return e
	}
	_, e = s.releasePublicationAuthority(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	return e
}
func releasePublicationMatches(row forgeRepositoryRelease, r releasePublicationRecord) bool {
	_, e := wireRepositoryRelease(row)
	return e == nil && row.ID > 0 && row.TagName == r.Tag && row.TargetCommitish == r.Commit && row.Author != nil && row.Author.ID == r.ActorID && !*row.Draft && *row.Prerelease == r.Prerelease && releasePublicationTextHash(row.Title) == r.TitleSHA && releasePublicationTextHash(row.Body) == r.BodySHA && len(row.Assets) == 0
}
func (s *Server) releasePublicationReceiptAuthority(ctx context.Context, session string, token forgeCredential, r releasePublicationRecord) error {
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
func (s *Server) releasePublicationReceipt(ctx context.Context, session string, token forgeCredential, r releasePublicationRecord, nativeID int64) error {
	key := repositoryKey{r.Owner, r.Name}
	if e := s.releasePublicationReceiptAuthority(ctx, session, token, r); e != nil {
		return e
	}
	e := s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		if repo.ID != r.RepositoryID {
			return errRepositoryAccessConflict
		}
		var row forgeRepositoryRelease
		if _, e := s.forge(ctx, http.MethodGet, base+"/releases/"+strconv.FormatInt(nativeID, 10), token, nil, &row); e != nil {
			return e
		}
		if row.ID != nativeID || !releasePublicationMatches(row, r) {
			return errInvalidForgeResponse
		}
		tag, e := s.exactSourceTag(ctx, base, token, r.Tag)
		if e != nil {
			return e
		}
		if tag.ID != r.TagObject || tag.Commit.SHA != r.Commit {
			return errRepositoryAccessConflict
		}
		return nil
	})
	if e != nil {
		return e
	}
	return s.releasePublicationReceiptAuthority(ctx, session, token, r)
}

func (s *Server) lockReleasePublication(ctx context.Context, tx *sql.Tx, repoID int64) (context.Context, error) {
	if _, e := tx.ExecContext(ctx, `SELECT golf_release_publication_lock($1,$2)`, s.config.ForgeURL, repoID); e != nil {
		return nil, errStorageUnavailable
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.ForgeURL, repoID, tx}), nil
}
func (s *Server) advanceReleasePublication(ctx context.Context, session string, token forgeCredential, r releasePublicationRecord, phase string, id int64) (updated releasePublicationRecord, e error) {
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return r, e
	}
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID || actor.ID != r.ActorID {
			return errUnauthenticated
		}
		held, e := s.lockReleasePublication(ctx, tx, r.RepositoryID)
		if e != nil {
			return e
		}
		if phase == "SUCCEEDED" {
			if e = s.releasePublicationReceipt(held, session, token, r, id); e != nil {
				return e
			}
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		updated, e = scanReleasePublication(tx.QueryRowContext(held, `UPDATE golf_repository_release_publications SET phase=$1,release_id=$2,failure_code=$3 WHERE id=$4 AND user_id=$5 AND forge_url=$6 AND phase=$7 RETURNING `+releasePublicationColumns, phase, id, failure, r.ID, r.UserID, r.ForgeURL, r.Phase))
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return
}

// The per-repository exclusive lifecycle gate serializes publication admission
// and forwarding with standard merge shared gates, including fork sources.
// It does not mediate native/external writers or add an atomic tag CAS.
// This permit is private and only constructed inside the original actor's
// workflowTransaction after UNKNOWN is committed. It cannot admit generic API
// writes while this publication excludes managed repository mutations.
type releasePublicationPermitKey struct{}
type releasePublicationPermit struct{ record releasePublicationRecord }

func releasePublicationPayload(m *golfv1.SubmitRepositoryReleasePublicationRequest) map[string]any {
	return map[string]any{"tag_name": m.TagName, "target_commitish": m.CommitId, "name": m.Title, "body": m.BodyMarkdown, "draft": false, "prerelease": m.Prerelease}
}
func (s *Server) validateReleasePublicationPermit(ctx context.Context, tx *sql.Tx, p releasePublicationPermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	base, _ := repositoryPath(key)
	if tx == nil || repo.ID != r.RepositoryID || method != http.MethodPost || path != base+"/releases" || key.Owner != r.Owner || key.Name != r.Name {
		return errLifecycleBlocked
	}
	row, e := scanReleasePublication(tx.QueryRowContext(ctx, `SELECT `+releasePublicationColumns+` FROM golf_repository_release_publications WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, s.config.ForgeURL))
	if e != nil {
		return errLifecycleBlocked
	}
	encoded, e := json.Marshal(input)
	if e != nil {
		return errLifecycleBlocked
	}
	var v struct {
		Tag, Target, Title, Body string
		Draft, Prerelease        *bool
	}
	// Decode the exact supported payload keys, never accept an arbitrary native URL.
	var fields map[string]json.RawMessage
	if json.Unmarshal(encoded, &fields) != nil || len(fields) != 6 {
		return errLifecycleBlocked
	}
	if json.Unmarshal(fields["tag_name"], &v.Tag) != nil || json.Unmarshal(fields["target_commitish"], &v.Target) != nil || json.Unmarshal(fields["name"], &v.Title) != nil || json.Unmarshal(fields["body"], &v.Body) != nil || json.Unmarshal(fields["draft"], &v.Draft) != nil || json.Unmarshal(fields["prerelease"], &v.Prerelease) != nil {
		return errLifecycleBlocked
	}
	if row.ActorID != r.ActorID || !bytes.Equal(row.Fingerprint, r.Fingerprint) || v.Tag != row.Tag || v.Target != row.Commit || v.Draft == nil || *v.Draft || v.Prerelease == nil || *v.Prerelease != row.Prerelease || releasePublicationTextHash(v.Title) != row.TitleSHA || releasePublicationTextHash(v.Body) != row.BodySHA {
		return errLifecycleBlocked
	}
	var blocked bool
	if e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked_before_release_publication($1,$2) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.ForgeURL, r.RepositoryID).Scan(&blocked); e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}

func (s *Server) GetRepositoryReleasePublicationOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryReleasePublicationOperationRequest]) (*connect.Response[golfv1.GetRepositoryReleasePublicationOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if _, e = repositoryPath(keyFrom(m.Repository)); e != nil {
		return nil, releasePublicationRPCError(e)
	}
	for _, id := range []string{m.RepositoryId, m.OwnerId} {
		if _, e = discussionID(id); e != nil {
			return nil, releasePublicationRPCError(e)
		}
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, releasePublicationRPCError(invalid("Inspect the original publication key."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, e = s.releasePublicationAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId); e != nil {
		return nil, releasePublicationRPCError(e)
	}
	r, e := s.ownReleasePublication(ctx, session, token, m.OperationId)
	if e != nil {
		return nil, releasePublicationRPCError(e)
	}
	if !releasePublicationTarget(r, m) {
		return nil, releasePublicationRPCError(errRepositoryAccessConflict)
	}
	if _, e = s.releasePublicationAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId); e != nil {
		return nil, releasePublicationRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryReleasePublicationOperationResponse{Operation: releasePublicationWire(r)}), nil
}
func (s *Server) SubmitRepositoryReleasePublication(ctx context.Context, req *connect.Request[golfv1.SubmitRepositoryReleasePublicationRequest]) (*connect.Response[golfv1.SubmitRepositoryReleasePublicationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateReleasePublication(m); e != nil {
		return nil, releasePublicationRPCError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	key := keyFrom(m.Repository)
	actor, e := s.releasePublicationAuthority(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, releasePublicationRPCError(e)
	}
	repoID, _ := discussionID(m.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	fingerprint := releasePublicationFingerprint(m)
	var r releasePublicationRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockReleasePublication(ctx, tx, repoID)
		if e != nil {
			return e
		}
		r, e = scanReleasePublication(tx.QueryRowContext(held, `SELECT `+releasePublicationColumns+` FROM golf_repository_release_publications WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(r.Fingerprint, fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanReleasePublication(tx.QueryRowContext(held, `INSERT INTO golf_repository_release_publications(user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,access_revision,tag_name,tag_object_id,commit_id,title_sha256,body_sha256,prerelease,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING `+releasePublicationColumns, c.UserID, s.config.ForgeURL, actor.ID, m.OperationId, repoID, ownerID, key.Owner, key.Name, m.AccessRevision, m.TagName, m.TagObjectId, m.CommitId, releasePublicationTextHash(m.Title), releasePublicationTextHash(m.BodyMarkdown), m.Prerelease, fingerprint))
		if e != nil {
			var state interface{ SQLState() string }
			if errors.As(e, &state) && state.SQLState() == "55000" {
				return errReleasePublicationUnresolved
			}
			return errStorageUnavailable
		}
		fresh = true
		return nil
	})
	if e != nil {
		return nil, releasePublicationRPCError(e)
	}
	if fresh {
		if e = s.releasePublicationPreflight(ctx, session, token, m); e != nil {
			if _, e = s.advanceReleasePublication(ctx, session, token, r, "REJECTED", 0); e != nil {
				return nil, releasePublicationRPCError(e)
			}
		} else {
			r, e = s.advanceReleasePublication(ctx, session, token, r, "DISPATCH_UNKNOWN", 0)
			if e != nil {
				return nil, releasePublicationRPCError(e)
			}
			var native forgeRepositoryRelease
			var nativeErr error
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				if c.UserID != r.UserID {
					return errUnauthenticated
				}
				held, e := s.lockReleasePublication(ctx, tx, repoID)
				if e != nil {
					return e
				}
				if e = s.releasePublicationPreflight(held, session, token, m); e != nil {
					return e
				}
				held = context.WithValue(held, releasePublicationPermitKey{}, releasePublicationPermit{r})
				base, _ := repositoryPath(key)
				_, nativeErr = s.forgeJSON(held, http.MethodPost, base+"/releases", token, releasePublicationPayload(m), &native, http.StatusCreated)
				if nativeErr == nil && !releasePublicationMatches(native, r) {
					nativeErr = errInvalidForgeResponse
				}
				if nativeErr == nil {
					nativeErr = s.releasePublicationReceipt(held, session, token, r, native.ID)
				}
				return nil
			})
			if e != nil {
				return nil, releasePublicationRPCError(e)
			}
			if nativeErr == nil {
				if _, e = s.advanceReleasePublication(ctx, session, token, r, "SUCCEEDED", native.ID); e != nil {
					return nil, releasePublicationRPCError(e)
				}
			}
		}
	}
	// Preserve the caller's managed cookie header for original status inspection.
	request := connect.NewRequest(releasePublicationStatus(m))
	request.Header().Set("Cookie", req.Header().Get("Cookie"))
	request.Header().Set("Origin", req.Header().Get("Origin"))
	status, e := s.GetRepositoryReleasePublicationOperation(ctx, request)
	if e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.SubmitRepositoryReleasePublicationResponse{Operation: status.Msg.Operation}), nil
}

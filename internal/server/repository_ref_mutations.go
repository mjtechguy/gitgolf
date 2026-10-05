package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
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

const refMutationContract = "golf.repository.ref-mutation.v1"

var errRefMutationUnavailable = errors.New("ref mutation requires an unprotected exact ref and current repository administration")

func refMutationKind(k golfv1.RepositoryRefMutationKind) string {
	return strings.TrimPrefix(k.String(), "REPOSITORY_REF_MUTATION_KIND_")
}
func refMutationCreate(k string) bool { return k == "CREATE_BRANCH" || k == "CREATE_TAG" }
func refMutationBranch(k string) bool { return k == "CREATE_BRANCH" || k == "DELETE_BRANCH" }
func validateRefMutation(m *golfv1.SubmitRepositoryRefMutationRequest) error {
	if e := validateRepositoryAccess(keyFrom(m.Repository), m.RepositoryId, m.OwnerId, m.AccessRevision, ""); e != nil {
		return e
	}
	k := refMutationKind(m.Kind)
	if !creationKey.MatchString(m.OperationId) || !(k == "CREATE_BRANCH" || k == "DELETE_BRANCH" || k == "CREATE_TAG" || k == "DELETE_TAG") || m.Name == "" || !validRef(m.Name) || strings.HasPrefix(m.Name, "refs/") || !objectID.MatchString(m.CommitId) {
		return invalid("Select an original operation, exact branch/tag name and full commit.")
	}
	if k == "DELETE_TAG" {
		if !objectID.MatchString(m.TagObjectId) || len(m.TagObjectId) != len(m.CommitId) {
			return invalid("Bind the original tag object and peeled commit.")
		}
	} else if m.TagObjectId != "" {
		return invalid("Only tag deletion accepts a tag object ID.")
	}
	return nil
}
func refMutationFingerprint(m *golfv1.SubmitRepositoryRefMutationRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitRepositoryRefMutationRequest)
	c.OperationId = ""
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	h := sha256.Sum256(b)
	return h[:]
}

type refMutationRecord struct {
	ID, UserID, ActorID, RepositoryID, OwnerID                                                       int64
	ForgeURL, OperationID, Owner, Name, AccessRevision, Kind, Ref, Commit, TagObject, Phase, Failure string
	Fingerprint                                                                                      []byte
	Created, Updated                                                                                 time.Time
}

const refMutationColumns = `id,user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,access_revision,kind,ref_name,commit_id,tag_object_id,input_fingerprint,phase,failure_code,created_at,updated_at`

func scanRefMutation(row interface{ Scan(...any) error }) (r refMutationRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ForgeURL, &r.ActorID, &r.OperationID, &r.RepositoryID, &r.OwnerID, &r.Owner, &r.Name, &r.AccessRevision, &r.Kind, &r.Ref, &r.Commit, &r.TagObject, &r.Fingerprint, &r.Phase, &r.Failure, &r.Created, &r.Updated)
	return
}
func refMutationWire(r refMutationRecord) *golfv1.RepositoryRefMutationOperation {
	return &golfv1.RepositoryRefMutationOperation{Contract: refMutationContract, OperationId: r.OperationID, ActorId: strconv.FormatInt(r.ActorID, 10), Repository: &golfv1.RepositoryKey{Owner: r.Owner, Name: r.Name}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), AccessRevision: r.AccessRevision, Kind: golfv1.RepositoryRefMutationKind(golfv1.RepositoryRefMutationKind_value["REPOSITORY_REF_MUTATION_KIND_"+r.Kind]), Name: r.Ref, CommitId: r.Commit, TagObjectId: r.TagObject, Phase: golfv1.RepositoryRefMutationPhase(golfv1.RepositoryRefMutationPhase_value["REPOSITORY_REF_MUTATION_PHASE_"+r.Phase]), FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}
}
func (s *Server) lockRefMutation(ctx context.Context, tx *sql.Tx, id int64) (context.Context, error) {
	if _, e := tx.ExecContext(ctx, `SELECT golf_ref_mutation_lock($1,$2)`, s.config.GiteaURL, id); e != nil {
		return nil, errStorageUnavailable
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.GiteaURL, id, tx}), nil
}

// Native create/delete have no expected-value CAS. Exact identity, protections,
// absence/current value and permissions are observations before and after waits.
// Refuse all configured protection rules instead of guessing wildcard precedence.
func (s *Server) refMutationPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitRepositoryRefMutationRequest) error {
	actor, e := s.releasePublicationAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	if e != nil {
		return e
	}
	e = s.withRepositoryRead(ctx, session, token, keyFrom(m.Repository), func(base string, repo Repository) error {
		access, e := s.readRepositoryAccess(ctx, token, keyFrom(m.Repository), actor)
		if e != nil {
			return e
		}
		if e = accessMatches(access, m.RepositoryId, m.OwnerId, m.AccessRevision); e != nil {
			return e
		}
		k := refMutationKind(m.Kind)
		if repo.Empty || refMutationBranch(k) && k == "DELETE_BRANCH" && repo.DefaultBranch == m.Name {
			return errRefMutationUnavailable
		}
		if refMutationBranch(k) {
			var rules []json.RawMessage
			if _, e = s.forge(ctx, http.MethodGet, base+"/branch_protections", token, nil, &rules); e != nil {
				return e
			}
			if rules == nil {
				return errInvalidForgeResponse
			}
			if len(rules) > 0 {
				return errRefMutationUnavailable
			}
		} else {
			var rules []json.RawMessage
			if _, e = s.forge(ctx, http.MethodGet, base+"/tag_protections", token, nil, &rules); e != nil {
				return e
			}
			if rules == nil {
				return errInvalidForgeResponse
			}
			if len(rules) > 0 {
				return errRefMutationUnavailable
			}
		}
		var sha, tagID string
		if refMutationBranch(k) {
			sha, e = s.exactSourceBranch(ctx, base, token, m.Name)
		} else {
			var tag forgeTag
			tag, e = s.exactSourceTag(ctx, base, token, m.Name)
			sha, tagID = tag.Commit.SHA, tag.ID
		}
		if refMutationCreate(k) {
			if e == nil {
				return errRefMutationUnavailable
			}
			if !sourceNotFound(e) {
				return e
			}
			if e = s.exactSourceCommit(ctx, base, token, m.CommitId); e != nil {
				return e
			}
			// Gitea GetCommit resolves SHA-looking names before objects. Require both
			// exact namespaces absent; never send a known ambiguous short commit name.
			if _, e = s.exactSourceBranch(ctx, base, token, m.CommitId); !sourceNotFound(e) {
				if e == nil {
					return errRefMutationUnavailable
				}
				return e
			}
			if _, e = s.exactSourceTag(ctx, base, token, m.CommitId); !sourceNotFound(e) {
				if e == nil {
					return errRefMutationUnavailable
				}
				return e
			}
		} else {
			if e != nil {
				return e
			}
			if sha != m.CommitId || k == "DELETE_TAG" && tagID != m.TagObjectId {
				return errRepositoryAccessConflict
			}
			if k == "DELETE_TAG" { // Native tag deletion can delete its published release.
				if e = s.refMutationNoRelease(ctx, base, token, repo.ID, m.Name); e != nil {
					return e
				}
			}
		}
		return nil
	})
	if e != nil {
		return e
	}
	_, e = s.releasePublicationAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	return e
}

// The native release-by-tag route is not wildcarded: a slash-tag 404 cannot
// prove absence. Scan the bounded, independently validated release collection.
func (s *Server) refMutationNoRelease(ctx context.Context, base string, token forgeCredential, repoID int64, name string) error {
	var config struct {
		ID          int64 `json:"id"`
		HasReleases *bool `json:"has_releases"`
	}
	if _, e := s.forge(ctx, http.MethodGet, base, token, nil, &config); e != nil {
		return e
	}
	if config.ID != repoID {
		return errRepositoryAccessConflict
	}
	if config.HasReleases == nil || !*config.HasReleases {
		return errRefMutationUnavailable
	}
	return s.withNativePageSize(ctx, token, 50, func(limit uint32) error {
		total := ""
		seen := map[string]bool{}
		notes, assets := 0, 0
		for page := uint32(1); page <= 1000; page++ {
			var rows []forgeRepositoryRelease
			headers, e := s.forge(ctx, http.MethodGet, base+"/releases?"+pageQuery(page, limit).Encode(), token, nil, &rows)
			if e != nil {
				return e
			}
			values, count, next, e := repositoryReleasePage(rows, headers, page, limit)
			if e != nil {
				return e
			}
			n, e := strconv.ParseUint(count, 10, 63)
			if e != nil || n > 1000 {
				return errForgeResponseTooLarge
			}
			if total != "" && total != count {
				return errPullSnapshotChanged
			}
			total = count
			for _, row := range values {
				if seen[row.Id] {
					return errInvalidForgeResponse
				}
				seen[row.Id] = true
				notes += len(row.BodyMarkdown)
				assets += len(row.Assets)
				if notes > 512<<10 || assets > 500 {
					return errForgeResponseTooLarge
				}
				if strings.ToLower(row.TagName) == strings.ToLower(name) {
					return errRefMutationUnavailable
				}
			}
			if next == 0 {
				return nil
			}
		}
		return errForgeResponseTooLarge
	})
}
func refMutationNative(r refMutationRecord) (method, suffix string, payload any) {
	collection := "/tags"
	if refMutationBranch(r.Kind) {
		collection = "/branches"
	}
	if !refMutationCreate(r.Kind) {
		return http.MethodDelete, collection + "/" + escapedSourcePath(r.Ref), nil
	}
	if refMutationBranch(r.Kind) {
		return http.MethodPost, collection, map[string]string{"new_branch_name": r.Ref, "old_ref_name": r.Commit}
	}
	return http.MethodPost, collection, map[string]string{"tag_name": r.Ref, "target": r.Commit, "message": ""}
}
func (s *Server) refMutationReceipt(ctx context.Context, session string, token forgeCredential, r refMutationRecord) error {
	if _, e := s.releasePublicationAuthority(ctx, session, token, repositoryKey{r.Owner, r.Name}, strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10)); e != nil {
		return e
	}
	return s.withRepositoryRead(ctx, session, token, repositoryKey{r.Owner, r.Name}, func(base string, repo Repository) error {
		if repo.ID != r.RepositoryID {
			return errRepositoryAccessConflict
		}
		actor, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		access, e := s.readRepositoryAccess(ctx, token, repositoryKey{r.Owner, r.Name}, actor)
		if e != nil {
			return e
		}
		if e = accessMatches(access, strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10), r.AccessRevision); e != nil {
			return e
		}
		var sha, id string
		if refMutationBranch(r.Kind) {
			sha, e = s.exactSourceBranch(ctx, base, token, r.Ref)
		} else {
			var tag forgeTag
			tag, e = s.exactSourceTag(ctx, base, token, r.Ref)
			sha, id = tag.Commit.SHA, tag.ID
		}
		if !refMutationCreate(r.Kind) {
			if sourceNotFound(e) {
				return nil
			}
			if e == nil {
				return errRepositoryAccessConflict
			}
			return e
		}
		if e != nil {
			return e
		}
		if sha != r.Commit || !refMutationBranch(r.Kind) && id != r.Commit {
			return errInvalidForgeResponse
		}
		return s.exactSourceCommit(ctx, base, token, sha)
	})
}

type refMutationPermitKey struct{}
type refMutationPermit struct{ record refMutationRecord }

func (s *Server) validateRefMutationPermit(ctx context.Context, tx *sql.Tx, p refMutationPermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	base, _ := repositoryPath(key)
	wantMethod, suffix, payload := refMutationNative(r)
	if tx == nil || repo.ID != r.RepositoryID || key.Owner != r.Owner || key.Name != r.Name || method != wantMethod || path != base+suffix {
		return errLifecycleBlocked
	}
	row, e := scanRefMutation(tx.QueryRowContext(ctx, `SELECT `+refMutationColumns+` FROM golf_repository_ref_mutations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, s.config.GiteaURL))
	if e != nil || row.ActorID != r.ActorID || !bytes.Equal(row.Fingerprint, r.Fingerprint) {
		return errLifecycleBlocked
	}
	a, e := json.Marshal(input)
	if e != nil {
		return errLifecycleBlocked
	}
	b, e := json.Marshal(payload)
	if e != nil || !bytes.Equal(a, b) {
		return errLifecycleBlocked
	}
	var blocked bool
	if e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked_before_ref_mutation($1,$2) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.ForgeURL, r.RepositoryID).Scan(&blocked); e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}
func (s *Server) advanceRefMutation(ctx context.Context, session string, token forgeCredential, r refMutationRecord, phase string) (updated refMutationRecord, e error) {
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return r, e
	}
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID || actor.ID != r.ActorID {
			return errUnauthenticated
		}
		held, e := s.lockRefMutation(ctx, tx, r.RepositoryID)
		if e != nil {
			return e
		}
		if phase == "SUCCEEDED" {
			if e = s.refMutationReceipt(held, session, token, r); e != nil {
				return e
			}
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		updated, e = scanRefMutation(tx.QueryRowContext(held, `UPDATE golf_repository_ref_mutations SET phase=$1,failure_code=$2 WHERE id=$3 AND user_id=$4 AND forge_url=$5 AND phase=$6 RETURNING `+refMutationColumns, phase, failure, r.ID, r.UserID, r.ForgeURL, r.Phase))
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return
}
func (s *Server) GetRepositoryRefMutationOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryRefMutationOperationRequest]) (*connect.Response[golfv1.GetRepositoryRefMutationOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if _, e = repositoryPath(keyFrom(m.Repository)); e != nil {
		return nil, lifecycleRPCError(e)
	}
	for _, id := range []string{m.RepositoryId, m.OwnerId} {
		if _, e = discussionID(id); e != nil {
			return nil, lifecycleRPCError(e)
		}
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, rpcError(invalid("Inspect the original ref operation."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, e = s.releasePublicationAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId); e != nil {
		return nil, lifecycleRPCError(e)
	}
	var r refMutationRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanRefMutation(s.db.QueryRowContext(ctx, `SELECT `+refMutationColumns+` FROM golf_repository_ref_mutations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if r.Owner != m.Repository.Owner || r.Name != m.Repository.Name || strconv.FormatInt(r.RepositoryID, 10) != m.RepositoryId || strconv.FormatInt(r.OwnerID, 10) != m.OwnerId {
		return nil, lifecycleRPCError(errRepositoryAccessConflict)
	}
	if _, e = s.releasePublicationAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId); e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryRefMutationOperationResponse{Operation: refMutationWire(r)}), nil
}
func (s *Server) SubmitRepositoryRefMutation(ctx context.Context, req *connect.Request[golfv1.SubmitRepositoryRefMutationRequest]) (*connect.Response[golfv1.SubmitRepositoryRefMutationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateRefMutation(m); e != nil {
		return nil, lifecycleRPCError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	key := keyFrom(m.Repository)
	actor, e := s.releasePublicationAuthority(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	repoID, _ := discussionID(m.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	fingerprint := refMutationFingerprint(m)
	var r refMutationRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockRefMutation(ctx, tx, repoID)
		if e != nil {
			return e
		}
		r, e = scanRefMutation(tx.QueryRowContext(held, `SELECT `+refMutationColumns+` FROM golf_repository_ref_mutations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(r.Fingerprint, fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanRefMutation(tx.QueryRowContext(held, `INSERT INTO golf_repository_ref_mutations(user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,access_revision,kind,ref_name,commit_id,tag_object_id,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING `+refMutationColumns, c.UserID, s.config.GiteaURL, actor.ID, m.OperationId, repoID, ownerID, key.Owner, key.Name, m.AccessRevision, refMutationKind(m.Kind), m.Name, m.CommitId, m.TagObjectId, fingerprint))
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
		if e = s.refMutationPreflight(ctx, session, token, m); e != nil {
			if _, e = s.advanceRefMutation(ctx, session, token, r, "REJECTED"); e != nil {
				return nil, lifecycleRPCError(e)
			}
		} else {
			r, e = s.advanceRefMutation(ctx, session, token, r, "DISPATCH_UNKNOWN")
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			var nativeErr error
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				if c.UserID != r.UserID {
					return errUnauthenticated
				}
				held, e := s.lockRefMutation(ctx, tx, repoID)
				if e != nil {
					return e
				}
				if e = s.refMutationPreflight(held, session, token, m); e != nil {
					return e
				}
				held = context.WithValue(held, refMutationPermitKey{}, refMutationPermit{r})
				base, _ := repositoryPath(key)
				method, suffix, payload := refMutationNative(r)
				if refMutationCreate(r.Kind) {
					if refMutationBranch(r.Kind) {
						var row struct {
							Name   string `json:"name"`
							Commit struct {
								ID string `json:"id"`
							} `json:"commit"`
						}
						_, nativeErr = s.forgeJSON(held, method, base+suffix, token, payload, &row, http.StatusCreated)
						if nativeErr == nil && (row.Name != r.Ref || row.Commit.ID != r.Commit) {
							nativeErr = errInvalidForgeResponse
						}
					} else {
						var row forgeTag
						_, nativeErr = s.forgeJSON(held, method, base+suffix, token, payload, &row, http.StatusCreated)
						if nativeErr == nil && (row.Name != r.Ref || row.Commit.SHA != r.Commit || row.ID != r.Commit) {
							nativeErr = errInvalidForgeResponse
						}
					}
				} else {
					_, nativeErr = s.forgeJSON(held, method, base+suffix, token, nil, nil, http.StatusNoContent)
				}
				if nativeErr == nil {
					nativeErr = s.refMutationReceipt(held, session, token, r)
				}
				return nil
			})
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			if nativeErr == nil {
				if _, e = s.advanceRefMutation(ctx, session, token, r, "SUCCEEDED"); e != nil {
					return nil, lifecycleRPCError(e)
				}
			}
		}
	}
	status := connect.NewRequest(&golfv1.GetRepositoryRefMutationOperationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, OperationId: m.OperationId})
	status.Header().Set("Cookie", req.Header().Get("Cookie"))
	status.Header().Set("Origin", req.Header().Get("Origin"))
	result, e := s.GetRepositoryRefMutationOperation(ctx, status)
	if e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.SubmitRepositoryRefMutationResponse{Operation: result.Msg.Operation}), nil
}

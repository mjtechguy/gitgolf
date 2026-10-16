package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
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

const wikiOperationContract = "golf.repository.wiki-operation.v1"

func wikiOperationFingerprint(m *golfv1.SubmitRepositoryWikiOperationRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitRepositoryWikiOperationRequest)
	c.OperationId = ""
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	h := sha256.Sum256(b)
	return h[:]
}
func validateWikiOperation(m *golfv1.SubmitRepositoryWikiOperationRequest) error {
	if e := validateRepositoryAccess(keyFrom(m.Repository), m.RepositoryId, m.OwnerId, m.AccessRevision, ""); e != nil {
		return e
	}
	if !creationKey.MatchString(m.OperationId) || m.Kind < 1 || m.Kind > 3 {
		return invalid("Bind the original wiki operation UUID and supported action.")
	}
	if m.Kind == 1 {
		if m.Slug != "" || m.ExpectedCommitId != "" {
			return invalid("New pages do not accept an existing slug or version.")
		}
	} else if !validWikiSlug(m.Slug) || !objectID.MatchString(m.ExpectedCommitId) {
		return invalid("Bind the exact native page slug and observed commit.")
	}
	if m.Kind == 3 {
		if m.Title != "" || m.Markdown != "" || m.CommitMessage != "" {
			return invalid("Deletion accepts only the original page identity.")
		}
		return nil
	}
	// Renaming changes native slugs. This initial editor preserves the exact title.
	if !pullTitle(m.Title) || len(m.Title) > 255 || strings.ContainsAny(m.Title, "/\\") || m.Title == "." || m.Title == ".." || !discussionText(m.Markdown, 256<<10) || m.Markdown == "" || !pullTitle(m.CommitMessage) || len(m.CommitMessage) > 1024 {
		return invalid("Use a page title without path separators, nonempty UTF-8 Markdown up to256 KiB and a commit message up to1024 bytes.")
	}
	return nil
}
func (s *Server) wikiWriteAuthority(ctx context.Context, session string, token forgeCredential, key repositoryKey, id, owner string) (actor User, access *golfv1.RepositoryAccess, e error) {
	e = s.withForgeCaller(ctx, session, token, func(user User) error {
		actor = user
		return s.withWikiRead(ctx, session, token, key, id, func(_ string, _ Repository) error {
			var e error
			access, e = s.readRepositoryAccess(ctx, token, key, user)
			if e != nil {
				return e
			}
			if access.RepositoryId != id || owner != "" && access.OwnerId != owner {
				return errRepositoryAccessConflict
			}
			if !access.CanManage {
				writer, e := s.wikiUnitWriter086(ctx, token, key, user)
				if e != nil {
					return e
				}
				if !writer {
					return forgeError{http.StatusForbidden}
				}
			}
			return nil
		})
	})
	return
}
func (s *Server) GetRepositoryWikiWriteContext(ctx context.Context, req *connect.Request[golfv1.GetRepositoryWikiWriteContextRequest]) (*connect.Response[golfv1.GetRepositoryWikiWriteContextResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, access, e := s.wikiWriteAuthority(ctx, session, token, keyFrom(req.Msg.Repository), req.Msg.RepositoryId, "")
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryWikiWriteContextResponse{Access: access, CanWrite: true}), nil
}

type wikiOperationRecord struct {
	ID, UserID, ActorID, RepositoryID, OwnerID                                                                         int64
	ForgeURL, OperationID, Owner, Name, AccessRevision, Slug, ExpectedCommit, Phase, ResultSlug, ResultCommit, Failure string
	Kind                                                                                                               int32
	Fingerprint                                                                                                        []byte
	Created, Updated                                                                                                   time.Time
}

const wikiOperationColumns = `id,user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,access_revision,kind,slug,expected_commit_id,input_fingerprint,phase,result_slug,result_commit_id,failure_code,created_at,updated_at`

func scanWikiOperation(row interface{ Scan(...any) error }) (r wikiOperationRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ForgeURL, &r.ActorID, &r.OperationID, &r.RepositoryID, &r.OwnerID, &r.Owner, &r.Name, &r.AccessRevision, &r.Kind, &r.Slug, &r.ExpectedCommit, &r.Fingerprint, &r.Phase, &r.ResultSlug, &r.ResultCommit, &r.Failure, &r.Created, &r.Updated)
	return
}
func wikiOperationWire(r wikiOperationRecord) *golfv1.RepositoryWikiOperation {
	return &golfv1.RepositoryWikiOperation{Contract: wikiOperationContract, OperationId: r.OperationID, Repository: &golfv1.RepositoryKey{Owner: r.Owner, Name: r.Name}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), ActorId: strconv.FormatInt(r.ActorID, 10), Kind: golfv1.RepositoryWikiOperationKind(r.Kind), Slug: r.Slug, ExpectedCommitId: r.ExpectedCommit, InputSha256: hex.EncodeToString(r.Fingerprint), Phase: golfv1.RepositoryReleasePublicationPhase(golfv1.RepositoryReleasePublicationPhase_value["REPOSITORY_RELEASE_PUBLICATION_PHASE_"+r.Phase]), ResultSlug: r.ResultSlug, ResultCommitId: r.ResultCommit, FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}
}
func (s *Server) lockWikiOperation(ctx context.Context, tx *sql.Tx, id int64) (context.Context, error) {
	if _, e := tx.ExecContext(ctx, `SELECT golf_wiki_operation_lock($1,$2)`, s.config.ForgeURL, id); e != nil {
		return nil, errStorageUnavailable
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.ForgeURL, id, tx}), nil
}
func (s *Server) wikiOperationAuthority(ctx context.Context, session string, token forgeCredential, r wikiOperationRecord) error {
	actor, _, e := s.wikiWriteAuthority(ctx, session, token, repositoryKey{r.Owner, r.Name}, strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10))
	if e == nil && actor.ID != r.ActorID {
		return errUnauthenticated
	}
	return e
}
func (s *Server) wikiOperationPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitRepositoryWikiOperationRequest) error {
	_, access, e := s.wikiWriteAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	if e != nil {
		return e
	}
	if access.Revision != m.AccessRevision {
		return errRepositoryAccessConflict
	}
	if m.Kind == 1 {
		return nil
	}
	base, _ := repositoryPath(keyFrom(m.Repository))
	var row nativeWikiPage
	if _, e = s.forge(ctx, http.MethodGet, base+"/wiki/page/"+m.Slug, token, nil, &row); e != nil {
		return e
	}
	if row.Slug != m.Slug || row.Commit == nil || row.Commit.SHA != m.ExpectedCommitId || m.Kind == 2 && row.Title != m.Title {
		return errRepositoryAccessConflict
	}
	return nil
}
func wikiOperationNative(m *golfv1.SubmitRepositoryWikiOperationRequest) (method, suffix string, payload any) {
	if m.Kind == 3 {
		return http.MethodDelete, "/wiki/page/" + m.Slug, nil
	}
	method = http.MethodPatch
	suffix = "/wiki/page/" + m.Slug
	if m.Kind == 1 {
		method = http.MethodPost
		suffix = "/wiki/new"
	}
	return method, suffix, map[string]string{"title": m.Title, "content_base64": base64.StdEncoding.EncodeToString([]byte(m.Markdown)), "message": m.CommitMessage}
}

type wikiOperationPermitKey struct{}
type wikiOperationPermit struct {
	record  wikiOperationRecord
	request *golfv1.SubmitRepositoryWikiOperationRequest
}

func (s *Server) validateWikiOperationPermit(ctx context.Context, tx *sql.Tx, p wikiOperationPermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	want, suffix, payload := wikiOperationNative(p.request)
	base, _ := repositoryPath(key)
	a, e := json.Marshal(input)
	b, f := json.Marshal(payload)
	if tx == nil || repo.ID != r.RepositoryID || key.Owner != r.Owner || key.Name != r.Name || method != want || path != base+suffix || e != nil || f != nil || !bytes.Equal(a, b) || !bytes.Equal(r.Fingerprint, wikiOperationFingerprint(p.request)) {
		return errLifecycleBlocked
	}
	row, e := scanWikiOperation(tx.QueryRowContext(ctx, `SELECT `+wikiOperationColumns+` FROM golf_repository_wiki_operations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, r.ForgeURL))
	if e != nil || row.ActorID != r.ActorID || !bytes.Equal(row.Fingerprint, r.Fingerprint) {
		return errLifecycleBlocked
	}
	var blocked bool
	e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked_before_wiki_operation($1,$2) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.ForgeURL, r.RepositoryID).Scan(&blocked)
	if e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}
func (s *Server) advanceWikiOperation(ctx context.Context, session string, token forgeCredential, r wikiOperationRecord, phase string) (updated wikiOperationRecord, e error) {
	e = s.workflowTransaction(ctx, session, r.ActorID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID {
			return errUnauthenticated
		}
		held, e := s.lockWikiOperation(ctx, tx, r.RepositoryID)
		if e != nil {
			return e
		}
		if e = s.wikiOperationAuthority(held, session, token, r); e != nil {
			return e
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		updated, e = scanWikiOperation(tx.QueryRowContext(held, `UPDATE golf_repository_wiki_operations SET phase=$1,failure_code=$2 WHERE id=$3 AND phase=$4 RETURNING `+wikiOperationColumns, phase, failure, r.ID, r.Phase))
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return
}
func (s *Server) GetRepositoryWikiOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryWikiOperationRequest]) (*connect.Response[golfv1.GetRepositoryWikiOperationResponse], error) {
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
		return nil, rpcError(invalid("Inspect the original wiki operation UUID."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r wikiOperationRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanWikiOperation(s.db.QueryRowContext(ctx, `SELECT `+wikiOperationColumns+` FROM golf_repository_wiki_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, m.OperationId))
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
		e = s.wikiOperationAuthority(ctx, session, token, r)
	}
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryWikiOperationResponse{Operation: wikiOperationWire(r)}), nil
}
func (s *Server) SubmitRepositoryWikiOperation(ctx context.Context, req *connect.Request[golfv1.SubmitRepositoryWikiOperationRequest]) (*connect.Response[golfv1.SubmitRepositoryWikiOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateWikiOperation(m); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, _, e := s.wikiWriteAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	repoID, _ := discussionID(m.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	fingerprint := wikiOperationFingerprint(m)
	var r wikiOperationRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockWikiOperation(ctx, tx, repoID)
		if e != nil {
			return e
		}
		r, e = scanWikiOperation(tx.QueryRowContext(held, `SELECT `+wikiOperationColumns+` FROM golf_repository_wiki_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(r.Fingerprint, fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanWikiOperation(tx.QueryRowContext(held, `INSERT INTO golf_repository_wiki_operations(user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,access_revision,kind,slug,expected_commit_id,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING `+wikiOperationColumns, c.UserID, s.config.ForgeURL, actor.ID, m.OperationId, repoID, ownerID, m.Repository.Owner, m.Repository.Name, m.AccessRevision, int32(m.Kind), m.Slug, m.ExpectedCommitId, fingerprint))
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
		if e = s.wikiOperationPreflight(ctx, session, token, m); e != nil {
			r, e = s.advanceWikiOperation(ctx, session, token, r, "REJECTED")
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
		} else {
			r, e = s.advanceWikiOperation(ctx, session, token, r, "DISPATCH_UNKNOWN")
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				if c.UserID != r.UserID {
					return errUnauthenticated
				}
				held, e := s.lockWikiOperation(ctx, tx, repoID)
				if e != nil {
					return e
				}
				if e = s.wikiOperationPreflight(held, session, token, m); e != nil {
					return e
				}
				held = context.WithValue(held, wikiOperationPermitKey{}, wikiOperationPermit{r, proto.Clone(m).(*golfv1.SubmitRepositoryWikiOperationRequest)})
				method, suffix, payload := wikiOperationNative(m)
				base, _ := repositoryPath(keyFrom(m.Repository))
				var result nativeWikiPage
				status := http.StatusOK
				if m.Kind == 1 {
					status = http.StatusCreated
				} else if m.Kind == 3 {
					status = http.StatusNoContent
				}
				var output any = &result
				if m.Kind == 3 {
					output = nil
				}
				if _, e = s.forgeJSON(held, method, base+suffix, token, payload, output, status); e != nil {
					return nil
				}
				resultSlug, resultCommit := "", ""
				if m.Kind == 3 {
					var after nativeWikiPage
					_, e = s.forge(held, http.MethodGet, base+"/wiki/page/"+m.Slug, token, nil, &after)
					var native forgeError
					if !errors.As(e, &native) || native.status != http.StatusNotFound {
						return nil
					}
				} else {
					if !validWikiSlug(result.Slug) || result.Title != m.Title || result.Content != base64.StdEncoding.EncodeToString([]byte(m.Markdown)) || result.Commit == nil || !objectID.MatchString(result.Commit.SHA) || m.Kind == 2 && (result.Slug != m.Slug || result.Commit.SHA == m.ExpectedCommitId) {
						return nil
					}
					var repository Repository
					if _, e = s.forge(held, http.MethodGet, base, token, nil, &repository); e != nil || strconv.FormatInt(repository.ID, 10) != m.RepositoryId {
						return nil
					}
					if _, e = wikiMetadata(result.nativeWikiPageMetadata, repository); e != nil || result.Count == nil || *result.Count < 1 {
						return nil
					}
					var after nativeWikiPage
					if _, e = s.forge(held, http.MethodGet, base+"/wiki/page/"+result.Slug, token, nil, &after); e != nil {
						return nil
					}
					if after.Slug != result.Slug || after.Title != m.Title || after.Content != result.Content || after.Commit == nil || after.Commit.SHA != result.Commit.SHA {
						return nil
					}
					if _, e = wikiMetadata(after.nativeWikiPageMetadata, repository); e != nil || after.Count == nil || *after.Count < 1 {
						return nil
					}
					resultSlug, resultCommit = after.Slug, after.Commit.SHA
				}
				if e = s.wikiOperationAuthority(held, session, token, r); e != nil {
					return nil
				}
				r, e = scanWikiOperation(tx.QueryRowContext(held, `UPDATE golf_repository_wiki_operations SET phase='SUCCEEDED',result_slug=$1,result_commit_id=$2 WHERE id=$3 AND phase='DISPATCH_UNKNOWN' RETURNING `+wikiOperationColumns, resultSlug, resultCommit, r.ID))
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
	if e = s.wikiOperationAuthority(ctx, session, token, r); e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.SubmitRepositoryWikiOperationResponse{Operation: wikiOperationWire(r)}), nil
}

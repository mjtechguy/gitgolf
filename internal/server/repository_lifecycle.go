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
	"sync"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

var errLifecycleBlocked = connect.NewError(connect.CodeFailedPrecondition, errors.New("Repository lifecycle blocks this action. Inspect the current operation; do not retry an unknown effect."))

func lifecycleRPCError(err error) error {
	if errors.Is(err, errLifecycleBlocked) {
		return errLifecycleBlocked
	}
	mapped := rpcError(err)
	if errors.Is(err, errPasswordConfirmation) {
		var ce *connect.Error
		if errors.As(mapped, &ce) {
			ce.Meta().Set("Golf-Lifecycle-Effect", "none")
		}
	}
	return mapped
}

type lifecycleNativeRepository struct {
	forgeRepositorySettings
	NativeActions *bool `json:"has_actions"`
}

func wireLifecycleNative(row lifecycleNativeRepository, key repositoryKey) (*golfv1.RepositorySettings, error) {
	settings, e := wireRepositorySettings(row.forgeRepositorySettings, key)
	if e != nil {
		return nil, e
	}
	encoded, _ := json.Marshal(struct {
		General       string
		NativeActions *bool
	}{settings.Revision, row.NativeActions})
	digest := sha256.Sum256(encoded)
	settings.Revision = hex.EncodeToString(digest[:])
	return settings, nil
}
func (s *Server) readLifecycleNative(ctx context.Context, token forgeCredential, key repositoryKey) (lifecycleNativeRepository, *golfv1.RepositorySettings, error) {
	var row lifecycleNativeRepository
	base, e := repositoryPath(key)
	if e != nil {
		return row, nil, e
	}
	if _, e = s.forge(ctx, http.MethodGet, base, token, nil, &row); e != nil {
		return row, nil, e
	}
	settings, e := wireLifecycleNative(row, key)
	return row, settings, e
}

type lifecyclePermit struct {
	repositoryID int64
	userID       int64
	key          string
	archived     bool
	delete       bool
	ownerID      int64
	revision     string
}
type lifecyclePermitKey struct{}
type lifecycleBody struct {
	io.ReadCloser
	release func()
	once    sync.Once
}

func (b *lifecycleBody) Close() error { e := b.ReadCloser.Close(); b.once.Do(b.release); return e }

// This classifies existing supported repository-scoped Golf writes, not external
// Git/native ingress or an atomic immutable-ID predicate at the native server.
func lifecycleWriteRepository(method, path string) (repositoryKey, bool, error) {
	if method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions {
		return repositoryKey{}, false, nil
	}
	p := strings.Split(strings.SplitN(path, "?", 2)[0], "/")
	var key repositoryKey
	if len(p) >= 4 && p[1] == "repos" {
		key = repositoryKey{p[2], p[3]}
	} else if len(p) == 6 && p[1] == "teams" && p[3] == "repos" {
		if _, e := discussionID(p[2]); e != nil {
			return key, false, e
		}
		key = repositoryKey{p[4], p[5]}
	} else {
		return key, false, nil
	}
	owner, e := url.PathUnescape(key.Owner)
	if e != nil {
		return key, true, invalid("Invalid repository mutation path.")
	}
	name, e := url.PathUnescape(key.Name)
	if e != nil {
		return key, true, invalid("Invalid repository mutation path.")
	}
	key = repositoryKey{owner, name}
	_, e = repositoryPath(key)
	return key, true, e
}

// A private held scope is constructed only after the same transaction acquired
// the shared lifecycle gate. Nested supported native writes reuse that gate so
// an exclusive archive waiter cannot deadlock the existing holder.
type repositoryLifecycleTransactionKey struct{}
type repositoryLifecycleTransaction struct {
	forge        string
	repositoryID int64
	tx           *sql.Tx
}

func (s *Server) lockRepositoryLifecycleTransaction(ctx context.Context, tx *sql.Tx, repositoryID int64) (context.Context, error) {
	if tx == nil || repositoryID <= 0 {
		return nil, errStorageUnavailable
	}
	if _, e := tx.ExecContext(ctx, `SELECT golf_repository_lifecycle_lock($1,$2,false)`, s.config.GiteaURL, repositoryID); e != nil {
		return nil, errStorageUnavailable
	}
	var blocked bool
	if e := tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked($1,$2)`, s.config.GiteaURL, repositoryID).Scan(&blocked); e != nil {
		return nil, errStorageUnavailable
	}
	if blocked {
		return nil, errLifecycleBlocked
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.GiteaURL, repositoryID, tx}), nil
}

func (s *Server) beginRepositoryLifecycleWrite(ctx context.Context, method, path string, token forgeCredential, input any, request *http.Request) (releaseResult func(), resultErr error) {
	key, scoped, e := lifecycleWriteRepository(method, path)
	if e != nil {
		return nil, e
	}
	if !scoped || s.db == nil {
		return func() {}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer func() {
		if resultErr != nil {
			cancel()
		}
	}()
	*request = *request.WithContext(ctx)
	// Resolve once with this credential before any SQL lock; GET does not recurse.
	var repo lifecycleNativeRepository
	base, _ := repositoryPath(key)
	if _, e = s.forge(ctx, http.MethodGet, base, token, nil, &repo); e != nil {
		return nil, e
	}
	if !validRepository(repo.Repository) || !strings.EqualFold(repo.Name, key.Name) || !strings.EqualFold(repo.FullName, key.Owner+"/"+key.Name) {
		return nil, errInvalidForgeResponse
	}
	if held, ok := ctx.Value(repositoryLifecycleTransactionKey{}).(repositoryLifecycleTransaction); ok {
		if held.tx == nil || held.forge != s.config.GiteaURL || held.repositoryID != repo.ID {
			cancel()
			return nil, errLifecycleBlocked
		}
		var blocked bool
		if e = held.tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked($1,$2)`, s.config.GiteaURL, repo.ID).Scan(&blocked); e != nil {
			cancel()
			return nil, errStorageUnavailable
		}
		var reviewBlocked bool
		if e = held.tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_pull_review_lifecycle_operations WHERE forge_url=$1 AND repository_id=$2 AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, s.config.GiteaURL, repo.ID).Scan(&reviewBlocked); e != nil {
			cancel()
			return nil, errStorageUnavailable
		}
		if _, ownReview := ctx.Value(reviewLifecyclePermitKey{}).(reviewLifecyclePermit); reviewBlocked && !ownReview {
			cancel()
			return nil, errLifecycleBlocked
		}
		var commentBlocked bool
		if e = held.tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_pull_review_comment_operations WHERE forge_url=$1 AND repository_id=$2 AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, s.config.GiteaURL, repo.ID).Scan(&commentBlocked); e != nil {
			cancel()
			return nil, errStorageUnavailable
		}
		if _, ownComment := ctx.Value(reviewCommentPermitKey{}).(reviewCommentPermit); commentBlocked && !ownComment {
			cancel()
			return nil, errLifecycleBlocked
		}
		if permit, ok := ctx.Value(lifecyclePermitKey{}).(lifecyclePermit); ok {
			if e := s.validateLifecyclePermit(ctx, held.tx, permit, repo, key, method, path, base, token, input); e != nil {
				cancel()
				return nil, e
			}
		} else if mirror, ok := ctx.Value(mirrorPermitKey{}).(mirrorPermit); ok {
			if e := s.validateMirrorPermit(ctx, held.tx, mirror, repo, key, method, path, input); e != nil {
				cancel()
				return nil, e
			}
		} else if wiki, ok := ctx.Value(wikiOperationPermitKey{}).(wikiOperationPermit); ok {
			if e := s.validateWikiOperationPermit(ctx, held.tx, wiki, repo, key, method, path, input); e != nil {
				cancel()
				return nil, e
			}
		} else if release, ok := ctx.Value(releaseOperationPermitKey{}).(releaseOperationPermit); ok {
			if e := s.validateReleaseOperationPermit(ctx, held.tx, release, repo, key, method, path, input); e != nil {
				cancel()
				return nil, e
			}
		} else if publication, ok := ctx.Value(releasePublicationPermitKey{}).(releasePublicationPermit); ok {
			if e := s.validateReleasePublicationPermit(ctx, held.tx, publication, repo, key, method, path, input); e != nil {
				cancel()
				return nil, e
			}
		} else if review, ok := ctx.Value(reviewLifecyclePermitKey{}).(reviewLifecyclePermit); ok {
			if e := s.validateReviewLifecyclePermit(ctx, held.tx, review, repo, key, method, path, input); e != nil {
				cancel()
				return nil, e
			}
		} else if comment, ok := ctx.Value(reviewCommentPermitKey{}).(reviewCommentPermit); ok {
			if e := s.validateReviewCommentPermit(ctx, held.tx, comment, repo, key, method, path, input); e != nil {
				cancel()
				return nil, e
			}
		} else if review, ok := ctx.Value(reviewRequestPermitKey{}).(reviewRequestPermit); ok {
			if e := s.validateReviewRequestPermit(ctx, held.tx, review, repo, key, method, path, input); e != nil {
				cancel()
				return nil, e
			}
		} else if ref, ok := ctx.Value(refMutationPermitKey{}).(refMutationPermit); ok {
			if e := s.validateRefMutationPermit(ctx, held.tx, ref, repo, key, method, path, input); e != nil {
				cancel()
				return nil, e
			}
		} else if resource, ok := ctx.Value(discussionResourcePermitKey{}).(discussionResourcePermit); ok {
			if e := s.validateDiscussionResourcePermit(ctx, held.tx, resource, repo, key, method, path, input); e != nil {
				cancel()
				return nil, e
			}
		} else if file, ok := ctx.Value(fileMutationPermitKey{}).(fileMutationPermit); ok {
			if e := s.validateFileMutationPermit(ctx, held.tx, file, repo, key, method, path, input); e != nil {
				cancel()
				return nil, e
			}
		} else if blocked {
			cancel()
			return nil, errLifecycleBlocked
		}
		return cancel, nil
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return nil, errStorageUnavailable
	}
	release := func() { _ = tx.Rollback(); cancel() }
	if _, e = tx.ExecContext(ctx, `SELECT golf_repository_lifecycle_lock($1,$2,false)`, s.config.GiteaURL, repo.ID); e != nil {
		release()
		return nil, errStorageUnavailable
	}
	permit, permitted := ctx.Value(lifecyclePermitKey{}).(lifecyclePermit)
	if permitted {
		if e = s.validateLifecyclePermit(ctx, tx, permit, repo, key, method, path, base, token, input); e != nil {
			release()
			return nil, e
		}
	} else {
		var blocked bool
		e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked($1,$2)`, s.config.GiteaURL, repo.ID).Scan(&blocked)
		if e != nil || blocked {
			release()
			if e != nil {
				return nil, errStorageUnavailable
			}
			return nil, errLifecycleBlocked
		}
	}
	return release, nil
}
func wireLifecycleOperation(r database.GolfRepositoryLifecycleOperation) *golfv1.RepositoryLifecycleOperation {
	return &golfv1.RepositoryLifecycleOperation{IdempotencyKey: r.IdempotencyKey, Repository: &golfv1.RepositoryKey{Owner: r.RepositoryOwner, Name: r.RepositoryName}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), ActorId: strconv.FormatInt(r.ActorID, 10), FromArchived: r.FromArchived, ToArchived: r.ToArchived, ExpectedRevision: r.ExpectedRevision, Phase: r.Phase, FailureCode: r.FailureCode, CreatedAt: r.CreatedAt.Format(time.RFC3339Nano), UpdatedAt: r.UpdatedAt.Format(time.RFC3339Nano), Action: r.Action}
}

// Ownership is independently proved even for archived repositories; CanEdit in
// General intentionally becomes false when archived and cannot authorize this.
func (s *Server) lifecycleObservation(ctx context.Context, session string, token forgeCredential, key repositoryKey, repoID, ownerID string) (*golfv1.RepositoryLifecycle, error) {
	var result *golfv1.RepositoryLifecycle
	e := s.withForgeCaller(ctx, session, token, func(caller User) error {
		return s.withRepositoryRead(ctx, session, token, key, func(_ string, selected Repository) error {
			row, settings, e := s.readLifecycleNative(ctx, token, key)
			if e != nil {
				return e
			}
			if row.ID != selected.ID || settings.RepositoryId != repoID || ownerID != "" && settings.OwnerId != ownerID {
				return errRepositorySettingsConflict
			}
			org, e := s.repositoryOwnerKind(ctx, token, *row.Owner)
			if e != nil {
				return e
			}
			owner := caller.ID == row.Owner.ID
			if org {
				e = s.withOrganization(ctx, session, token, key.Owner, func(native forgeOrganization) error {
					if native.ID != row.Owner.ID {
						return errRepositorySettingsConflict
					}
					var e error
					owner, e = s.organizationOwner(ctx, token, native, caller)
					return e
				})
				if e != nil {
					return e
				}
			}
			manage := owner && row.Permissions.Admin && !*row.Mirror
			result = &golfv1.RepositoryLifecycle{Repository: &golfv1.RepositoryKey{Owner: key.Owner, Name: key.Name}, RepositoryId: settings.RepositoryId, OwnerId: settings.OwnerId, Revision: settings.Revision, Archived: *row.Archived, Mirror: *row.Mirror, CanManage: manage, StepUpAvailable: token.Local, DeleteNotice: "managed_native_boundary_unqualified"}
			if !manage {
				if *row.Mirror {
					result.BlockedReason = "mirror_unsupported"
				} else {
					result.BlockedReason = "owner_required"
				}
				return nil
			}
			if !token.Local {
				result.BlockedReason = "local_password_step_up_required"
				return nil
			}
			managedBlocked := false
			e = s.withManagedSession(ctx, session, token, func(q *database.Queries, _ database.LockManagedSessionRow, _ []byte) error {
				n, e := q.CountRepositoryLifecycleActive(ctx, database.CountRepositoryLifecycleActiveParams{ForgeURL: s.config.GiteaURL, RepositoryID: row.ID})
				if e != nil {
					return errStorageUnavailable
				}
				result.ActiveWorkCount = strconv.FormatInt(n, 10)
				result.Unresolved, e = q.RepositoryLifecycleUnresolved(ctx, database.RepositoryLifecycleUnresolvedParams{ForgeURL: s.config.GiteaURL, RepositoryID: row.ID})
				if e != nil {
					return errStorageUnavailable
				}
				managedBlocked, e = q.RepositoryLifecycleBlocked(ctx, database.RepositoryLifecycleBlockedParams{ForgeURL: s.config.GiteaURL, RepositoryID: row.ID})
				if e != nil {
					return errStorageUnavailable
				}
				return nil
			})
			if e != nil {
				return e
			}
			switch {
			case managedBlocked && !result.Unresolved && !result.Archived:
				result.BlockedReason = "managed_archive_fence"
			case row.NativeActions == nil || *row.NativeActions:
				result.BlockedReason = "native_actions_unqualified"
			case result.Unresolved:
				result.BlockedReason = "outcome_unresolved"
			case result.ActiveWorkCount != "0":
				result.BlockedReason = "active_work"
			default:
				result.ArchiveAvailable = !result.Archived
				result.UnarchiveAvailable = result.Archived
				if !managedBlocked {
					if e := s.deletionBoundary(ctx, s.db, token, key, row); e == nil {
						result.DeleteAvailable = true
						result.DeleteNotice = ""
					} else if !errors.Is(e, errDeletionBoundary) {
						return e
					}
				}
			}
			after, current, e := s.readLifecycleNative(ctx, token, key)
			if e != nil {
				return e
			}
			if current.RepositoryId != result.RepositoryId || current.OwnerId != result.OwnerId || current.Revision != result.Revision || after.Permissions.Admin != row.Permissions.Admin {
				return errRepositorySettingsConflict
			}
			if org {
				currentOwner, e := s.organizationOwner(ctx, token, forgeOrganization{ID: row.Owner.ID, Name: key.Owner}, caller)
				if e != nil {
					return e
				}
				if currentOwner != owner {
					return errRepositorySettingsConflict
				}
			}
			return nil
		})
	})
	return result, e
}
func lifecycleTarget(key repositoryKey, repoID, ownerID, revision string) error {
	if _, e := repositoryPath(key); e != nil {
		return e
	}
	if _, e := discussionID(repoID); e != nil {
		return invalid("Provide the exact repository identity.")
	}
	if ownerID != "" {
		if _, e := discussionID(ownerID); e != nil {
			return invalid("Provide the exact owner identity.")
		}
	}
	if revision != "" && !validAccessRevision(revision) {
		return invalid("Provide the displayed lifecycle revision.")
	}
	return nil
}
func (s *Server) GetRepositoryLifecycle(ctx context.Context, req *connect.Request[golfv1.GetRepositoryLifecycleRequest]) (*connect.Response[golfv1.GetRepositoryLifecycleResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	key := keyFrom(req.Msg.Repository)
	if e = lifecycleTarget(key, req.Msg.RepositoryId, "", ""); e != nil {
		return nil, lifecycleRPCError(e)
	}
	result, e := s.lifecycleObservation(ctx, session, token, key, req.Msg.RepositoryId, "")
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryLifecycleResponse{Lifecycle: result}), nil
}
func (s *Server) ownLifecycle(ctx context.Context, session string, token forgeCredential, key string) (database.GolfRepositoryLifecycleOperation, error) {
	var r database.GolfRepositoryLifecycleOperation
	e := s.withManagedSession(ctx, session, token, func(q *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = q.GetOwnRepositoryLifecycle(ctx, database.GetOwnRepositoryLifecycleParams{UserID: c.UserID, ForgeURL: s.config.GiteaURL, IdempotencyKey: key})
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return r, e
}
func (s *Server) GetRepositoryLifecycleOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryLifecycleOperationRequest]) (*connect.Response[golfv1.GetRepositoryLifecycleOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if e = lifecycleTarget(key, m.RepositoryId, m.OwnerId, ""); e != nil || !creationKey.MatchString(m.IdempotencyKey) {
		return nil, lifecycleRPCError(invalid("Provide the original operation and exact native target."))
	}
	observed, e := s.lifecycleObservation(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !observed.CanManage {
		return nil, lifecycleRPCError(forgeError{http.StatusForbidden})
	}
	r, e := s.ownLifecycle(ctx, session, token, m.IdempotencyKey)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if r.Action != "archive_state" || strconv.FormatInt(r.RepositoryID, 10) != m.RepositoryId || strconv.FormatInt(r.OwnerID, 10) != m.OwnerId || r.RepositoryOwner != key.Owner || r.RepositoryName != key.Name {
		return nil, lifecycleRPCError(errRepositorySettingsConflict)
	}
	return connect.NewResponse(&golfv1.GetRepositoryLifecycleOperationResponse{Operation: wireLifecycleOperation(r)}), nil
}
func (s *Server) lifecycleAdvance(ctx context.Context, session string, token forgeCredential, r database.GolfRepositoryLifecycleOperation, phase string) (database.GolfRepositoryLifecycleOperation, error) {
	e := s.withManagedSession(ctx, session, token, func(q *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID {
			return errUnauthenticated
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		var e error
		r, e = q.AdvanceRepositoryLifecycle(ctx, database.AdvanceRepositoryLifecycleParams{ID: r.ID, UserID: r.UserID, ForgeURL: s.config.GiteaURL, Phase: phase, FailureCode: failure})
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return r, e
}

// An uncertain effect does not waive current native or session authority.
func (s *Server) lifecycleUnknownResponse(ctx context.Context, session string, token forgeCredential, key repositoryKey, m *golfv1.ChangeRepositoryArchiveStateRequest, r database.GolfRepositoryLifecycleOperation) (*connect.Response[golfv1.ChangeRepositoryArchiveStateResponse], error) {
	current, e := s.lifecycleObservation(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !current.CanManage {
		return nil, lifecycleRPCError(forgeError{http.StatusForbidden})
	}
	return connect.NewResponse(&golfv1.ChangeRepositoryArchiveStateResponse{Operation: wireLifecycleOperation(r)}), nil
}
func (s *Server) ChangeRepositoryArchiveState(ctx context.Context, req *connect.Request[golfv1.ChangeRepositoryArchiveStateRequest]) (*connect.Response[golfv1.ChangeRepositoryArchiveStateResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if e = lifecycleTarget(key, m.RepositoryId, m.OwnerId, m.ExpectedRevision); e != nil {
		return nil, lifecycleRPCError(e)
	}
	if m.Archived == nil || m.ConfirmationName != key.Owner+"/"+key.Name || !creationKey.MatchString(m.IdempotencyKey) || m.OwnerId == "" || m.ExpectedRevision == "" {
		return nil, lifecycleRPCError(invalid("Confirm the exact full repository name, current target/revision and archive decision with an original operation key."))
	}
	observation, e := s.lifecycleObservation(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !observation.CanManage {
		return nil, lifecycleRPCError(forgeError{http.StatusForbidden})
	}
	encoded, _ := json.Marshal(struct {
		Repository                repositoryKey
		RepoID, OwnerID, Revision string
		Archived                  bool
	}{key, m.RepositoryId, m.OwnerId, m.ExpectedRevision, *m.Archived})
	fp := sha256.Sum256(encoded)
	existing, e := s.ownLifecycle(ctx, session, token, m.IdempotencyKey)
	if e == nil {
		if existing.Action != "archive_state" || !bytes.Equal(existing.Fingerprint, fp[:]) {
			return nil, lifecycleRPCError(errRepositorySettingsConflict)
		}
		return connect.NewResponse(&golfv1.ChangeRepositoryArchiveStateResponse{Operation: wireLifecycleOperation(existing)}), nil
	}
	if !errors.Is(e, errResourceNotFound) {
		return nil, lifecycleRPCError(e)
	}
	initial, e := s.ownSecuritySnapshot(ctx, session, token)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	correct, e := s.verifyLocalPasswordAttempt(ctx, initial.Username, m.CurrentPassword, initial.PasswordHash)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !correct {
		return nil, lifecycleRPCError(errPasswordConfirmation)
	}
	latest, e := s.ownSecuritySnapshot(ctx, session, token)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !sameOwnSecurity(initial, latest) {
		return nil, lifecycleRPCError(errUnauthenticated)
	}
	repoID, _ := discussionID(m.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	var r database.GolfRepositoryLifecycleOperation
	dispatch := false
	e = s.withManagedSession(ctx, session, token, func(q *database.Queries, c database.LockManagedSessionRow, hash []byte) error {
		current, e := q.GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
		if e != nil || !sameOwnSecurity(initial, current) {
			return errUnauthenticated
		}
		if e = q.LockRepositoryLifecycle(ctx, database.LockRepositoryLifecycleParams{ForgeURL: s.config.GiteaURL, RepositoryID: repoID}); e != nil {
			return errStorageUnavailable
		}
		active, e := q.CountRepositoryLifecycleActive(ctx, database.CountRepositoryLifecycleActiveParams{ForgeURL: s.config.GiteaURL, RepositoryID: repoID})
		if e != nil {
			return errStorageUnavailable
		}
		r, e = q.ReserveRepositoryLifecycle(ctx, database.ReserveRepositoryLifecycleParams{UserID: c.UserID, ForgeURL: s.config.GiteaURL, ActorID: initial.ForgeUserID, IdempotencyKey: m.IdempotencyKey, RepositoryID: repoID, OwnerID: ownerID, RepositoryOwner: key.Owner, RepositoryName: key.Name, ExpectedRevision: m.ExpectedRevision, FromArchived: observation.Archived, ToArchived: *m.Archived, Fingerprint: fp[:]})
		if errors.Is(e, sql.ErrNoRows) {
			r, e = q.GetOwnRepositoryLifecycle(ctx, database.GetOwnRepositoryLifecycleParams{UserID: c.UserID, ForgeURL: s.config.GiteaURL, IdempotencyKey: m.IdempotencyKey})
			if e != nil {
				return errStorageUnavailable
			}
			if !bytes.Equal(r.Fingerprint, fp[:]) {
				return errRepositorySettingsConflict
			}
			return nil
		}
		if e != nil {
			var state interface{ SQLState() string }
			if errors.As(e, &state) && state.SQLState() == "55000" {
				return errLifecycleBlocked
			}
			return errStorageUnavailable
		}
		if active > 0 || observation.BlockedReason != "" || observation.Revision != m.ExpectedRevision || observation.Archived == *m.Archived {
			r, e = q.AdvanceRepositoryLifecycle(ctx, database.AdvanceRepositoryLifecycleParams{ID: r.ID, UserID: c.UserID, ForgeURL: s.config.GiteaURL, Phase: "REJECTED", FailureCode: "preflight_refused"})
			if e != nil {
				return errStorageUnavailable
			}
			return nil
		}
		dispatch = true
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !dispatch {
		return connect.NewResponse(&golfv1.ChangeRepositoryArchiveStateResponse{Operation: wireLifecycleOperation(r)}), nil
	}
	// No native effect is possible in RESERVED. Any stranded reservation stays
	// inspection-only; there is deliberately no automatic repair/replay worker.
	fresh, e := s.lifecycleObservation(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if e != nil || !fresh.CanManage || (fresh.BlockedReason == "native_actions_unqualified" || fresh.BlockedReason == "managed_archive_fence") || fresh.Revision != m.ExpectedRevision || fresh.Archived == *m.Archived {
		r, reject := s.lifecycleAdvance(ctx, session, token, r, "REJECTED")
		if reject != nil {
			return nil, lifecycleRPCError(reject)
		}
		return connect.NewResponse(&golfv1.ChangeRepositoryArchiveStateResponse{Operation: wireLifecycleOperation(r)}), nil
	}
	r, e = s.lifecycleAdvance(ctx, session, token, r, "DISPATCH_UNKNOWN")
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	permit := lifecyclePermit{repositoryID: repoID, userID: r.UserID, key: r.IdempotencyKey, archived: r.ToArchived}
	writeCtx := context.WithValue(ctx, lifecyclePermitKey{}, permit)
	var receipt lifecycleNativeRepository
	base, _ := repositoryPath(key)
	_, e = s.forgeJSON(writeCtx, http.MethodPatch, base, token, map[string]bool{"archived": r.ToArchived}, &receipt, http.StatusOK)
	if e != nil {
		return s.lifecycleUnknownResponse(ctx, session, token, key, m, r)
	}
	native, settings, e := s.readLifecycleNative(ctx, token, key)
	if e != nil || receipt.ID != repoID || receipt.Owner == nil || receipt.Owner.ID != ownerID || receipt.Archived == nil || *receipt.Archived != r.ToArchived || native.ID != repoID || native.Owner.ID != ownerID || *native.Archived != r.ToArchived {
		return s.lifecycleUnknownResponse(ctx, session, token, key, m, r)
	}
	originalReceipt := receipt
	originalReceipt.Archived = &r.FromArchived
	originalSettings, originalErr := wireLifecycleNative(originalReceipt, key)
	if originalErr != nil || originalSettings.Revision != r.ExpectedRevision {
		return s.lifecycleUnknownResponse(ctx, session, token, key, m, r)
	}
	receiptSettings, e := wireLifecycleNative(receipt, key)
	if e != nil || receiptSettings.Revision != settings.Revision {
		return s.lifecycleUnknownResponse(ctx, session, token, key, m, r)
	}
	current, e := s.lifecycleObservation(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if e != nil || !current.CanManage || current.Archived != r.ToArchived {
		return nil, lifecycleRPCError(errLifecycleBlocked)
	}
	r, e = s.lifecycleAdvance(ctx, session, token, r, "SUCCEEDED")
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	current.Unresolved = false
	current.BlockedReason = ""
	current.ArchiveAvailable = !current.Archived
	current.UnarchiveAvailable = current.Archived
	return connect.NewResponse(&golfv1.ChangeRepositoryArchiveStateResponse{Lifecycle: current, Operation: wireLifecycleOperation(r)}), nil
}

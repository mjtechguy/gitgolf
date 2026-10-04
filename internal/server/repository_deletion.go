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

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

var errDeletionBoundary = connect.NewError(connect.CodeFailedPrecondition, errors.New("Repository deletion requires independently qualified private-native ingress and producer exclusions. Deletion is unavailable in this deployment."))

// An incarnation UUID alone never qualifies deletion. There is no enrollment
// command in this slice: adopted/default installations remain unavailable.
// The retained operator profile must bind source, images, runtime and receipt;
// its meaning still depends on independently qualified private-native bootstrap.
func (s *Server) deletionBoundary(ctx context.Context, db database.DBTX, token forgeCredential, key repositoryKey, row lifecycleNativeRepository) error {
	c := s.managedGit
	if !c.Enabled || c.Incarnation == "" || db == nil || row.Owner == nil || row.FullName != key.Owner+"/"+key.Name || row.Name != key.Name || row.Owner.Login != key.Owner || row.NativeActions == nil || *row.NativeActions || row.Mirror == nil || *row.Mirror {
		return errDeletionBoundary
	}
	var qualified int
	e := db.QueryRowContext(ctx, `SELECT 1 FROM golf_git_transport_profiles WHERE forge_url=$1 AND incarnation=$2 AND native_version='1.27.3' AND suspended_at IS NULL AND qualified_at<=clock_timestamp() AND qualifier_source_commit ~ '^[a-f0-9]{40}$' AND golf_image_digest ~ '^sha256:[a-f0-9]{64}$' AND native_image_digest ~ '^sha256:[a-f0-9]{64}$' AND native_runtime_id ~ '^[a-f0-9]{64}$' AND receipt_sha256 ~ '^[a-f0-9]{64}$' FOR SHARE`, s.config.GiteaURL, c.Incarnation).Scan(&qualified)
	if errors.Is(e, sql.ErrNoRows) {
		return errDeletionBoundary
	}
	if e != nil {
		return errStorageUnavailable
	}
	if qualified != 1 {
		return errDeletionBoundary
	}
	// Conservative foundation inherits the existing no-protection/no-mirror
	// prerequisite rather than claiming protected-write or background CAS closure.
	repo := gitNativeRepository{Repository: row.Repository, Mirror: row.Mirror, NativeActions: row.NativeActions}
	if e = s.gitWritePrerequisites(ctx, db, token, key, repo, c); e != nil {
		if errors.Is(e, errStorageUnavailable) {
			return e
		}
		return errDeletionBoundary
	}
	return nil
}

func (s *Server) validateLifecyclePermit(ctx context.Context, db database.DBTX, p lifecyclePermit, row lifecycleNativeRepository, key repositoryKey, method, path, base string, token forgeCredential, input any) error {
	if row.NativeActions == nil || *row.NativeActions || row.ID != p.repositoryID || path != base {
		return errLifecycleBlocked
	}
	action := "archive_state"
	if p.delete {
		action = "delete"
		settings, e := wireLifecycleNative(row, key)
		if e != nil || method != http.MethodDelete || input != nil || row.Owner.ID != p.ownerID || settings.Revision != p.revision || !row.Permissions.Admin {
			return errLifecycleBlocked
		}
		if e = s.deletionBoundary(ctx, db, token, key, row); e != nil {
			return e
		}
	} else {
		data, _ := json.Marshal(input)
		expected, _ := json.Marshal(map[string]bool{"archived": p.archived})
		if method != http.MethodPatch || !bytes.Equal(data, expected) {
			return errLifecycleBlocked
		}
	}
	var exact bool
	if e := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_repository_lifecycle_operations WHERE forge_url=$1 AND repository_id=$2 AND user_id=$3 AND idempotency_key=$4 AND to_archived=$5 AND action=$6 AND phase='DISPATCH_UNKNOWN' AND ($6<>'delete' OR (owner_id=$7 AND expected_revision=$8 AND repository_owner=$9 AND repository_name=$10)))`, s.config.GiteaURL, row.ID, p.userID, p.key, p.archived, action, p.ownerID, p.revision, key.Owner, key.Name).Scan(&exact); e != nil {
		return errStorageUnavailable
	}
	if !exact {
		return errLifecycleBlocked
	}
	return nil
}

func deletionMatches(r database.GolfRepositoryLifecycleOperation, key repositoryKey, repoID, ownerID string) bool {
	return r.Action == "delete" && strconv.FormatInt(r.RepositoryID, 10) == repoID && strconv.FormatInt(r.OwnerID, 10) == ownerID && r.RepositoryOwner == key.Owner && r.RepositoryName == key.Name
}

// Deliberately independent of repository GET: an original operation remains
// inspectable after deletion, but no replacement at its historical address is
// adopted. Organization identity and actual ownership remain current fences.
func (s *Server) deletionOwner(ctx context.Context, token forgeCredential, r database.GolfRepositoryLifecycleOperation) error {
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return e
	}
	if actor.ID != r.ActorID {
		return errUnauthenticated
	}
	if !r.OwnerIsOrganization {
		if actor.ID != r.OwnerID {
			return forgeError{http.StatusForbidden}
		}
		return nil
	}
	var org forgeOrganization
	if _, e = s.forge(ctx, http.MethodGet, "/orgs/"+r.RepositoryOwner, token, nil, &org); e != nil {
		return e
	}
	if !validOrganization(org) || org.ID != r.OwnerID || org.Name != r.RepositoryOwner {
		return errRepositorySettingsConflict
	}
	if e = s.requireOrganizationMember(ctx, token, org.Name, actor.Login); e != nil {
		return e
	}
	owner, e := s.organizationOwner(ctx, token, org, actor)
	if e != nil {
		return e
	}
	if !owner {
		return forgeError{http.StatusForbidden}
	}
	var after forgeOrganization
	if _, e = s.forge(ctx, http.MethodGet, "/orgs/"+r.RepositoryOwner, token, nil, &after); e != nil {
		return e
	}
	if !validOrganization(after) || after.ID != org.ID || after.Name != org.Name {
		return errRepositorySettingsConflict
	}
	if e = s.requireOrganizationMember(ctx, token, org.Name, actor.Login); e != nil {
		return e
	}
	currentOwner, e := s.organizationOwner(ctx, token, after, actor)
	if e != nil {
		return e
	}
	if !currentOwner {
		return forgeError{http.StatusForbidden}
	}
	return nil
}

func (s *Server) deletionStatus(ctx context.Context, session string, token forgeCredential, key repositoryKey, repoID, ownerID, operationKey string) (database.GolfRepositoryLifecycleOperation, error) {
	r, e := s.ownLifecycle(ctx, session, token, operationKey)
	if e != nil {
		return r, e
	}
	if !deletionMatches(r, key, repoID, ownerID) {
		return r, errRepositorySettingsConflict
	}
	e = s.withForgeCaller(ctx, session, token, func(User) error {
		if e := s.deletionOwner(ctx, token, r); e != nil {
			return e
		}
		return s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
			if c.UserID != r.UserID {
				return errUnauthenticated
			}
			return s.deletionOwner(ctx, token, r)
		})
	})
	return r, e
}

func deletionRPCError(e error) error {
	if errors.Is(e, errDeletionBoundary) {
		return errDeletionBoundary
	}
	return lifecycleRPCError(e)
}

func (s *Server) GetRepositoryDeletionOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryDeletionOperationRequest]) (*connect.Response[golfv1.GetRepositoryDeletionOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if e = lifecycleTarget(key, m.RepositoryId, m.OwnerId, ""); e != nil || m.OwnerId == "" || !creationKey.MatchString(m.IdempotencyKey) {
		return nil, deletionRPCError(invalid("Provide the original deletion operation and exact native target."))
	}
	r, e := s.deletionStatus(ctx, session, token, key, m.RepositoryId, m.OwnerId, m.IdempotencyKey)
	if e != nil {
		return nil, deletionRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryDeletionOperationResponse{Operation: wireLifecycleOperation(r)}), nil
}

func deletionFingerprint(m *golfv1.DeleteRepositoryRequest) []byte {
	data, _ := json.Marshal(struct {
		Action                    string
		Repository                repositoryKey
		RepoID, OwnerID, Revision string
	}{"delete", keyFrom(m.Repository), m.RepositoryId, m.OwnerId, m.ExpectedRevision})
	sum := sha256.Sum256(data)
	return sum[:]
}

func (s *Server) DeleteRepository(ctx context.Context, req *connect.Request[golfv1.DeleteRepositoryRequest]) (*connect.Response[golfv1.DeleteRepositoryResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if e = lifecycleTarget(key, m.RepositoryId, m.OwnerId, m.ExpectedRevision); e != nil {
		return nil, deletionRPCError(e)
	}
	if m.OwnerId == "" || m.ExpectedRevision == "" || m.ConfirmationName != key.Owner+"/"+key.Name || !creationKey.MatchString(m.IdempotencyKey) {
		return nil, deletionRPCError(invalid("Confirm the exact repository name, current native target/revision and original deletion key."))
	}
	fp := deletionFingerprint(m)
	existing, e := s.ownLifecycle(ctx, session, token, m.IdempotencyKey)
	if e == nil {
		if !deletionMatches(existing, key, m.RepositoryId, m.OwnerId) || !bytes.Equal(existing.Fingerprint, fp) {
			return nil, deletionRPCError(errRepositorySettingsConflict)
		}
		r, e := s.deletionStatus(ctx, session, token, key, m.RepositoryId, m.OwnerId, m.IdempotencyKey)
		if e != nil {
			return nil, deletionRPCError(e)
		}
		return connect.NewResponse(&golfv1.DeleteRepositoryResponse{Operation: wireLifecycleOperation(r)}), nil
	}
	if !errors.Is(e, errResourceNotFound) {
		return nil, deletionRPCError(e)
	}
	observed, e := s.lifecycleObservation(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, deletionRPCError(e)
	}
	if !observed.CanManage {
		return nil, deletionRPCError(forgeError{http.StatusForbidden})
	}
	// No operation is reserved on unqualified default deployments.
	if !observed.DeleteAvailable {
		return nil, deletionRPCError(errDeletionBoundary)
	}
	initial, e := s.ownSecuritySnapshot(ctx, session, token)
	if e != nil {
		return nil, deletionRPCError(e)
	}
	if e = s.consumeLocalLogin(ctx, initial.Username); e != nil {
		return nil, deletionRPCError(e)
	}
	correct, e := verifyLocalPassword(ctx, m.CurrentPassword, initial.PasswordHash)
	if e != nil {
		return nil, deletionRPCError(e)
	}
	if !correct {
		return nil, deletionRPCError(errPasswordConfirmation)
	}
	repoID, _ := discussionID(m.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	row, _, e := s.readLifecycleNative(ctx, token, key)
	if e != nil {
		return nil, deletionRPCError(e)
	}
	org, e := s.repositoryOwnerKind(ctx, token, *row.Owner)
	if e != nil {
		return nil, deletionRPCError(e)
	}
	var record database.GolfRepositoryLifecycleOperation
	reserved := false
	e = s.workflowTransaction(ctx, session, initial.ForgeUserID, func(tx *sql.Tx, c database.LockManagedSessionRow, hash []byte) error {
		q := database.New(tx)
		current, e := q.GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
		if e != nil || !sameOwnSecurity(initial, current) {
			return errUnauthenticated
		}
		if e = q.LockRepositoryLifecycle(ctx, database.LockRepositoryLifecycleParams{ForgeURL: s.config.GiteaURL, RepositoryID: repoID}); e != nil {
			return errStorageUnavailable
		}
		prior, priorErr := q.GetOwnRepositoryLifecycle(ctx, database.GetOwnRepositoryLifecycleParams{UserID: c.UserID, ForgeURL: s.config.GiteaURL, IdempotencyKey: m.IdempotencyKey})
		if priorErr == nil {
			if !deletionMatches(prior, key, m.RepositoryId, m.OwnerId) || !bytes.Equal(prior.Fingerprint, fp) {
				return errRepositorySettingsConflict
			}
			record = prior
			return nil
		}
		if !errors.Is(priorErr, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		active, e := q.CountRepositoryLifecycleActive(ctx, database.CountRepositoryLifecycleActiveParams{ForgeURL: s.config.GiteaURL, RepositoryID: repoID})
		if e != nil {
			return errStorageUnavailable
		}
		blocked, e := q.RepositoryLifecycleBlocked(ctx, database.RepositoryLifecycleBlockedParams{ForgeURL: s.config.GiteaURL, RepositoryID: repoID})
		if e != nil {
			return errStorageUnavailable
		}
		if blocked {
			return errLifecycleBlocked
		}
		record, e = q.ReserveRepositoryDeletion(ctx, database.ReserveRepositoryDeletionParams{UserID: c.UserID, ForgeURL: s.config.GiteaURL, ActorID: initial.ForgeUserID, IdempotencyKey: m.IdempotencyKey, RepositoryID: repoID, OwnerID: ownerID, RepositoryOwner: key.Owner, RepositoryName: key.Name, ExpectedRevision: m.ExpectedRevision, FromArchived: observed.Archived, Fingerprint: fp, OwnerIsOrganization: org})
		if errors.Is(e, sql.ErrNoRows) {
			record, e = q.GetOwnRepositoryLifecycle(ctx, database.GetOwnRepositoryLifecycleParams{UserID: c.UserID, ForgeURL: s.config.GiteaURL, IdempotencyKey: m.IdempotencyKey})
			if e != nil {
				return errStorageUnavailable
			}
			if !deletionMatches(record, key, m.RepositoryId, m.OwnerId) || !bytes.Equal(record.Fingerprint, fp) {
				return errRepositorySettingsConflict
			}
			return nil
		}
		if e != nil {
			return errStorageUnavailable
		}
		if active != 0 || observed.Revision != m.ExpectedRevision {
			record, e = q.AdvanceRepositoryLifecycle(ctx, database.AdvanceRepositoryLifecycleParams{ID: record.ID, UserID: c.UserID, ForgeURL: s.config.GiteaURL, Phase: "REJECTED", FailureCode: "preflight_refused"})
			if e != nil {
				return errStorageUnavailable
			}
			return nil
		}
		if e = s.deletionBoundary(ctx, tx, token, key, row); e != nil {
			return e
		}
		reserved = true
		return nil
	})
	if e != nil {
		return nil, deletionRPCError(e)
	}
	if !reserved {
		r, e := s.deletionStatus(ctx, session, token, key, m.RepositoryId, m.OwnerId, m.IdempotencyKey)
		if e != nil {
			return nil, deletionRPCError(e)
		}
		return connect.NewResponse(&golfv1.DeleteRepositoryResponse{Operation: wireLifecycleOperation(r)}), nil
	}
	// Durable uncertainty precedes any provider effect. No repair/replay worker.
	record, e = s.lifecycleAdvance(ctx, session, token, record, "DISPATCH_UNKNOWN")
	if e != nil {
		return nil, deletionRPCError(e)
	}
	e = s.workflowTransaction(ctx, session, record.ActorID, func(tx *sql.Tx, c database.LockManagedSessionRow, hash []byte) error {
		if c.UserID != record.UserID {
			return errUnauthenticated
		}
		q := database.New(tx)
		current, e := q.GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
		if e != nil || !sameOwnSecurity(initial, current) {
			return errUnauthenticated
		}
		if _, e = tx.ExecContext(ctx, `SELECT golf_repository_lifecycle_lock($1,$2,false)`, s.config.GiteaURL, repoID); e != nil {
			return errStorageUnavailable
		}
		fresh, settings, e := s.readLifecycleNative(ctx, token, key)
		if e != nil {
			return e
		}
		if settings.RepositoryId != m.RepositoryId || settings.OwnerId != m.OwnerId || settings.Revision != m.ExpectedRevision || !fresh.Permissions.Admin {
			return errRepositorySettingsConflict
		}
		if e = s.deletionOwner(ctx, token, record); e != nil {
			return e
		}
		if e = s.deletionBoundary(ctx, tx, token, key, fresh); e != nil {
			return e
		}
		permit := lifecyclePermit{repositoryID: repoID, userID: record.UserID, key: record.IdempotencyKey, archived: record.ToArchived, delete: true, ownerID: ownerID, revision: record.ExpectedRevision}
		held := context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.GiteaURL, repoID, tx})
		held = context.WithValue(held, lifecyclePermitKey{}, permit)
		base, _ := repositoryPath(key)
		if _, e = s.forgeJSON(held, http.MethodDelete, base, token, nil, nil, http.StatusNoContent); e != nil {
			return e
		}
		// A204 proves the supported call completed, not external-ingress CAS. Never
		// inspect a404 or an address replacement as a substitute for this receipt.
		if e = s.deletionOwner(ctx, token, record); e != nil {
			return e
		}
		current, e = q.GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
		if e != nil || !sameOwnSecurity(initial, current) {
			return errUnauthenticated
		}
		record, e = q.AdvanceRepositoryLifecycle(ctx, database.AdvanceRepositoryLifecycleParams{ID: record.ID, UserID: c.UserID, ForgeURL: s.config.GiteaURL, Phase: "SUCCEEDED"})
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	// Any failure after uncertainty commits is status-only, including a known
	// pre-forward refusal. No fresh key can bypass the retained repository gate.
	r, statusErr := s.deletionStatus(ctx, session, token, key, m.RepositoryId, m.OwnerId, m.IdempotencyKey)
	if statusErr != nil {
		return nil, deletionRPCError(statusErr)
	}
	if e != nil && r.Phase == "SUCCEEDED" {
		return nil, deletionRPCError(errStorageUnavailable)
	}
	return connect.NewResponse(&golfv1.DeleteRepositoryResponse{Operation: wireLifecycleOperation(r)}), nil
}

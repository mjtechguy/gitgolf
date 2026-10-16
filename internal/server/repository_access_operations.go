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
)

var errRepositoryAccessUnresolved = connect.NewError(connect.CodeFailedPrecondition, errors.New("An original access change is unresolved. Inspect its original operation; do not retry or replace it."))

type repositoryAccessOperation struct {
	ID, UserID, RepositoryID, OwnerID, ActorID, RecipientID, Generation                                               int64
	Forge, Key, Owner, Name, Login, AccessRevision, RecipientRevision, Permission, Phase, Failure, ObservedPermission string
	Remove, ObservedDirect                                                                                            bool
	Hash                                                                                                              []byte
	CreatedAt, UpdatedAt                                                                                              time.Time
}

const accessOperationColumns = `id,user_id,forge_url,idempotency_key,repository_id,owner_id,repository_owner,repository_name,actor_id,recipient_id,recipient_login,access_revision,recipient_revision,requested_permission,remove,generation,input_hash,phase,failure_code,observed_permission,observed_direct,created_at,updated_at`

func scanAccessOperation(row workflowRunScanner) (repositoryAccessOperation, error) {
	var r repositoryAccessOperation
	e := row.Scan(&r.ID, &r.UserID, &r.Forge, &r.Key, &r.RepositoryID, &r.OwnerID, &r.Owner, &r.Name, &r.ActorID, &r.RecipientID, &r.Login, &r.AccessRevision, &r.RecipientRevision, &r.Permission, &r.Remove, &r.Generation, &r.Hash, &r.Phase, &r.Failure, &r.ObservedPermission, &r.ObservedDirect, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(e, sql.ErrNoRows) {
		return r, errResourceNotFound
	}
	if e != nil {
		return r, errStorageUnavailable
	}
	return r, nil
}
func wireAccessOperation(r repositoryAccessOperation) *golfv1.RepositoryAccessOperation {
	return &golfv1.RepositoryAccessOperation{IdempotencyKey: r.Key, Repository: &golfv1.RepositoryKey{Owner: r.Owner, Name: r.Name}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), RecipientId: strconv.FormatInt(r.RecipientID, 10), RecipientLogin: r.Login, ActorId: strconv.FormatInt(r.ActorID, 10), RequestedPermission: r.Permission, Remove: r.Remove, Generation: strconv.FormatInt(r.Generation, 10), Phase: r.Phase, FailureCode: r.Failure, CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: r.UpdatedAt.UTC().Format(time.RFC3339Nano), ObservedEffectivePermission: r.ObservedPermission, ObservedDirectMembership: r.ObservedDirect}
}
func (s *Server) accessGeneration(ctx context.Context, repo, recipient string) (int64, error) {
	if s.db == nil {
		return 0, errStorageUnavailable
	}
	var generation int64
	e := s.db.QueryRowContext(ctx, `SELECT generation FROM golf_repository_access_generations WHERE forge_url=$1 AND repository_id=$2 AND recipient_id=$3`, s.config.ForgeURL, repo, recipient).Scan(&generation)
	if errors.Is(e, sql.ErrNoRows) {
		return 0, nil
	}
	if e != nil {
		return 0, errStorageUnavailable
	}
	return generation, nil
}
func collaboratorRevision(a *golfv1.RepositoryAccess, c *golfv1.RepositoryCollaborator, generation int64) string {
	// Proved non-owner observations preserve the pre-048 zero-generation digest,
	// including pending invitations. Positive actual organization ownership gets
	// a discriminator even at generation zero. Unknown ownership is never read as
	// a successful organization target and never authorizes a mutation.
	legacy := struct {
		RepoID, OwnerID, UserID, Login, Permission string
		Direct                                     bool
	}{a.RepositoryId, a.OwnerId, c.User.Id, strings.ToLower(c.User.Login), c.Permission, c.IsDirect}
	if c.ActualOrganizationOwner != nil && *c.ActualOrganizationOwner {
		return accessRevision(struct {
			Native                  any
			Generation              int64
			ActualOrganizationOwner bool
		}{legacy, generation, true})
	}
	if generation == 0 {
		return accessRevision(legacy)
	}
	return accessRevision(struct {
		Native     any
		Generation int64
	}{legacy, generation})
}
func (s *Server) lockAccessTarget(ctx context.Context, tx *sql.Tx, repo, recipient int64) (context.Context, error) {
	held, e := s.lockRepositoryLifecycleTransaction(ctx, tx, repo)
	if e != nil {
		return nil, e
	}
	if _, e = tx.ExecContext(ctx, `-- name: ConcurrentAccessTarget
SELECT golf_repository_access_lock($1,$2,$3)`, s.config.ForgeURL, repo, recipient); e != nil {
		return nil, errStorageUnavailable
	}
	return held, nil
}
func (s *Server) accessSlot(ctx context.Context, tx *sql.Tx, repo, recipient int64) (int64, sql.NullInt64, sql.NullInt64, error) {
	var generation int64
	var direct, invitation sql.NullInt64
	_, e := tx.ExecContext(ctx, `INSERT INTO golf_repository_access_generations(forge_url,repository_id,recipient_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, s.config.ForgeURL, repo, recipient)
	if e == nil {
		e = tx.QueryRowContext(ctx, `SELECT generation,direct_operation_id,invitation_operation_id FROM golf_repository_access_generations WHERE forge_url=$1 AND repository_id=$2 AND recipient_id=$3 FOR UPDATE`, s.config.ForgeURL, repo, recipient).Scan(&generation, &direct, &invitation)
	}
	if e != nil {
		return 0, direct, invitation, errStorageUnavailable
	}
	return generation, direct, invitation, nil
}
func (s *Server) accessSlotAvailable(ctx context.Context, tx *sql.Tx, direct, invitation sql.NullInt64) error {
	var unresolved bool
	if direct.Valid {
		if e := tx.QueryRowContext(ctx, `SELECT phase IN ('RESERVED','DISPATCH_UNKNOWN') FROM golf_repository_access_operations WHERE id=$1`, direct.Int64).Scan(&unresolved); e != nil {
			return errStorageUnavailable
		}
		if unresolved {
			return errRepositoryAccessUnresolved
		}
	}
	if invitation.Valid {
		if e := tx.QueryRowContext(ctx, `SELECT phase IN ('RESERVED','DISPATCH_UNKNOWN') FROM golf_repository_invitation_operations WHERE id=$1`, invitation.Int64).Scan(&unresolved); e != nil {
			return errStorageUnavailable
		}
		if unresolved {
			return errRepositoryAccessUnresolved
		}
	}
	return nil
}
func accessOperationAdvance(ctx context.Context, tx *sql.Tx, r repositoryAccessOperation, phase string, member *golfv1.RepositoryCollaborator) (repositoryAccessOperation, error) {
	failure, permission := "", ""
	direct := false
	if phase == "REJECTED" {
		failure = "preflight_refused"
	}
	if phase == "SUCCEEDED" {
		permission = member.Permission
		direct = member.IsDirect
	}
	return scanAccessOperation(tx.QueryRowContext(ctx, `UPDATE golf_repository_access_operations SET phase=$2,failure_code=$3,observed_permission=$4,observed_direct=$5,updated_at=clock_timestamp() WHERE id=$1 RETURNING `+accessOperationColumns, r.ID, phase, failure, permission, direct))
}
func (s *Server) accessOperationAuthority(ctx context.Context, token forgeCredential, key repositoryKey, caller User, r repositoryAccessOperation) (*golfv1.RepositoryAccess, error) {
	a, e := s.readRepositoryAccess(ctx, token, key, caller)
	if e != nil {
		return nil, e
	}
	if e = accessMatches(a, strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10), r.AccessRevision); e != nil {
		return nil, e
	}
	if caller.ID != r.ActorID {
		return nil, errUnauthenticated
	}
	return a, nil
}
func accessOperationFingerprint(key repositoryKey, repo, owner, revision, login, user, targetRevision, permission, operationKey string, remove bool) []byte {
	b, _ := json.Marshal(struct {
		Repository                                                          repositoryKey
		Repo, Owner, Revision, Login, User, TargetRevision, Permission, Key string
		Remove                                                              bool
	}{key, repo, owner, revision, login, user, targetRevision, permission, operationKey, remove})
	v := sha256.Sum256(b)
	return v[:]
}
func (s *Server) mutateRepositoryAccessIntent(ctx context.Context, value string, token forgeCredential, key repositoryKey, repoID, ownerID, revision, login, userID, targetRevision, permission, operationKey string, remove bool) (*golfv1.RepositoryCollaborator, *golfv1.RepositoryAccessOperation, error) {
	if e := validateRepositoryAccess(key, repoID, ownerID, revision, login); e != nil {
		return nil, nil, e
	}
	repo, e := discussionID(repoID)
	if e != nil {
		return nil, nil, e
	}
	recipient, e := discussionID(userID)
	if e != nil {
		return nil, nil, e
	}
	owner, _ := discussionID(ownerID)
	if login == "" || !creationKey.MatchString(operationKey) || !validAccessRevision(targetRevision) || (!remove && permission != "read" && permission != "write" && permission != "admin") || (remove && permission != "") {
		return nil, nil, invalid("Provide the exact reviewed target and an original access operation key.")
	}
	fingerprint := accessOperationFingerprint(key, repoID, ownerID, revision, login, userID, targetRevision, permission, operationKey, remove)
	var op repositoryAccessOperation
	created := false
	knownAbsent := false
	var member *golfv1.RepositoryCollaborator
	e = s.withForgeCaller(ctx, value, token, func(caller User) error {
		return s.workflowTransaction(ctx, value, caller.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, _ []byte) error {
			if _, e := s.lockAccessTarget(ctx, tx, repo, recipient); e != nil {
				return e
			}
			a, e := s.readRepositoryAccess(ctx, token, key, caller)
			if e != nil {
				return e
			}
			if e = accessMatches(a, repoID, ownerID, a.Revision); e != nil {
				return e
			}
			previous, e := scanAccessOperation(tx.QueryRowContext(ctx, `SELECT `+accessOperationColumns+` FROM golf_repository_access_operations WHERE user_id=$1 AND idempotency_key=$2`, actor.UserID, operationKey))
			if e == nil {
				if a.Revision != previous.AccessRevision || !bytes.Equal(previous.Hash, fingerprint) {
					return errRepositoryAccessConflict
				}
				op = previous
				return nil
			}
			if !errors.Is(e, errResourceNotFound) {
				return e
			}
			knownAbsent = true
			if a.Revision != revision {
				return errRepositoryAccessConflict
			}
			if recipient == owner || recipient == caller.ID {
				return forgeError{http.StatusForbidden}
			}
			generation, direct, invite, e := s.accessSlot(ctx, tx, repo, recipient)
			if e != nil {
				return e
			}

			member, e = s.readRepositoryCollaborator(ctx, token, key, a, login)
			if e != nil {
				return e
			}
			if member.User.Id != userID || member.Revision != targetRevision {
				return errRepositoryAccessConflict
			}
			if protectedCollaboratorTarget(a, member, caller.ID) {
				return forgeError{http.StatusForbidden}
			}
			if remove && !member.IsDirect {
				return errRepositoryAccessConflict
			}
			fresh, e := s.readRepositoryAccess(ctx, token, key, caller)
			if e != nil {
				return e
			}
			if e = accessMatches(fresh, repoID, ownerID, revision); e != nil {
				return e
			}
			if e = s.accessSlotAvailable(ctx, tx, direct, invite); e != nil {
				return e
			}
			if generation == 9223372036854775807 {
				return invalid("Access generation exhausted.")
			}
			op, e = scanAccessOperation(tx.QueryRowContext(ctx, `INSERT INTO golf_repository_access_operations(user_id,forge_url,idempotency_key,repository_id,owner_id,repository_owner,repository_name,actor_id,recipient_id,recipient_login,access_revision,recipient_revision,requested_permission,remove,generation,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING `+accessOperationColumns, actor.UserID, s.config.ForgeURL, operationKey, repo, owner, key.Owner, key.Name, caller.ID, recipient, login, revision, targetRevision, permission, remove, generation+1, fingerprint))
			if e != nil {
				return e
			}
			_, e = tx.ExecContext(ctx, `UPDATE golf_repository_access_generations SET generation=$4,direct_operation_id=$5,invitation_operation_id=NULL WHERE forge_url=$1 AND repository_id=$2 AND recipient_id=$3`, s.config.ForgeURL, repo, recipient, op.Generation, op.ID)
			if e != nil {
				return errStorageUnavailable
			}
			created = true
			return nil
		})
	})
	if e != nil {
		if knownAbsent && !created && (errors.Is(e, errRepositoryAccessConflict) || connect.CodeOf(rpcError(e)) == connect.CodePermissionDenied) {
			mapped := rpcError(e)
			var ce *connect.Error
			if errors.As(mapped, &ce) {
				ce.Meta().Set("Golf-Access-Effect", "none")
			}
			return nil, nil, mapped
		}
		return nil, nil, e
	}
	// Replayed keys inspect only, including stranded RESERVED intents after restart.
	if !created {
		return nil, wireAccessOperation(op), nil
	}
	member = nil
	dispatch := false
	e = s.withForgeCaller(ctx, value, token, func(caller User) error {
		return s.workflowTransaction(ctx, value, caller.ID, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte) error {
			if _, e := s.lockAccessTarget(ctx, tx, repo, recipient); e != nil {
				return e
			}
			a, e := s.accessOperationAuthority(ctx, token, key, caller, op)
			if e != nil {
				return e
			}
			generation, direct, _, e := s.accessSlot(ctx, tx, repo, recipient)
			if e != nil {
				return e
			}
			if generation != op.Generation || !direct.Valid || direct.Int64 != op.ID {
				return errRepositoryAccessConflict
			}
			current, e := s.readRepositoryCollaborator(ctx, token, key, a, login)
			if e != nil {
				return e
			}
			if current.User.Id != userID || collaboratorRevision(a, current, generation-1) != targetRevision || protectedCollaboratorTarget(a, current, caller.ID) || (remove && !current.IsDirect) {
				op, e = accessOperationAdvance(ctx, tx, op, "REJECTED", nil)
				return e
			}
			op, e = accessOperationAdvance(ctx, tx, op, "DISPATCH_UNKNOWN", nil)
			if e == nil {
				dispatch = true
			}
			return e
		})
	})
	if e != nil {
		return nil, nil, e
	}
	if !dispatch {
		return nil, wireAccessOperation(op), nil
	}
	e = s.withForgeCaller(ctx, value, token, func(caller User) error {
		return s.workflowTransaction(ctx, value, caller.ID, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte) error {
			held, e := s.lockAccessTarget(ctx, tx, repo, recipient)
			if e != nil {
				return e
			}
			a, e := s.accessOperationAuthority(ctx, token, key, caller, op)
			if e != nil {
				return e
			}
			generation, direct, _, e := s.accessSlot(ctx, tx, repo, recipient)
			if e != nil {
				return e
			}
			if generation != op.Generation || !direct.Valid || direct.Int64 != op.ID {
				return errRepositoryAccessConflict
			}
			before, e := s.readRepositoryCollaborator(ctx, token, key, a, login)
			if e != nil {
				return e
			}
			if before.User.Id != userID || collaboratorRevision(a, before, generation-1) != targetRevision || protectedCollaboratorTarget(a, before, caller.ID) || (remove && !before.IsDirect) {
				return errRepositoryAccessConflict
			}
			base, _ := repositoryPath(key)
			method := http.MethodPut
			var payload any = map[string]string{"permission": permission}
			if remove {
				method = http.MethodDelete
				payload = nil
			}
			_, nativeError := s.forgeJSON(held, method, base+"/collaborators/"+before.User.Login, token, payload, nil, http.StatusNoContent)
			// Both success and uncertainty remain private behind current native authority.
			after, e := s.accessOperationAuthority(ctx, token, key, caller, op)
			if e != nil {
				return e
			}
			if nativeError != nil {
				return nil
			}
			observed, e := s.readRepositoryCollaborator(ctx, token, key, after, login)
			if e != nil {
				return nil
			}
			if observed.User.Id != userID || protectedCollaboratorTarget(after, observed, caller.ID) || observed.IsDirect == remove || (!remove && !observedAccessAllows(observed.Permission, permission)) {
				return nil
			}
			if _, e = s.accessOperationAuthority(ctx, token, key, caller, op); e != nil {
				return e
			}
			op, e = accessOperationAdvance(ctx, tx, op, "SUCCEEDED", observed)
			if e != nil {
				return e
			}
			_, e = tx.ExecContext(ctx, `UPDATE golf_repository_access_generations SET direct_operation_id=NULL WHERE forge_url=$1 AND repository_id=$2 AND recipient_id=$3`, s.config.ForgeURL, repo, recipient)
			if e != nil {
				return errStorageUnavailable
			}
			member = observed
			return nil
		})
	})
	if e != nil {
		return nil, nil, e
	}
	return member, wireAccessOperation(op), nil
}
func (s *Server) GetRepositoryAccessOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryAccessOperationRequest]) (*connect.Response[golfv1.GetRepositoryAccessOperationResponse], error) {
	token, value, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if e = validateRepositoryAccess(key, m.RepositoryId, m.OwnerId, m.ExpectedRevision, ""); e != nil {
		return nil, rpcError(e)
	}
	if _, e = discussionID(m.UserId); e != nil || !creationKey.MatchString(m.IdempotencyKey) {
		return nil, rpcError(invalid("Provide the exact recipient and original access operation key."))
	}
	var result golfv1.GetRepositoryAccessOperationResponse
	e = s.withForgeCaller(ctx, value, token, func(caller User) error {
		return s.workflowTransaction(ctx, value, caller.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, _ []byte) error {
			a, e := s.readRepositoryAccess(ctx, token, key, caller)
			if e != nil {
				return e
			}
			if e = accessMatches(a, m.RepositoryId, m.OwnerId, m.ExpectedRevision); e != nil {
				return e
			}
			op, e := scanAccessOperation(tx.QueryRowContext(ctx, `SELECT `+accessOperationColumns+` FROM golf_repository_access_operations WHERE user_id=$1 AND idempotency_key=$2`, actor.UserID, m.IdempotencyKey))
			if e != nil {
				return e
			}
			if strconv.FormatInt(op.RepositoryID, 10) != m.RepositoryId || strconv.FormatInt(op.OwnerID, 10) != m.OwnerId || strconv.FormatInt(op.RecipientID, 10) != m.UserId || op.ActorID != caller.ID {
				return errRepositoryAccessConflict
			}
			if _, e = s.accessOperationAuthority(ctx, token, key, caller, op); e != nil {
				return e
			}
			// Historical operation observations are never silently replaced by a fresh read.
			result.Operation = wireAccessOperation(op)
			return nil
		})
	})
	if e != nil {
		return nil, infrastructureRPCError(e)
	}
	return connect.NewResponse(&result), nil
}

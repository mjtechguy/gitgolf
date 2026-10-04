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
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

var errInvitationAuthority = connect.NewError(connect.CodePermissionDenied, errors.New("Current invitation issuer authority is unavailable. Inspect the original invitation; do not retry an unknown grant."))

func invitationID(value string) (uuid.UUID, error) {
	id, e := uuid.Parse(value)
	if e != nil || id.String() != value || id.Version() != 4 {
		return uuid.Nil, invalid("Provide the exact invitation ID.")
	}
	return id, nil
}
func invitationRevision(value string) (int64, error) {
	n, e := discussionID(value)
	if e != nil {
		return 0, invalid("Provide the current invitation revision.")
	}
	return n, nil
}
func invitationKey(r database.GolfRepositoryInvitation) repositoryKey {
	return repositoryKey{r.RepositoryOwner, r.RepositoryName}
}
func invitationWire(r database.GolfRepositoryInvitation, details bool) *golfv1.RepositoryInvitation {
	v := &golfv1.RepositoryInvitation{Id: r.ID.String(), Revision: strconv.FormatInt(r.Revision, 10), State: r.State, ExpiresAt: r.ExpiresAt.UTC().Format(time.RFC3339Nano), CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339Nano), DetailsAvailable: details}
	if details {
		v.Repository = &golfv1.RepositoryKey{Owner: r.RepositoryOwner, Name: r.RepositoryName}
		v.RepositoryId = strconv.FormatInt(r.RepositoryID, 10)
		v.OwnerId = strconv.FormatInt(r.OwnerID, 10)
		v.Issuer = wireUser(User{ID: r.IssuerNativeID, Login: r.IssuerLogin})
		v.Recipient = wireUser(User{ID: r.RecipientNativeID, Login: r.RecipientLogin})
		v.Permission = r.Permission
		v.OrganizationOwned = r.OrganizationOwned
	}
	return v
}
func invitationOperationWire(r database.GolfRepositoryInvitationOperation, i database.GolfRepositoryInvitation) *golfv1.RepositoryInvitationOperation {
	return &golfv1.RepositoryInvitationOperation{IdempotencyKey: r.IdempotencyKey, InvitationId: r.InvitationID.String(), InvitationRevision: strconv.FormatInt(r.InvitationRevision, 10), RepositoryId: strconv.FormatInt(i.RepositoryID, 10), OwnerId: strconv.FormatInt(i.OwnerID, 10), RecipientId: strconv.FormatInt(i.RecipientNativeID, 10), Phase: r.Phase, FailureCode: r.FailureCode, CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: r.UpdatedAt.UTC().Format(time.RFC3339Nano)}
}

// Positive individual/direct-member/org-owner proof; effective "owner" from a
// native site administrator and team admin alone never delegate another user.
func (s *Server) invitationAdmin(ctx context.Context, token forgeCredential, key repositoryKey, caller User) (*golfv1.RepositoryAccess, error) {
	a, e := s.readRepositoryAccess(ctx, token, key, caller)
	if e != nil {
		return nil, e
	}
	row, _, e := s.readRepositorySettings(ctx, token, key)
	if e != nil {
		return nil, e
	}
	if a.RepositoryId != strconv.FormatInt(row.ID, 10) || a.OwnerId != strconv.FormatInt(row.Owner.ID, 10) {
		return nil, errRepositoryAccessConflict
	}
	if !row.Permissions.Admin || *row.Archived || *row.Mirror {
		return nil, forgeError{http.StatusForbidden}
	}
	manage := a.CanManage
	if a.OrganizationOwned {
		var org forgeOrganization
		_, e = s.forge(ctx, http.MethodGet, "/orgs/"+key.Owner, token, nil, &org)
		if e != nil {
			return nil, e
		}
		if !validOrganization(org) || strconv.FormatInt(org.ID, 10) != a.OwnerId {
			return nil, errRepositoryAccessConflict
		}
		_, e = s.forgeJSON(ctx, http.MethodGet, "/orgs/"+org.Name+"/members/"+caller.Login, token, nil, nil, http.StatusNoContent)
		if e != nil {
			return nil, e
		}
		owner, e := s.organizationOwner(ctx, token, org, caller)
		if e != nil {
			return nil, e
		}
		manage = owner && (a.CurrentPermission == "owner" || a.CurrentPermission == "admin")
		if !manage && a.CurrentPermission == "admin" {
			base, _ := repositoryPath(key)
			manage, e = s.directCollaborator(ctx, token, base, caller)
			if e != nil {
				return nil, e
			}
		}
	}
	if !manage {
		return nil, forgeError{http.StatusForbidden}
	}
	return a, nil
}
func (s *Server) invitationRecipient(ctx context.Context, token forgeCredential, key repositoryKey, a *golfv1.RepositoryAccess, issuer User, login string) (*golfv1.RepositoryInvitationRecipient, error) {
	r, e := s.readRepositoryCollaborator(ctx, token, key, a, login)
	if e != nil {
		return nil, e
	}
	if r.User == nil || r.User.Id == a.OwnerId || r.User.Id == strconv.FormatInt(issuer.ID, 10) || r.IsDirect || r.Permission == "owner" {
		return nil, errRepositoryAccessConflict
	}
	return &golfv1.RepositoryInvitationRecipient{User: r.User, Revision: r.Revision, EffectivePermission: r.Permission}, nil
}
func (s *Server) invitationIssuer(ctx context.Context, q *database.Queries, r database.GolfRepositoryInvitation, lock bool) (forgeCredential, User, *golfv1.RepositoryAccess, error) {
	var account database.GolfLocalAccount
	var e error
	if lock {
		account, e = q.LockInvitationIssuerAccount(ctx, database.LockInvitationIssuerAccountParams{ID: r.IssuerAccountID, UserID: r.IssuerUserID})
	} else {
		account, e = q.GetInvitationIssuerAccount(ctx, database.GetInvitationIssuerAccountParams{ID: r.IssuerAccountID, UserID: r.IssuerUserID})
	}
	if e != nil {
		if errors.Is(e, sql.ErrNoRows) {
			return forgeCredential{}, User{}, nil, errInvitationAuthority
		}
		return forgeCredential{}, User{}, nil, errStorageUnavailable
	}
	if account.DisabledAt.Valid || account.CredentialVersion != r.IssuerAccountVersion || !r.PersistentConsent {
		return forgeCredential{}, User{}, nil, errInvitationAuthority
	}
	raw, e := s.keyring.open(account.CredentialKeyID, localAccountDomain, account.EncryptedForgeToken, account.CredentialBinding)
	if e != nil {
		return forgeCredential{}, User{}, nil, errCredentialUnavailable
	}
	token := forgeCredential{Kind: "pat", Token: raw, Local: true}
	user, e := s.currentUser(ctx, token)
	if e != nil {
		return forgeCredential{}, User{}, nil, e
	}
	if user.ID != r.IssuerNativeID {
		return forgeCredential{}, User{}, nil, errInvitationAuthority
	}
	a, e := s.invitationAdmin(ctx, token, invitationKey(r), user)
	if e != nil {
		return forgeCredential{}, User{}, nil, e
	}
	if a.RepositoryId != strconv.FormatInt(r.RepositoryID, 10) || a.OwnerId != strconv.FormatInt(r.OwnerID, 10) || a.OrganizationOwned != r.OrganizationOwned {
		return forgeCredential{}, User{}, nil, errRepositoryAccessConflict
	}
	return token, user, a, nil
}

// Sorted account locks precede the caller session, issuer credential, invitation
// and repository gate. Logout does not revoke explicit consent; disable/version
// replacement does. Native provider calls never recursively lock this session.
func (s *Server) invitationTransaction(ctx context.Context, value string, token forgeCredential, issuerID int64, fn func(*sql.Tx, *database.Queries, database.LockManagedSessionRow) error) error {
	hash, e := s.authSessionHash(ctx, value, nil)
	if e != nil {
		return e
	}
	if s.db == nil {
		return errStorageUnavailable
	}
	native, e := s.currentUser(ctx, token)
	if e != nil {
		return e
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	q := database.New(s.db).WithTx(tx)
	var callerID int64
	e = tx.QueryRowContext(ctx, `SELECT u.id FROM golf_users u JOIN golf_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND u.forge_url=$2 AND s.expires_at>clock_timestamp()`, hash, s.config.GiteaURL).Scan(&callerID)
	if e != nil {
		if errors.Is(e, sql.ErrNoRows) {
			return errUnauthenticated
		}
		return errStorageUnavailable
	}
	if issuerID == 0 {
		issuerID = callerID
	}
	rows, e := q.LockInvitationUsers(ctx, database.LockInvitationUsersParams{ForgeURL: s.config.GiteaURL, ID: callerID, ID_2: issuerID})
	if e != nil {
		return errStorageUnavailable
	}
	callerFound, issuerFound := false, false
	for _, r := range rows {
		if r.ID == callerID && r.ForgeUserID == native.ID {
			callerFound = true
		}
		if r.ID == issuerID {
			issuerFound = true
		}
	}
	if !callerFound {
		return errUnauthenticated
	}
	if !issuerFound {
		return errInvitationAuthority
	}
	caller, e := q.LockManagedSession(ctx, database.LockManagedSessionParams{CallerTokenHash: hash, UserID: callerID, ForgeURL: s.config.GiteaURL})
	if e != nil {
		return errUnauthenticated
	}
	if _, e = s.authSessionHash(ctx, value, q); e != nil {
		return e
	}
	if e = fn(tx, q, caller); e != nil {
		return e
	}
	if !caller.ExpiresAt.After(time.Now()) {
		return errUnauthenticated
	}
	if _, e = s.authSessionHash(ctx, value, q); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return errStorageUnavailable
	}
	return nil
}
func invitationStorageError(e error) error {
	if e == nil {
		return nil
	}
	var state interface{ SQLState() string }
	if errors.As(e, &state) && (state.SQLState() == "55000" || state.SQLState() == "23505") {
		return errRepositoryAccessConflict
	}
	return errStorageUnavailable
}
func (s *Server) invitationLoad(ctx context.Context, id uuid.UUID) (database.GolfRepositoryInvitation, error) {
	if s.db == nil {
		return database.GolfRepositoryInvitation{}, errStorageUnavailable
	}
	r, e := database.New(s.db).GetRepositoryInvitation(ctx, database.GetRepositoryInvitationParams{ID: id, ForgeURL: s.config.GiteaURL})
	if errors.Is(e, sql.ErrNoRows) {
		return r, errResourceNotFound
	}
	if e != nil {
		return r, errStorageUnavailable
	}
	return r, nil
}
func invitationExpire(ctx context.Context, tx *sql.Tx, r database.GolfRepositoryInvitation) error {
	if r.State == "PENDING" && !r.ExpiresAt.After(time.Now()) {
		_, e := tx.ExecContext(ctx, `UPDATE golf_repository_invitations SET state='EXPIRED',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND state='PENDING' AND expires_at<=clock_timestamp()`, r.ID)
		return invitationStorageError(e)
	}
	return nil
}

func (s *Server) PreviewRepositoryInvitationRecipient(ctx context.Context, req *connect.Request[golfv1.PreviewRepositoryInvitationRecipientRequest]) (*connect.Response[golfv1.PreviewRepositoryInvitationRecipientResponse], error) {
	token, value, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if e = validateRepositoryAccess(key, m.RepositoryId, m.OwnerId, m.ExpectedRevision, m.Username); e != nil || m.Username == "" {
		return nil, rpcError(invalid("Provide the current exact target and recipient username."))
	}
	var result *golfv1.RepositoryInvitationRecipient
	e = s.withForgeCaller(ctx, value, token, func(caller User) error {
		a, e := s.invitationAdmin(ctx, token, key, caller)
		if e != nil {
			return e
		}
		if a.RepositoryId != m.RepositoryId || a.OwnerId != m.OwnerId || a.Revision != m.ExpectedRevision {
			return errRepositoryAccessConflict
		}
		result, e = s.invitationRecipient(ctx, token, key, a, caller, m.Username)
		if e != nil {
			return e
		}
		after, e := s.invitationAdmin(ctx, token, key, caller)
		if e != nil {
			return e
		}
		if after.Revision != a.Revision {
			return errRepositoryAccessConflict
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.PreviewRepositoryInvitationRecipientResponse{Recipient: result, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, AccessRevision: m.ExpectedRevision}), nil
}
func validateInvitationCreate(m *golfv1.CreateRepositoryInvitationRequest, now time.Time) (int64, int64, int64, time.Time, error) {
	key := keyFrom(m.Repository)
	e := validateRepositoryAccess(key, m.RepositoryId, m.OwnerId, m.ExpectedRevision, m.RecipientUsername)
	rid, e2 := discussionID(m.RepositoryId)
	oid, e3 := discussionID(m.OwnerId)
	recipient, e4 := discussionID(m.RecipientId)
	expiry, e5 := time.Parse(time.RFC3339Nano, m.ExpiresAt)
	if e != nil || e2 != nil || e3 != nil || e4 != nil || e5 != nil || !expiry.After(now.Add(time.Minute)) || expiry.After(now.Add(7*24*time.Hour)) || !m.PersistentConsent || !creationKey.MatchString(m.IdempotencyKey) || !validAccessRevision(m.RecipientRevision) || m.RecipientUsername == "" || (m.Permission != "read" && m.Permission != "write" && m.Permission != "admin") {
		return 0, 0, 0, time.Time{}, invalid("Select an exact existing recipient, read/write/admin permission, explicit logout-persistent consent and expiry between one minute and seven days.")
	}
	return rid, oid, recipient, expiry, nil
}
func (s *Server) CreateRepositoryInvitation(ctx context.Context, req *connect.Request[golfv1.CreateRepositoryInvitationRequest]) (*connect.Response[golfv1.CreateRepositoryInvitationResponse], error) {
	token, value, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	rid, oid, recipient, expiry, e := validateInvitationCreate(m, time.Now())
	if e != nil {
		return nil, rpcError(e)
	}
	if !token.Local {
		return nil, rpcError(forgeError{http.StatusForbidden})
	}
	key := keyFrom(m.Repository)
	var result database.GolfRepositoryInvitation
	e = s.withForgeCaller(ctx, value, token, func(caller User) error {
		return s.invitationTransaction(ctx, value, token, 0, func(tx *sql.Tx, q *database.Queries, actor database.LockManagedSessionRow) error {
			a, e := s.invitationAdmin(ctx, token, key, caller)
			if e != nil {
				return e
			}
			if a.RepositoryId != m.RepositoryId || a.OwnerId != m.OwnerId || a.Revision != m.ExpectedRevision {
				return errRepositoryAccessConflict
			}
			observed, e := s.invitationRecipient(ctx, token, key, a, caller, m.RecipientUsername)
			if e != nil {
				return e
			}
			if observed.User.Id != m.RecipientId || observed.Revision != m.RecipientRevision {
				return errRepositoryAccessConflict
			}
			hash, e := s.authSessionHash(ctx, value, q)
			if e != nil {
				return e
			}
			security, e := q.GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
			if e != nil {
				return errUnauthenticated
			}
			account, e := q.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: security.ID, UserID: actor.UserID})
			if e != nil || account.DisabledAt.Valid || account.CredentialVersion != security.CredentialVersion {
				return errUnauthenticated
			}
			body, _ := json.Marshal(m)
			fp := sha256.Sum256(body)
			var existing uuid.UUID
			e = tx.QueryRowContext(ctx, `SELECT id FROM golf_repository_invitations WHERE issuer_user_id=$1 AND create_key=$2`, actor.UserID, m.IdempotencyKey).Scan(&existing)
			if e == nil {
				previous, e := q.GetRepositoryInvitation(ctx, database.GetRepositoryInvitationParams{ID: existing, ForgeURL: s.config.GiteaURL})
				if e != nil {
					return errStorageUnavailable
				}
				if !bytes.Equal(previous.InputHash, fp[:]) {
					return errRepositoryAccessConflict
				}
				result = previous
				return nil
			}
			if !errors.Is(e, sql.ErrNoRows) {
				return errStorageUnavailable
			}
			var count int
			e = tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_repository_invitations WHERE forge_url=$1 AND repository_id=$2 AND state IN ('PENDING','GRANTING')`, s.config.GiteaURL, rid).Scan(&count)
			if e != nil {
				return errStorageUnavailable
			}
			if count >= 100 {
				return invalid("At most 100 pending or unresolved invitations are allowed per repository.")
			}
			id := uuid.New()
			_, e = tx.ExecContext(ctx, `INSERT INTO golf_repository_invitations(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,issuer_user_id,issuer_native_id,issuer_login,issuer_account_id,issuer_account_version,recipient_native_id,recipient_login,recipient_revision,permission,access_revision,persistent_consent,expires_at,create_key,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true,$18,$19,$20)`, id, s.config.GiteaURL, rid, oid, key.Owner, key.Name, a.OrganizationOwned, actor.UserID, caller.ID, caller.Login, account.ID, account.CredentialVersion, recipient, observed.User.Login, m.RecipientRevision, m.Permission, a.Revision, expiry, m.IdempotencyKey, fp[:])
			if e != nil {
				return invitationStorageError(e)
			}
			after, e := s.invitationAdmin(ctx, token, key, caller)
			if e != nil {
				return e
			}
			again, e := s.invitationRecipient(ctx, token, key, after, caller, m.RecipientUsername)
			if e != nil {
				return e
			}
			if after.Revision != a.Revision || again.Revision != observed.Revision {
				return errRepositoryAccessConflict
			}
			result, e = q.GetRepositoryInvitation(ctx, database.GetRepositoryInvitationParams{ID: id, ForgeURL: s.config.GiteaURL})
			return invitationStorageError(e)
		})
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.CreateRepositoryInvitationResponse{Invitation: invitationWire(result, true)}), nil
}

const invitationOperationColumns = `id,invitation_id,user_id,idempotency_key,invitation_revision,decision,input_hash,phase,failure_code,created_at,updated_at`

func scanInvitationOperation(row workflowRunScanner) (database.GolfRepositoryInvitationOperation, error) {
	var r database.GolfRepositoryInvitationOperation
	e := row.Scan(&r.ID, &r.InvitationID, &r.UserID, &r.IdempotencyKey, &r.InvitationRevision, &r.Decision, &r.InputHash, &r.Phase, &r.FailureCode, &r.CreatedAt, &r.UpdatedAt)
	return r, e
}
func ownInvitationOperation(ctx context.Context, tx *sql.Tx, actor int64, key string) (database.GolfRepositoryInvitationOperation, error) {
	r, e := scanInvitationOperation(tx.QueryRowContext(ctx, `SELECT `+invitationOperationColumns+` FROM golf_repository_invitation_operations WHERE user_id=$1 AND idempotency_key=$2`, actor, key))
	if errors.Is(e, sql.ErrNoRows) {
		return r, errResourceNotFound
	}
	if e != nil {
		return r, errStorageUnavailable
	}
	return r, nil
}
func advanceInvitationOperation(ctx context.Context, tx *sql.Tx, r database.GolfRepositoryInvitationOperation, phase string) (database.GolfRepositoryInvitationOperation, error) {
	failure := ""
	if phase == "REJECTED" {
		failure = "preflight_refused"
	}
	next, e := scanInvitationOperation(tx.QueryRowContext(ctx, `UPDATE golf_repository_invitation_operations SET phase=$2,failure_code=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING `+invitationOperationColumns, r.ID, phase, failure))
	return next, invitationStorageError(e)
}
func (s *Server) invitationOwnRecord(ctx context.Context, token forgeCredential, id uuid.UUID) (database.GolfRepositoryInvitation, error) {
	u, e := s.currentUser(ctx, token)
	if e != nil {
		return database.GolfRepositoryInvitation{}, e
	}
	r, e := s.invitationLoad(ctx, id)
	if e != nil {
		return r, e
	}
	if u.ID != r.RecipientNativeID {
		return r, errResourceNotFound
	}
	return r, nil
}
func (s *Server) invitationPrivateView(ctx context.Context, value string, token forgeCredential, id uuid.UUID) (*golfv1.RepositoryInvitation, error) {
	r, e := s.invitationOwnRecord(ctx, token, id)
	if e != nil {
		return nil, e
	}
	var wire *golfv1.RepositoryInvitation
	e = s.invitationTransaction(ctx, value, token, r.IssuerUserID, func(tx *sql.Tx, q *database.Queries, actor database.LockManagedSessionRow) error {
		_, _, _, authorityErr := s.invitationIssuer(ctx, q, r, true)
		locked, e := q.LockRepositoryInvitation(ctx, database.LockRepositoryInvitationParams{ID: id, ForgeURL: s.config.GiteaURL})
		if e != nil {
			return errStorageUnavailable
		}
		if e = invitationExpire(ctx, tx, locked); e != nil {
			return e
		}
		locked, e = q.GetRepositoryInvitation(ctx, database.GetRepositoryInvitationParams{ID: id, ForgeURL: s.config.GiteaURL})
		if e != nil {
			return errStorageUnavailable
		}
		e = authorityErr
		if e != nil {
			var upstream forgeError
			if errors.Is(e, errInvitationAuthority) || errors.Is(e, errRepositoryAccessConflict) || errors.As(e, &upstream) && (upstream.status == http.StatusForbidden || upstream.status == http.StatusNotFound) {
				wire = invitationWire(locked, false)
				return nil
			}
			return e
		}
		current, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		if current.ID != locked.RecipientNativeID {
			return errUnauthenticated
		}
		wire = invitationWire(locked, true)
		return nil
	})
	return wire, e
}
func (s *Server) ListOwnRepositoryInvitations(ctx context.Context, req *connect.Request[golfv1.ListOwnRepositoryInvitationsRequest]) (*connect.Response[golfv1.ListOwnRepositoryInvitationsResponse], error) {
	token, value, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	page, limit, e := pagination(pageFrom(req.Msg.Page))
	if e != nil || limit > 20 {
		return nil, rpcError(invalid("Load at most 20 invitations per page."))
	}
	var ids []uuid.UUID
	e = s.withManagedSession(ctx, value, token, func(q *database.Queries, actor database.LockManagedSessionRow, _ []byte) error {
		user, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		ids, e = q.ListOwnRepositoryInvitationIDs(ctx, database.ListOwnRepositoryInvitationIDsParams{ForgeURL: s.config.GiteaURL, RecipientNativeID: user.ID, Limit: int32(limit + 1), Offset: int32((page - 1) * limit)})
		return invitationStorageError(e)
	})
	if e != nil {
		return nil, rpcError(e)
	}
	next := uint32(0)
	if len(ids) > int(limit) {
		next = page + 1
		ids = ids[:limit]
	}
	rows := make([]*golfv1.RepositoryInvitation, 0, len(ids))
	for _, id := range ids {
		r, e := s.invitationPrivateView(ctx, value, token, id)
		if e != nil {
			return nil, rpcError(e)
		}
		rows = append(rows, r)
	}
	e = s.withManagedSession(ctx, value, token, func(*database.Queries, database.LockManagedSessionRow, []byte) error { return nil })
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.ListOwnRepositoryInvitationsResponse{Invitations: rows, Page: &golfv1.PageResponse{NextPage: next}}), nil
}
func (s *Server) ListRepositoryInvitations(ctx context.Context, req *connect.Request[golfv1.ListRepositoryInvitationsRequest]) (*connect.Response[golfv1.ListRepositoryInvitationsResponse], error) {
	token, value, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if e = validateRepositoryAccess(key, m.RepositoryId, m.OwnerId, m.ExpectedRevision, ""); e != nil {
		return nil, rpcError(e)
	}
	rid, _ := discussionID(m.RepositoryId)
	oid, _ := discussionID(m.OwnerId)
	page, limit, e := pagination(pageFrom(m.Page))
	if e != nil || limit > 20 {
		return nil, rpcError(invalid("Load at most 20 invitations per page."))
	}
	var rows []*golfv1.RepositoryInvitation
	next := uint32(0)
	canManage, localIssuerAvailable := false, false
	e = s.withForgeCaller(ctx, value, token, func(caller User) error {
		a, e := s.readRepositoryAccess(ctx, token, key, caller)
		if e != nil {
			return e
		}
		if a.RepositoryId != m.RepositoryId || a.OwnerId != m.OwnerId || a.Revision != m.ExpectedRevision {
			return errRepositoryAccessConflict
		}
		_, e = s.invitationAdmin(ctx, token, key, caller)
		if e != nil {
			var denied forgeError
			if !errors.As(e, &denied) || denied.status != http.StatusForbidden {
				return e
			}
		} else {
			canManage = true
		}
		return s.invitationTransaction(ctx, value, token, 0, func(tx *sql.Tx, q *database.Queries, actor database.LockManagedSessionRow) error {
			if !canManage {
				rows = []*golfv1.RepositoryInvitation{}
				after, e := s.readRepositoryAccess(ctx, token, key, caller)
				if e != nil {
					return e
				}
				if after.RepositoryId != a.RepositoryId || after.OwnerId != a.OwnerId || after.Revision != a.Revision {
					return errRepositoryAccessConflict
				}
				return nil
			}
			if token.Local {
				hash, e := s.authSessionHash(ctx, value, q)
				if e != nil {
					return e
				}
				security, e := q.GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
				if e != nil {
					if !errors.Is(e, sql.ErrNoRows) {
						return errStorageUnavailable
					}
				} else {
					account, e := q.GetInvitationIssuerAccount(ctx, database.GetInvitationIssuerAccountParams{ID: security.ID, UserID: actor.UserID})
					if e != nil {
						return errStorageUnavailable
					}
					localIssuerAvailable = !account.DisabledAt.Valid && account.CredentialVersion == security.CredentialVersion
				}
			}
			ids, e := q.ListRepositoryInvitationIDs(ctx, database.ListRepositoryInvitationIDsParams{ForgeURL: s.config.GiteaURL, RepositoryID: rid, OwnerID: oid, Limit: int32(limit + 1), Offset: int32((page - 1) * limit)})
			if e != nil {
				return errStorageUnavailable
			}
			if len(ids) > int(limit) {
				next = page + 1
				ids = ids[:limit]
			}
			rows = make([]*golfv1.RepositoryInvitation, 0, len(ids))
			for _, id := range ids {
				r, e := q.GetRepositoryInvitation(ctx, database.GetRepositoryInvitationParams{ID: id, ForgeURL: s.config.GiteaURL})
				if e != nil {
					return errStorageUnavailable
				}
				if e = invitationExpire(ctx, tx, r); e != nil {
					return e
				}
				r, e = q.GetRepositoryInvitation(ctx, database.GetRepositoryInvitationParams{ID: id, ForgeURL: s.config.GiteaURL})
				if e != nil {
					return errStorageUnavailable
				}
				rows = append(rows, invitationWire(r, true))
			}
			after, e := s.invitationAdmin(ctx, token, key, caller)
			if e != nil {
				return e
			}
			if after.Revision != a.Revision {
				return errRepositoryAccessConflict
			}
			return nil
		})
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.ListRepositoryInvitationsResponse{Invitations: rows, Page: &golfv1.PageResponse{NextPage: next}, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, AccessRevision: m.ExpectedRevision, CanManage: canManage, LocalIssuerAvailable: localIssuerAvailable}), nil
}
func (s *Server) RevokeRepositoryInvitation(ctx context.Context, req *connect.Request[golfv1.RevokeRepositoryInvitationRequest]) (*connect.Response[golfv1.RevokeRepositoryInvitationResponse], error) {
	token, value, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	id, e := invitationID(m.InvitationId)
	version, e2 := invitationRevision(m.InvitationRevision)
	if e != nil || e2 != nil {
		return nil, rpcError(invalid("Provide the exact invitation and revision."))
	}
	if e = validateRepositoryAccess(key, m.RepositoryId, m.OwnerId, m.ExpectedRevision, ""); e != nil {
		return nil, rpcError(e)
	}
	r, e := s.invitationLoad(ctx, id)
	if e != nil {
		return nil, rpcError(e)
	}
	var result database.GolfRepositoryInvitation
	e = s.withForgeCaller(ctx, value, token, func(caller User) error {
		a, e := s.invitationAdmin(ctx, token, key, caller)
		if e != nil {
			return e
		}
		if a.RepositoryId != m.RepositoryId || a.OwnerId != m.OwnerId || a.Revision != m.ExpectedRevision || a.RepositoryId != strconv.FormatInt(r.RepositoryID, 10) || a.OwnerId != strconv.FormatInt(r.OwnerID, 10) || key != invitationKey(r) {
			return errRepositoryAccessConflict
		}
		return s.invitationTransaction(ctx, value, token, r.IssuerUserID, func(tx *sql.Tx, q *database.Queries, actor database.LockManagedSessionRow) error {
			current, e := q.LockRepositoryInvitation(ctx, database.LockRepositoryInvitationParams{ID: id, ForgeURL: s.config.GiteaURL})
			if e != nil {
				return errStorageUnavailable
			}
			if current.State != "PENDING" || current.Revision != version {
				return errRepositoryAccessConflict
			}
			after, e := s.invitationAdmin(ctx, token, key, caller)
			if e != nil {
				return e
			}
			if after.Revision != a.Revision {
				return errRepositoryAccessConflict
			}
			_, e = tx.ExecContext(ctx, `UPDATE golf_repository_invitations SET state='REVOKED',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, id)
			if e != nil {
				return invitationStorageError(e)
			}
			result, e = q.GetRepositoryInvitation(ctx, database.GetRepositoryInvitationParams{ID: id, ForgeURL: s.config.GiteaURL})
			return invitationStorageError(e)
		})
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.RevokeRepositoryInvitationResponse{Invitation: invitationWire(result, true)}), nil
}
func (s *Server) RespondRepositoryInvitation(ctx context.Context, req *connect.Request[golfv1.RespondRepositoryInvitationRequest]) (*connect.Response[golfv1.RespondRepositoryInvitationResponse], error) {
	token, value, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	id, e := invitationID(m.InvitationId)
	version, e2 := invitationRevision(m.ExpectedRevision)
	if e != nil || e2 != nil || !creationKey.MatchString(m.IdempotencyKey) || (m.Decision != golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT && m.Decision != golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_REJECT) {
		return nil, rpcError(invalid("Select the exact invitation/version, accept or reject, and an original operation key."))
	}
	invite, e := s.invitationOwnRecord(ctx, token, id)
	if e != nil {
		return nil, rpcError(e)
	}
	body, _ := json.Marshal(m)
	fp := sha256.Sum256(body)
	decision := "ACCEPT"
	if m.Decision == golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_REJECT {
		decision = "REJECT"
	}
	var operation database.GolfRepositoryInvitationOperation
	dispatch := false
	details := false
	e = s.invitationTransaction(ctx, value, token, invite.IssuerUserID, func(tx *sql.Tx, q *database.Queries, actor database.LockManagedSessionRow) error {
		// Issuer credential before invitation row matches disable/version-change lock order.
		issuerToken, issuer, a, authorityErr := s.invitationIssuer(ctx, q, invite, true)
		current, e := q.LockRepositoryInvitation(ctx, database.LockRepositoryInvitationParams{ID: id, ForgeURL: s.config.GiteaURL})
		if e != nil {
			return errStorageUnavailable
		}
		invite = current
		previous, e := ownInvitationOperation(ctx, tx, actor.UserID, m.IdempotencyKey)
		if e == nil {
			if previous.InvitationID != id || !bytes.Equal(previous.InputHash, fp[:]) {
				return errRepositoryAccessConflict
			}
			if authorityErr != nil {
				return authorityErr
			}
			operation = previous
			details = true
			return nil
		}
		if !errors.Is(e, errResourceNotFound) {
			return e
		}
		if current.State != "PENDING" || current.Revision != version || !current.ExpiresAt.After(time.Now()) {
			if e = invitationExpire(ctx, tx, current); e != nil {
				return e
			}
			return errRepositoryAccessConflict
		}
		op, e := scanInvitationOperation(tx.QueryRowContext(ctx, `INSERT INTO golf_repository_invitation_operations(invitation_id,user_id,idempotency_key,invitation_revision,decision,input_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING `+invitationOperationColumns, id, actor.UserID, m.IdempotencyKey, version, decision, fp[:]))
		if e != nil {
			return invitationStorageError(e)
		}
		operation = op
		if decision == "REJECT" {
			_, e = tx.ExecContext(ctx, `UPDATE golf_repository_invitations SET state='REJECTED',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, id)
			if e != nil {
				return invitationStorageError(e)
			}
			operation, e = advanceInvitationOperation(ctx, tx, op, "SUCCEEDED")
			if e != nil {
				return e
			}
			invite, e = q.GetRepositoryInvitation(ctx, database.GetRepositoryInvitationParams{ID: id, ForgeURL: s.config.GiteaURL})
			details = authorityErr == nil
			return invitationStorageError(e)
		}
		valid := authorityErr == nil && a.Revision == current.AccessRevision
		if valid {
			recipient, e := s.invitationRecipient(ctx, issuerToken, invitationKey(current), a, issuer, current.RecipientLogin)
			if e != nil {
				var upstream forgeError
				if errors.As(e, &upstream) && (upstream.status == http.StatusForbidden || upstream.status == http.StatusNotFound) || errors.Is(e, errRepositoryAccessConflict) {
					valid = false
				} else {
					return e
				}
			} else {
				valid = recipient.User.Id == strconv.FormatInt(current.RecipientNativeID, 10) && recipient.Revision == current.RecipientRevision
			}
		}
		if !valid {
			if authorityErr != nil && !errors.Is(authorityErr, errInvitationAuthority) {
				var upstream forgeError
				if !errors.As(authorityErr, &upstream) && !errors.Is(authorityErr, errRepositoryAccessConflict) {
					return authorityErr
				}
			}
			operation, e = advanceInvitationOperation(ctx, tx, op, "REJECTED")
			details = authorityErr == nil
			return e
		}
		native, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		if native.ID != current.RecipientNativeID || !strings.EqualFold(native.Login, current.RecipientLogin) {
			return errRepositoryAccessConflict
		}
		_, e = tx.ExecContext(ctx, `UPDATE golf_repository_invitations SET state='GRANTING',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, id)
		if e != nil {
			return invitationStorageError(e)
		}
		operation, e = advanceInvitationOperation(ctx, tx, op, "DISPATCH_UNKNOWN")
		if e != nil {
			return e
		}
		invite, e = q.GetRepositoryInvitation(ctx, database.GetRepositoryInvitationParams{ID: id, ForgeURL: s.config.GiteaURL})
		if e != nil {
			return errStorageUnavailable
		}
		dispatch = true
		details = true
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	if !details {
		return nil, rpcError(errInvitationAuthority)
	}
	if dispatch {
		// No recovery resend: only this first reserved invocation may enter this block.
		e = s.invitationGrant(ctx, value, token, &invite, &operation)
		if e != nil {
			return nil, rpcError(e)
		}
	}
	return connect.NewResponse(&golfv1.RespondRepositoryInvitationResponse{Invitation: invitationWire(invite, details), Operation: invitationOperationWire(operation, invite)}), nil
}
func (s *Server) invitationGrant(ctx context.Context, value string, token forgeCredential, invite *database.GolfRepositoryInvitation, operation *database.GolfRepositoryInvitationOperation) error {
	return s.invitationTransaction(ctx, value, token, invite.IssuerUserID, func(tx *sql.Tx, q *database.Queries, actor database.LockManagedSessionRow) error {
		issuerToken, issuer, a, e := s.invitationIssuer(ctx, q, *invite, true)
		if e != nil {
			return e
		}
		current, e := q.LockRepositoryInvitation(ctx, database.LockRepositoryInvitationParams{ID: invite.ID, ForgeURL: s.config.GiteaURL})
		if e != nil {
			return errStorageUnavailable
		}
		r, e := ownInvitationOperation(ctx, tx, actor.UserID, operation.IdempotencyKey)
		if e != nil {
			return e
		}
		if current.State != "GRANTING" || r.Phase != "DISPATCH_UNKNOWN" || !current.ExpiresAt.After(time.Now()) || a.Revision != current.AccessRevision {
			return errRepositoryAccessConflict
		}
		recipient, e := s.invitationRecipient(ctx, issuerToken, invitationKey(current), a, issuer, current.RecipientLogin)
		if e != nil {
			return e
		}
		if recipient.User.Id != strconv.FormatInt(current.RecipientNativeID, 10) || recipient.Revision != current.RecipientRevision {
			return errRepositoryAccessConflict
		}
		actorNative, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		if actorNative.ID != current.RecipientNativeID || !strings.EqualFold(actorNative.Login, current.RecipientLogin) {
			return errUnauthenticated
		}
		if _, e = tx.ExecContext(ctx, `SELECT golf_repository_lifecycle_lock($1,$2,false)`, current.ForgeURL, current.RepositoryID); e != nil {
			return errStorageUnavailable
		}
		var blocked bool
		e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked($1,$2)`, current.ForgeURL, current.RepositoryID).Scan(&blocked)
		if e != nil {
			return errStorageUnavailable
		}
		if blocked {
			return errLifecycleBlocked
		}
		base, _ := repositoryPath(invitationKey(current))
		_, dispatchErr := s.forgeJSON(ctx, http.MethodPut, base+"/collaborators/"+current.RecipientLogin, issuerToken, map[string]string{"permission": current.Permission}, nil, http.StatusNoContent)
		// Even uncertain effects require current issuer/recipient authority before
		// releasing their private original receipt. No arbitrary error becomes refusal.
		_, _, after, e := s.invitationIssuer(ctx, q, current, false)
		if e != nil {
			return e
		}
		native, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		if native.ID != current.RecipientNativeID {
			return errUnauthenticated
		}
		if dispatchErr != nil {
			return nil
		}
		member, e := s.readRepositoryCollaborator(ctx, issuerToken, invitationKey(current), after, current.RecipientLogin)
		if e != nil {
			return nil
		}
		if member.User.Id != strconv.FormatInt(current.RecipientNativeID, 10) || !member.IsDirect || member.Permission != current.Permission || after.Revision != current.AccessRevision {
			return nil
		}
		*operation, e = advanceInvitationOperation(ctx, tx, r, "SUCCEEDED")
		if e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, `UPDATE golf_repository_invitations SET state='ACCEPTED',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, current.ID)
		if e != nil {
			return invitationStorageError(e)
		}
		*invite, e = q.GetRepositoryInvitation(ctx, database.GetRepositoryInvitationParams{ID: current.ID, ForgeURL: s.config.GiteaURL})
		return invitationStorageError(e)
	})
}
func (s *Server) GetRepositoryInvitationOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryInvitationOperationRequest]) (*connect.Response[golfv1.GetRepositoryInvitationOperationResponse], error) {
	token, value, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	id, e := invitationID(req.Msg.InvitationId)
	if e != nil || !creationKey.MatchString(req.Msg.IdempotencyKey) {
		return nil, rpcError(invalid("Provide the original invitation and operation key."))
	}
	invite, e := s.invitationOwnRecord(ctx, token, id)
	if e != nil {
		return nil, rpcError(e)
	}
	var result database.GolfRepositoryInvitationOperation
	e = s.invitationTransaction(ctx, value, token, invite.IssuerUserID, func(tx *sql.Tx, q *database.Queries, actor database.LockManagedSessionRow) error {
		_, _, _, e := s.invitationIssuer(ctx, q, invite, true)
		if e != nil {
			return e
		}
		result, e = ownInvitationOperation(ctx, tx, actor.UserID, req.Msg.IdempotencyKey)
		if e != nil {
			return e
		}
		if result.InvitationID != id {
			return errResourceNotFound
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryInvitationOperationResponse{Operation: invitationOperationWire(result, invite)}), nil
}

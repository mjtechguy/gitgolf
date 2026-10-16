package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

// This is managed Golf access, independent of local-password enrollment and of
// native forge ingress. Call under the immutable user lock for admission writes.
func (s *Server) requireGolfUserAccess(ctx context.Context, q workflowQueryer, userID int64) error {
	var allowed bool
	if err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_users u WHERE u.id=$1 AND u.forge_url=$2 AND NOT EXISTS(SELECT 1 FROM golf_user_access a WHERE a.user_id=u.id AND a.suspended))`, userID, s.config.ForgeURL).Scan(&allowed); err != nil {
		return errStorageUnavailable
	}
	if !allowed {
		return errUnauthenticated
	}
	return nil
}

// Read the credential and managed access in one observation. A restored policy
// must never revive a source that suspension permanently revoked.
func (s *Server) currentGolfSessionCredential(ctx context.Context, hash []byte) (database.GetSessionCredentialRow, error) {
	var row database.GetSessionCredentialRow
	err := s.db.QueryRowContext(ctx, `SELECT s.encrypted_token,s.credential_kind,u.forge_user_id,s.expires_at,s.credential_key_id FROM golf_sessions s JOIN golf_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND u.forge_url=$2 AND s.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM golf_user_access a WHERE a.user_id=u.id AND a.suspended) AND (s.local_account_id IS NULL OR EXISTS(SELECT 1 FROM golf_local_accounts l WHERE l.id=s.local_account_id AND l.user_id=u.id AND l.disabled_at IS NULL AND l.credential_version=s.local_credential_version))`, hash, s.config.ForgeURL).Scan(&row.EncryptedToken, &row.CredentialKind, &row.ForgeUserID, &row.ExpiresAt, &row.CredentialKeyID)
	return row, err
}
func (s *Server) requireNativeGolfUserAccess(ctx context.Context, nativeID int64) error {
	var userID int64
	if err := s.db.QueryRowContext(ctx, `SELECT id FROM golf_users WHERE forge_url=$1 AND forge_user_id=$2`, s.config.ForgeURL, nativeID).Scan(&userID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errUnauthenticated
		}
		return errStorageUnavailable
	}
	return s.requireGolfUserAccess(ctx, s.db, userID)
}

const golfUserAccessColumns = `u.id,u.forge_user_id,u.login,EXISTS(SELECT 1 FROM golf_local_accounts l WHERE l.user_id=u.id AND l.is_instance_admin),COALESCE(a.suspended,false),COALESCE(a.version,0),COALESCE(a.reason,''),a.changed_at`

func scanGolfUserAccess(row workflowRunScanner) (*golfv1.GolfUserAccess, error) {
	var userID, nativeID, version int64
	var stamp sql.NullTime
	u := &golfv1.GolfUserAccess{}
	err := row.Scan(&userID, &nativeID, &u.Login, &u.IsInstanceAdmin, &u.Suspended, &version, &u.Reason, &stamp)
	u.GolfUserId = strconv.FormatInt(userID, 10)
	u.NativeUserId = strconv.FormatInt(nativeID, 10)
	u.Version = strconv.FormatInt(version, 10)
	if stamp.Valid {
		u.ChangedAt = stamp.Time.UTC().Format(time.RFC3339Nano)
	}
	return u, err
}
func (s *Server) golfUserAccess(ctx context.Context, q workflowQueryer, userID, nativeID int64) (*golfv1.GolfUserAccess, error) {
	return scanGolfUserAccess(q.QueryRowContext(ctx, `SELECT `+golfUserAccessColumns+` FROM golf_users u LEFT JOIN golf_user_access a ON a.user_id=u.id WHERE u.id=$1 AND u.forge_user_id=$2 AND u.forge_url=$3`, userID, nativeID, s.config.ForgeURL))
}
func (s *Server) ListGolfUserAccess(ctx context.Context, req *connect.Request[golfv1.ListGolfUserAccessRequest]) (*connect.Response[golfv1.ListGolfUserAccessResponse], error) {
	c, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	value := s.cookieValue(req.Header())
	if e = s.requireInstanceAdmin(ctx, value, c); e != nil {
		return nil, e
	}
	page, limit, e := pagination(pageFrom(req.Msg.Page))
	if e != nil {
		return nil, rpcError(e)
	}
	rows, e := s.db.QueryContext(ctx, `SELECT `+golfUserAccessColumns+` FROM golf_users u LEFT JOIN golf_user_access a ON a.user_id=u.id WHERE u.forge_url=$1 ORDER BY u.id LIMIT $2 OFFSET $3`, s.config.ForgeURL, limit+1, (page-1)*limit)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	users := make([]*golfv1.GolfUserAccess, 0, limit+1)
	for rows.Next() {
		u, err := scanGolfUserAccess(rows)
		if err != nil {
			rows.Close()
			return nil, rpcError(errStorageUnavailable)
		}
		users = append(users, u)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if e = s.requireInstanceAdmin(ctx, value, c); e != nil {
		return nil, e
	}
	next := uint32(0)
	if len(users) > int(limit) {
		if page == 10000 {
			return nil, rpcError(invalid("Golf user inventory exceeds the page limit."))
		}
		users = users[:limit]
		next = page + 1
	}
	return connect.NewResponse(&golfv1.ListGolfUserAccessResponse{Users: users, Page: wirePage(next)}), nil
}

type golfAccessIntent struct {
	UserID    int64
	NativeID  int64
	Version   int64
	Suspended bool
	Reason    string
	Operation string
}

func parseGolfAccessIntent(m *golfv1.ChangeGolfUserAccessRequest) (golfAccessIntent, []byte, error) {
	i := golfAccessIntent{Suspended: m.Suspended, Reason: strings.TrimSpace(m.Reason), Operation: m.OperationId}
	var e error
	i.UserID, e = discussionID(m.GolfUserId)
	if e != nil {
		return i, nil, invalid("Provide the immutable Golf user ID.")
	}
	i.NativeID, e = discussionID(m.NativeUserId)
	if e != nil {
		return i, nil, invalid("Provide the immutable native user ID.")
	}
	i.Version, e = strconv.ParseInt(m.ExpectedVersion, 10, 64)
	if e != nil || i.Version < 0 || i.Version == math.MaxInt64 || strconv.FormatInt(i.Version, 10) != m.ExpectedVersion {
		return i, nil, invalid("Provide the current canonical access version.")
	}
	id, e := uuid.Parse(i.Operation)
	if e != nil || id.Version() != 4 || id.String() != i.Operation {
		return i, nil, invalid("Provide a canonical UUIDv4 operation ID.")
	}
	if !utf8.ValidString(i.Reason) || len(i.Reason) == 0 || len(i.Reason) > 1024 || strings.ContainsRune(i.Reason, 0) {
		return i, nil, invalid("Provide an access-change reason of 1–1024 bytes.")
	}
	b, _ := json.Marshal(i)
	h := sha256.Sum256(b)
	return i, h[:], nil
}

const golfAccessOperationColumns = `operation_id::text,user_id,native_user_id,version,suspended,reason,changed_at,sessions_revoked,automation_grants_revoked,input_hash,actor_user_id`

func scanGolfAccessOperation(row workflowRunScanner) (*golfv1.GolfUserAccessOperation, []byte, int64, error) {
	o := &golfv1.GolfUserAccessOperation{}
	var uid, nid, version, actor int64
	var hash []byte
	var stamp time.Time
	err := row.Scan(&o.OperationId, &uid, &nid, &version, &o.Suspended, &o.Reason, &stamp, &o.SessionsRevoked, &o.AutomationGrantsRevoked, &hash, &actor)
	o.GolfUserId = strconv.FormatInt(uid, 10)
	o.NativeUserId = strconv.FormatInt(nid, 10)
	o.Version = strconv.FormatInt(version, 10)
	o.ChangedAt = stamp.UTC().Format(time.RFC3339Nano)
	return o, hash, actor, err
}
func (s *Server) ChangeGolfUserAccess(ctx context.Context, req *connect.Request[golfv1.ChangeGolfUserAccessRequest]) (response *connect.Response[golfv1.ChangeGolfUserAccessResponse], resultErr error) {
	var transaction *sql.Tx
	commitAttempted := false
	defer func() {
		rollbackConfirmed := transaction == nil
		if transaction != nil {
			rollbackConfirmed = transaction.Rollback() == nil
		}
		// A late interceptor denial or lost Commit response has no rejection marker.
		// Only this handler can prove that no local access change was committed.
		if resultErr != nil && !commitAttempted && rollbackConfirmed {
			var boundary *connect.Error
			if errors.As(resultErr, &boundary) {
				boundary.Meta().Set("Golf-Access-Outcome", "rejected")
			}
		}
	}()
	c, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	value := s.cookieValue(req.Header())
	if e = s.requireInstanceAdmin(ctx, value, c); e != nil {
		return nil, e
	}
	i, input, e := parseGolfAccessIntent(req.Msg)
	if e != nil {
		return nil, rpcError(e)
	}
	initial, e := s.confirmInfrastructureAdmin(ctx, value, c, req.Msg.PasswordConfirmation)
	if e != nil {
		var boundary *connect.Error
		if errors.As(e, &boundary) {
			return nil, e
		}
		return nil, rpcError(e)
	}
	if initial.UserID == i.UserID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("You cannot change your own Golf access."))
	}
	hash, e := s.authSessionHash(ctx, value, nil)
	if e != nil {
		return nil, rpcError(e)
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	transaction = tx
	// All administrators and the target lock in immutable ID order. Concurrent
	// administrator suspensions cannot each rely on the other remaining active.
	rows, e := tx.QueryContext(ctx, `SELECT u.id FROM golf_users u WHERE u.forge_url=$1 AND (u.id IN($2,$3) OR EXISTS(SELECT 1 FROM golf_local_accounts l WHERE l.user_id=u.id AND l.is_instance_admin)) ORDER BY u.id FOR UPDATE OF u`, s.config.ForgeURL, initial.UserID, i.UserID)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	for rows.Next() {
		var id int64
		if e = rows.Scan(&id); e != nil {
			break
		}
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if e = s.requireGolfUserAccess(ctx, tx, initial.UserID); e != nil {
		return nil, rpcError(e)
	}
	q := database.New(tx)
	actor, e := q.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: initial.ID, UserID: initial.UserID})
	if e != nil {
		return nil, rpcError(errUnauthenticated)
	}
	if !actor.IsInstanceAdmin || actor.DisabledAt.Valid || actor.CredentialVersion != initial.CredentialVersion || actor.PasswordHash != initial.PasswordHash {
		return nil, rpcError(errUnauthenticated)
	}
	if _, e = q.LockSessionCredential(ctx, database.LockSessionCredentialParams{TokenHash: hash, ForgeURL: s.config.ForgeURL}); e != nil {
		return nil, rpcError(errUnauthenticated)
	}
	current, e := q.GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.ForgeURL})
	if e != nil || current != initial {
		return nil, rpcError(errUnauthenticated)
	}
	user, e := s.golfUserAccess(ctx, tx, i.UserID, i.NativeID)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, rpcError(errResourceNotFound)
	}
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	old, oldHash, oldActor, e := scanGolfAccessOperation(tx.QueryRowContext(ctx, `SELECT `+golfAccessOperationColumns+` FROM golf_user_access_operations WHERE operation_id=$1`, i.Operation))
	if e == nil {
		if oldActor != initial.UserID || !bytes.Equal(oldHash, input) {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("Operation ID belongs to another access change."))
		}
		return connect.NewResponse(&golfv1.ChangeGolfUserAccessResponse{Operation: old, User: user}), nil
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return nil, rpcError(errStorageUnavailable)
	}
	if user.Version != req.Msg.ExpectedVersion {
		return nil, connect.NewError(connect.CodeAborted, errors.New("Golf access changed. Refresh before editing."))
	}
	if user.Suspended == i.Suspended {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("Golf access already has the requested state."))
	}
	if i.Suspended && user.IsInstanceAdmin {
		var active, targetActive int64
		e = tx.QueryRowContext(ctx, `SELECT count(*),count(*) FILTER(WHERE u.id=$2) FROM golf_users u WHERE u.forge_url=$1 AND EXISTS(SELECT 1 FROM golf_local_accounts l WHERE l.user_id=u.id AND l.is_instance_admin AND l.disabled_at IS NULL) AND NOT EXISTS(SELECT 1 FROM golf_user_access a WHERE a.user_id=u.id AND a.suspended)`, s.config.ForgeURL, i.UserID).Scan(&active, &targetActive)
		if e != nil {
			return nil, rpcError(errStorageUnavailable)
		}
		if targetActive > 0 && active <= 1 {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("The last active instance administrator cannot be suspended."))
		}
	}
	var sessions, grants int64
	if i.Suspended {
		result, err := tx.ExecContext(ctx, `DELETE FROM golf_sessions WHERE user_id=$1`, i.UserID)
		if err != nil {
			return nil, rpcError(errStorageUnavailable)
		}
		sessions, e = result.RowsAffected()
		if e != nil {
			return nil, rpcError(errStorageUnavailable)
		}
		// Source-user locks precede grant locks throughout the workflow engine.
		rows, e = tx.QueryContext(ctx, `SELECT id FROM golf_automation_grants WHERE sponsor_user_id=$1 AND enabled ORDER BY id FOR UPDATE`, i.UserID)
		if e != nil {
			return nil, rpcError(errStorageUnavailable)
		}
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				break
			}
		}
		if e == nil {
			e = rows.Err()
		}
		rows.Close()
		if e != nil {
			return nil, rpcError(errStorageUnavailable)
		}
		e = tx.QueryRowContext(ctx, `WITH revoked AS (UPDATE golf_automation_grants SET enabled=false,revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE sponsor_user_id=$1 AND enabled RETURNING id,revision), events AS (INSERT INTO golf_automation_grant_events(grant_id,revision,action,actor_user_id,actor_session_id) SELECT id,revision,'REVOKED',$2,$3 FROM revoked RETURNING 1) SELECT count(*) FROM events`, i.UserID, initial.UserID, initial.SessionID).Scan(&grants)
		if e != nil {
			return nil, rpcError(errStorageUnavailable)
		}
	}
	var stamp time.Time
	e = tx.QueryRowContext(ctx, `INSERT INTO golf_user_access(user_id,version,suspended,reason) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET version=EXCLUDED.version,suspended=EXCLUDED.suspended,reason=EXCLUDED.reason,changed_at=clock_timestamp() RETURNING changed_at`, i.UserID, i.Version+1, i.Suspended, i.Reason).Scan(&stamp)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	_, e = tx.ExecContext(ctx, `INSERT INTO golf_user_access_operations(operation_id,actor_user_id,actor_session_id,user_id,native_user_id,input_hash,version,suspended,reason,changed_at,sessions_revoked,automation_grants_revoked) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, i.Operation, initial.UserID, initial.SessionID, i.UserID, i.NativeID, input, i.Version+1, i.Suspended, i.Reason, stamp, sessions, grants)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if final, err := q.GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.ForgeURL}); err != nil || final != initial {
		return nil, rpcError(errUnauthenticated)
	}
	commitAttempted = true
	if e = tx.Commit(); e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	user.Version = strconv.FormatInt(i.Version+1, 10)
	user.Suspended = i.Suspended
	user.Reason = i.Reason
	user.ChangedAt = stamp.UTC().Format(time.RFC3339Nano)
	op := &golfv1.GolfUserAccessOperation{OperationId: i.Operation, GolfUserId: user.GolfUserId, NativeUserId: user.NativeUserId, Version: user.Version, Suspended: i.Suspended, Reason: i.Reason, ChangedAt: user.ChangedAt, SessionsRevoked: uint64(sessions), AutomationGrantsRevoked: uint64(grants)}
	return connect.NewResponse(&golfv1.ChangeGolfUserAccessResponse{Operation: op, User: user}), nil
}
func (s *Server) GetGolfUserAccessOperation(ctx context.Context, req *connect.Request[golfv1.GetGolfUserAccessOperationRequest]) (*connect.Response[golfv1.GetGolfUserAccessOperationResponse], error) {
	c, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	value := s.cookieValue(req.Header())
	if e = s.requireInstanceAdmin(ctx, value, c); e != nil {
		return nil, e
	}
	uid, e := discussionID(req.Msg.GolfUserId)
	if e != nil {
		return nil, rpcError(invalid("Provide the immutable Golf user ID."))
	}
	nid, e := discussionID(req.Msg.NativeUserId)
	if e != nil {
		return nil, rpcError(invalid("Provide the immutable native user ID."))
	}
	id, e := uuid.Parse(req.Msg.OperationId)
	if e != nil || id.Version() != 4 || id.String() != req.Msg.OperationId {
		return nil, rpcError(invalid("Provide a canonical UUIDv4 operation ID."))
	}
	user, e := s.golfUserAccess(ctx, s.db, uid, nid)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, rpcError(errResourceNotFound)
	}
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	op, _, _, e := scanGolfAccessOperation(s.db.QueryRowContext(ctx, `SELECT `+golfAccessOperationColumns+` FROM golf_user_access_operations WHERE operation_id=$1 AND user_id=$2 AND native_user_id=$3`, id.String(), uid, nid))
	if errors.Is(e, sql.ErrNoRows) {
		return nil, rpcError(errResourceNotFound)
	}
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	if e = s.requireInstanceAdmin(ctx, value, c); e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.GetGolfUserAccessOperationResponse{Operation: op, User: user}), nil
}

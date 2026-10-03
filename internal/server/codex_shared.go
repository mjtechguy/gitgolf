package server

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

var errCodexPermission = errors.New("Codex connection permission denied")

func codexVisible(r codexRecord, available, manage bool) *golfv1.CodexConnection {
	v := codexWire(r, available)
	v.CanManage = manage
	v.CanUse = r.Scope == "PERSONAL" || r.Use
	if !manage {
		v.LoginId = ""
		v.VerificationUrl = ""
		v.UserCode = ""
		v.LoginExpiresAt = ""
		v.AllowedUserIds = nil
	}
	return v
}
func (s *Server) codexManageTx(ctx context.Context, tx *sql.Tx, userID int64, r codexRecord) error {
	if r.Scope == "INSTANCE" {
		var admin bool
		e := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_local_accounts a WHERE a.user_id=$1 AND a.is_instance_admin AND a.disabled_at IS NULL)`, userID).Scan(&admin)
		if e != nil {
			return errStorageUnavailable
		}
		if !admin {
			return errCodexPermission
		}
		return nil
	}
	if !r.OwnerID.Valid || r.OwnerID.Int64 != userID {
		return errCodexPermission
	}
	return nil
}
func (s *Server) codexAuthorized(ctx context.Context, a codexActor, connectionID string, manage bool) (codexRecord, error) {
	if connectionID != "" {
		id, e := uuid.Parse(connectionID)
		if e != nil || id.String() != connectionID {
			return codexRecord{}, errResourceNotFound
		}
	}
	var r codexRecord
	e := s.codexGuard(ctx, a, func(tx *sql.Tx, userID int64) error {
		var e error
		if connectionID == "" {
			r, e = scanCodex(tx.QueryRowContext(ctx, `SELECT `+codexColumns+` FROM golf_codex_connections WHERE user_id=$1 FOR SHARE`, userID))
		} else {
			r, e = scanCodex(tx.QueryRowContext(ctx, `SELECT `+codexColumns+` FROM golf_codex_connections WHERE id=$1 AND forge_url=$2 FOR SHARE`, connectionID, s.config.GiteaURL))
		}
		if errors.Is(e, sql.ErrNoRows) && connectionID == "" {
			r = codexRecord{State: "UNCONFIGURED", Scope: "PERSONAL", Name: "Personal Codex", OwnerID: sql.NullInt64{Int64: userID, Valid: true}}
			return nil
		}
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		if r.Scope == "PERSONAL" {
			if !r.OwnerID.Valid || r.OwnerID.Int64 != userID {
				return errResourceNotFound
			}
			r.Use = true
			return nil
		}
		var granted bool
		e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_codex_connection_access x JOIN golf_local_accounts l ON l.user_id=x.user_id WHERE x.connection_id=$1 AND x.user_id=$2 AND l.disabled_at IS NULL)`, r.ID, userID).Scan(&granted)
		if e != nil {
			return errStorageUnavailable
		}
		r.Use = granted
		if manage && !a.Admin {
			return errCodexPermission
		}
		if !a.Admin && !granted {
			return errResourceNotFound
		}
		if a.Admin {
			if err := s.codexManageTx(ctx, tx, userID, r); err != nil {
				return err
			}
			rows, e := tx.QueryContext(ctx, `SELECT user_id::text FROM golf_codex_connection_access WHERE connection_id=$1 ORDER BY user_id`, r.ID)
			if e != nil {
				return errStorageUnavailable
			}
			defer rows.Close()
			for rows.Next() {
				var id string
				if e = rows.Scan(&id); e != nil {
					return errStorageUnavailable
				}
				r.Access = append(r.Access, id)
			}
			if rows.Err() != nil {
				return errStorageUnavailable
			}
		}
		return nil
	})
	return r, e
}
func codexName(name string) bool {
	if strings.TrimSpace(name) != name || len(name) == 0 || utf8.RuneCountInString(name) > 100 || len(name) > 400 || !utf8.ValidString(name) {
		return false
	}
	for _, c := range name {
		if unicode.IsControl(c) {
			return false
		}
	}
	return true
}
func (s *Server) codexAuditTx(ctx context.Context, tx *sql.Tx, a codexActor, action, connectionID string) error {
	var id int64
	var kind string
	if e := tx.QueryRowContext(ctx, `SELECT session_id,credential_kind FROM golf_sessions WHERE token_hash=$1`, a.Hash).Scan(&id, &kind); e != nil {
		return errUnauthenticated
	}
	return appendCodexAudit(ctx, database.New(s.db).WithTx(tx), database.AppendAuditEventParams{UserID: a.UserID, ActorSessionID: id, CredentialKind: kind, Action: action}, connectionID)
}
func (s *Server) ListCodexConnections(ctx context.Context, req *connect.Request[golfv1.ListCodexConnectionsRequest]) (*connect.Response[golfv1.ListCodexConnectionsResponse], error) {
	a, e := s.codexIdentity(ctx, req.Header())
	if e != nil {
		return nil, rpcError(e)
	}
	if req.Msg.InstanceAdmin && !a.Admin {
		return nil, rpcError(errCodexPermission)
	}
	result := &golfv1.ListCodexConnectionsResponse{}
	if !req.Msg.InstanceAdmin {
		v, e := s.codexGet(ctx, req.Header(), "")
		if e != nil {
			return nil, rpcError(e)
		}
		result.Connections = append(result.Connections, v)
	}
	var ids []string
	e = s.codexGuard(ctx, a, func(tx *sql.Tx, userID int64) error {
		query := `SELECT id::text FROM golf_codex_connections c WHERE c.scope='INSTANCE' AND c.forge_url=$1 AND ($2 OR EXISTS(SELECT 1 FROM golf_codex_connection_access x WHERE x.connection_id=c.id AND x.user_id=$3)) ORDER BY lower(name),id LIMIT 64`
		rows, e := tx.QueryContext(ctx, query, s.config.GiteaURL, req.Msg.InstanceAdmin, userID)
		if e != nil {
			return errStorageUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				return errStorageUnavailable
			}
			ids = append(ids, id)
		}
		if rows.Err() != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	for _, id := range ids {
		r, e := s.codexAuthorized(ctx, a, id, false)
		if errors.Is(e, errResourceNotFound) {
			continue
		}
		if e != nil {
			return nil, rpcError(e)
		}
		// Personal inventory is a use view. Even an administrator does not receive
		// management/device material through that projection.
		result.Connections = append(result.Connections, codexVisible(r, s.config.CodexBinary != "", req.Msg.InstanceAdmin))
	}
	return connect.NewResponse(result), nil
}
func (s *Server) CreateCodexConnection(ctx context.Context, req *connect.Request[golfv1.CreateCodexConnectionRequest]) (*connect.Response[golfv1.CreateCodexConnectionResponse], error) {
	a, e := s.codexIdentity(ctx, req.Header())
	if e != nil {
		return nil, rpcError(e)
	}
	if !a.Admin {
		return nil, rpcError(errCodexPermission)
	}
	a.RequireAdmin = true
	if !codexName(req.Msg.Name) {
		return nil, rpcError(invalid("Provide a connection name of 1–100 characters without control characters or surrounding whitespace."))
	}
	id := uuid.NewString()
	e = s.codexGuard(ctx, a, func(tx *sql.Tx, userID int64) error {
		if _, e := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(741915268)`); e != nil {
			return errStorageUnavailable
		}
		var n int
		if e := tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_codex_connections WHERE scope='INSTANCE' AND forge_url=$1`, s.config.GiteaURL).Scan(&n); e != nil {
			return errStorageUnavailable
		}
		if n >= 64 {
			return invalid("The instance Codex connection limit is 64.")
		}
		if _, e := tx.ExecContext(ctx, `INSERT INTO golf_codex_connections(id,user_id,scope,name,forge_url,state) VALUES($1,NULL,'INSTANCE',$2,$3,'UNCONFIGURED')`, id, req.Msg.Name, s.config.GiteaURL); e != nil {
			return errStorageUnavailable
		}
		return s.codexAuditTx(ctx, tx, a, "CODEX_CONNECTION_CREATED", id)
	})
	if e != nil {
		return nil, rpcError(e)
	}
	r, e := s.codexAuthorized(ctx, a, id, true)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.CreateCodexConnectionResponse{Connection: codexVisible(r, s.config.CodexBinary != "", true)}), nil
}
func (s *Server) SetCodexConnectionAccess(ctx context.Context, req *connect.Request[golfv1.SetCodexConnectionAccessRequest]) (*connect.Response[golfv1.SetCodexConnectionAccessResponse], error) {
	a, e := s.codexIdentity(ctx, req.Header())
	if e != nil {
		return nil, rpcError(e)
	}
	if !a.Admin {
		return nil, rpcError(errCodexPermission)
	}
	a.RequireAdmin = true
	r, e := s.codexAuthorized(ctx, a, req.Msg.ConnectionId, true)
	if e != nil {
		return nil, rpcError(e)
	}
	if r.Scope != "INSTANCE" {
		return nil, rpcError(errCodexPermission)
	}
	if e = codexVersion(req.Msg.ExpectedVersion, r); e != nil {
		return nil, rpcError(e)
	}
	if !codexName(req.Msg.Name) || len(req.Msg.AllowedUserIds) > 128 {
		return nil, rpcError(invalid("Provide a bounded connection name and at most 128 allowed Golf users."))
	}
	ids := make([]int64, 0, len(req.Msg.AllowedUserIds))
	seen := map[int64]bool{}
	for _, id := range req.Msg.AllowedUserIds {
		n, e := strconv.ParseInt(id, 10, 64)
		if e != nil || n <= 0 || strconv.FormatInt(n, 10) != id || seen[n] {
			return nil, rpcError(invalid("Allowed users must be distinct canonical Golf user IDs."))
		}
		seen[n] = true
		ids = append(ids, n)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	// The authorization revision cannot change beneath native device polling.
	// Stop the local owner; a different live replica owner causes a safe refusal.
	s.codexMu.Lock()
	rt := s.codexRuntimes[r.ID]
	s.codexMu.Unlock()
	if rt != nil {
		s.closeCodexRuntime(rt)
	}
	conn, e := s.db.Conn(ctx)
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	defer conn.Close()
	var locked bool
	if e = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, codexLockID(r.ID)).Scan(&locked); e != nil || !locked {
		if e != nil {
			releaseCodexOwner(conn, codexLockID(r.ID))
		}
		return nil, rpcError(errCodexUnavailable)
	}
	defer releaseCodexOwner(conn, codexLockID(r.ID))
	e = s.codexGuard(ctx, a, func(tx *sql.Tx, userID int64) error {
		var version int64
		if e := tx.QueryRowContext(ctx, `SELECT version FROM golf_codex_connections WHERE id=$1 AND scope='INSTANCE' AND forge_url=$2 FOR UPDATE`, r.ID, s.config.GiteaURL).Scan(&version); e != nil {
			return errResourceNotFound
		}
		if version != r.Version {
			return errCodexConflict
		}
		for _, id := range ids {
			var selected int64
			if e := tx.QueryRowContext(ctx, `SELECT l.user_id FROM golf_local_accounts l JOIN golf_users u ON u.id=l.user_id WHERE l.user_id=$1 AND l.disabled_at IS NULL AND u.forge_url=$2 FOR SHARE OF l`, id, s.config.GiteaURL).Scan(&selected); e != nil {
				return invalid("An allowed user is unavailable or not a current enrolled Golf user.")
			}
		}
		if _, e := tx.ExecContext(ctx, `DELETE FROM golf_codex_connection_access WHERE connection_id=$1`, r.ID); e != nil {
			return errStorageUnavailable
		}
		for _, id := range ids {
			if _, e := tx.ExecContext(ctx, `INSERT INTO golf_codex_connection_access(connection_id,user_id) VALUES($1,$2)`, r.ID, id); e != nil {
				return errStorageUnavailable
			}
		}
		if _, e := tx.ExecContext(ctx, `UPDATE golf_codex_connections SET version=version+1,name=$2,state=CASE WHEN state='AWAITING_AUTH' THEN 'REAUTH_REQUIRED' ELSE state END,reason_code=CASE WHEN state='AWAITING_AUTH' THEN 'access_changed' ELSE reason_code END,login_id='',verification_url='',user_code='',login_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, r.ID, req.Msg.Name); e != nil {
			return errStorageUnavailable
		}
		return s.codexAuditTx(ctx, tx, a, "CODEX_ACCESS_CHANGED", r.ID)
	})
	if e != nil {
		return nil, rpcError(e)
	}
	r, e = s.codexAuthorized(ctx, a, r.ID, true)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.SetCodexConnectionAccessResponse{Connection: codexVisible(r, s.config.CodexBinary != "", true)}), nil
}

// Keep older session writers compatible with their historical migration slice;
// only Codex events use the schema023 resource attribution column.
func appendCodexAudit(ctx context.Context, q *database.Queries, e database.AppendAuditEventParams, id string) error {
	if e.OperationID == "" {
		op, err := newAuditOperation()
		if err != nil {
			return err
		}
		e.OperationID = op
	}
	err := q.AppendCodexAuditEvent(ctx, database.AppendCodexAuditEventParams{UserID: e.UserID, Action: e.Action, ActorSessionID: e.ActorSessionID, TargetSessionID: e.TargetSessionID, CredentialKind: e.CredentialKind, RevokedCount: e.RevokedCount, OperationID: e.OperationID, ExpiresAt: e.ExpiresAt, ResourceID: uuid.NullUUID{UUID: uuid.MustParse(id), Valid: true}})
	if err != nil {
		return errStorageUnavailable
	}
	return nil
}

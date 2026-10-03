package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/binary"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/codexaccount"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const codexColumns = `id::text,version,state,auth_method,email,plan_type,checked_at,login_id,verification_url,user_code,login_expires_at,reason_code,user_id,scope,name`
const codexMaxRuntime = 15 * time.Minute

var errCodexBrowserOnly = errors.New("Codex browser identity required")
var errCodexConflict = connect.NewError(connect.CodeAborted, errors.New("Codex connection changed. Refresh before retrying."))
var errCodexUnavailable = connect.NewError(connect.CodeUnavailable, errors.New("Codex account service is unavailable."))

type codexRecord struct {
	Use                                                    bool
	OwnerID                                                sql.NullInt64
	Scope, Name                                            string
	Access                                                 []string
	ID                                                     string
	Version                                                int64
	State, Method, Email, Plan, LoginID, URL, Code, Reason string
	Action                                                 string
	Checked, Expires                                       sql.NullTime
}
type codexActor struct {
	UserID, NativeID    int64
	Hash                []byte
	Credential          forgeCredential
	Admin, RequireAdmin bool
}
type codexRuntime struct {
	ownerID      int64
	connectionID string
	done         chan struct{}
	mu           sync.Mutex
	process      *codexaccount.Process
	conn         *sql.Conn
	actor        codexActor
	record       codexRecord
	closed       bool
}

func scanCodex(row workflowRunScanner) (codexRecord, error) {
	var r codexRecord
	e := row.Scan(&r.ID, &r.Version, &r.State, &r.Method, &r.Email, &r.Plan, &r.Checked, &r.LoginID, &r.URL, &r.Code, &r.Expires, &r.Reason, &r.OwnerID, &r.Scope, &r.Name)
	return r, e
}
func codexBinding(id string) []byte {
	b := sha256.Sum256([]byte("golf:codex-account:v1\x00" + id))
	return b[:]
}
func codexWire(r codexRecord, available bool) *golfv1.CodexConnection {
	v := &golfv1.CodexConnection{Id: r.ID, Name: r.Name, CanManage: true, CanUse: true, AllowedUserIds: r.Access, Scope: golfv1.CodexConnectionScope_CODEX_CONNECTION_SCOPE_PERSONAL, Version: strconv.FormatInt(r.Version, 10), Email: r.Email, PlanType: r.Plan, LoginId: r.LoginID, VerificationUrl: r.URL, UserCode: r.Code, ReasonCode: r.Reason}
	if r.Scope == "INSTANCE" {
		v.Scope = golfv1.CodexConnectionScope_CODEX_CONNECTION_SCOPE_INSTANCE
		v.CanUse = r.Use
	}
	switch r.State {
	case "CONNECTED":
		v.State = golfv1.CodexConnectionState_CODEX_CONNECTION_STATE_CONNECTED
	case "AWAITING_AUTH":
		v.State = golfv1.CodexConnectionState_CODEX_CONNECTION_STATE_AWAITING_AUTH
	case "REAUTH_REQUIRED":
		v.State = golfv1.CodexConnectionState_CODEX_CONNECTION_STATE_REAUTH_REQUIRED
	default:
		v.State = golfv1.CodexConnectionState_CODEX_CONNECTION_STATE_UNCONFIGURED
	}
	if r.Method == "chatgptDeviceCode" {
		v.AuthMethod = golfv1.CodexLoginMethod_CODEX_LOGIN_METHOD_CHATGPT_DEVICE
	} else if r.Method == "apiKey" {
		v.AuthMethod = golfv1.CodexLoginMethod_CODEX_LOGIN_METHOD_API_KEY
	}
	if r.Checked.Valid {
		v.CheckedAt = r.Checked.Time.UTC().Format(time.RFC3339Nano)
	}
	if r.Expires.Valid {
		v.LoginExpiresAt = r.Expires.Time.UTC().Format(time.RFC3339Nano)
	}
	if !available {
		v.State = golfv1.CodexConnectionState_CODEX_CONNECTION_STATE_UNAVAILABLE
		v.ReasonCode = "runtime_unavailable"
		v.LoginId = ""
		v.VerificationUrl = ""
		v.UserCode = ""
		v.LoginExpiresAt = ""
	}
	return v
}
func (s *Server) codexIdentity(ctx context.Context, h http.Header) (codexActor, error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return codexActor{}, e
	}
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated || (!token.Local && token.Kind != "oauth") {
		return codexActor{}, errCodexBrowserOnly
	}
	hash, e := sessionHash(s.cookieValue(h))
	if e != nil {
		return codexActor{}, errUnauthenticated
	}
	u, e := s.currentUser(ctx, token)
	if e != nil {
		return codexActor{}, e
	}
	a := codexActor{NativeID: u.ID, Hash: hash, Credential: token}
	e = s.codexGuard(ctx, a, func(tx *sql.Tx, id int64) error {
		a.UserID = id
		var admin bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_local_accounts WHERE user_id=$1 AND is_instance_admin AND disabled_at IS NULL)`, id).Scan(&admin); err != nil {
			return errStorageUnavailable
		}
		a.Admin = admin && token.Local
		return nil
	})
	return a, e
}

// Every post-provider write reacquires identity/session locks and current local
// authority. Disabling an account or revoking its initiating session wins.
func (s *Server) codexGuard(ctx context.Context, a codexActor, fn func(*sql.Tx, int64) error) error {
	if s.db == nil {
		return errStorageUnavailable
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	q := database.New(s.db).WithTx(tx)
	u, e := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: a.Hash, ForgeURL: s.config.GiteaURL})
	if e != nil || u.ForgeUserID != a.NativeID || (a.UserID != 0 && a.UserID != u.ID) {
		return errUnauthenticated
	}
	c, e := q.LockManagedSession(ctx, database.LockManagedSessionParams{CallerTokenHash: a.Hash, UserID: u.ID, ForgeURL: s.config.GiteaURL})
	if e != nil || (c.CredentialKind != "local" && c.CredentialKind != "oauth") {
		return errUnauthenticated
	}
	var allowed bool
	e = tx.QueryRowContext(ctx, `SELECT NOT EXISTS(SELECT 1 FROM golf_local_accounts WHERE user_id=$1 AND disabled_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM golf_sessions s JOIN golf_local_accounts a ON a.id=s.local_account_id WHERE s.token_hash=$2 AND (a.disabled_at IS NOT NULL OR a.credential_version<>s.local_credential_version))`, u.ID, a.Hash).Scan(&allowed)
	if e != nil {
		return errStorageUnavailable
	}
	if !allowed {
		return errUnauthenticated
	}
	if a.RequireAdmin {
		if c.CredentialKind != "local" {
			return errCodexPermission
		}
		var admin bool
		if e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_local_accounts WHERE user_id=$1 AND is_instance_admin AND disabled_at IS NULL)`, u.ID).Scan(&admin); e != nil {
			return errStorageUnavailable
		}
		if !admin {
			return errCodexPermission
		}
	}
	if e = fn(tx, u.ID); e != nil {
		return e
	}
	if !c.ExpiresAt.After(time.Now()) {
		return errUnauthenticated
	}
	if e = tx.Commit(); e != nil {
		return errStorageUnavailable
	}
	return nil
}
func codexVersion(value string, r codexRecord) error {
	if value != strconv.FormatInt(r.Version, 10) {
		return errCodexConflict
	}
	return nil
}
func (s *Server) closeCodexRuntime(rt *codexRuntime) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	s.closeCodexLocked(rt)
}
func (s *Server) closeCodexLocked(rt *codexRuntime) {
	if rt.closed {
		return
	}
	rt.closed = true
	close(rt.done)
	_ = rt.process.Close()
	// Explicitly unlock before returning pooled connections: session locks must
	// never leak into the SQL pool or another account's broker.
	releaseCodexOwner(rt.conn, rt.ownerID)
	s.codexMu.Lock()
	if s.codexRuntimes[rt.connectionID] == rt {
		delete(s.codexRuntimes, rt.connectionID)
	}
	s.codexMu.Unlock()
}
func (s *Server) CloseCodexAccounts() {
	s.codexMu.Lock()
	rs := make([]*codexRuntime, 0, len(s.codexRuntimes))
	for _, r := range s.codexRuntimes {
		rs = append(rs, r)
	}
	s.codexMu.Unlock()
	for _, r := range rs {
		s.closeCodexRuntime(r)
	}
}
func (s *Server) codexOpen(ctx context.Context, a codexActor, r codexRecord) (*codexRuntime, error) {
	if s.config.CodexBinary == "" {
		return nil, errCodexUnavailable
	}
	s.codexMu.Lock()
	defer s.codexMu.Unlock()
	if rt := s.codexRuntimes[r.ID]; rt != nil {
		return rt, nil
	}
	if len(s.codexRuntimes) >= 8 {
		return nil, errCodexUnavailable
	}
	// Two-int advisory keys deliberately bound identities to PostgreSQL int32.
	lockID := codexLockID(r.ID)
	conn, e := s.db.Conn(ctx)
	if e != nil {
		return nil, errStorageUnavailable
	}
	var locked bool
	if e = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, codexLockID(r.ID)).Scan(&locked); e != nil || !locked {
		if e != nil {
			releaseCodexOwner(conn, codexLockID(r.ID))
		} else {
			conn.Close()
		}
		return nil, errCodexUnavailable
	}
	release := func() { releaseCodexOwner(conn, codexLockID(r.ID)) }
	var auth []byte
	if r.ID != "" {
		var encrypted, binding []byte
		var key string
		e = conn.QueryRowContext(ctx, `SELECT encrypted_credential,credential_binding,credential_key_id FROM golf_codex_auth WHERE connection_id=$1`, r.ID).Scan(&encrypted, &binding, &key)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			release()
			return nil, errStorageUnavailable
		}
		if e == nil {
			plain, err := s.keyring.open(key, infrastructureConnectionDomain, encrypted, codexBinding(r.ID))
			if err != nil {
				release()
				return nil, err
			}
			auth = []byte(plain)
		}
	}
	p, e := codexaccount.New(context.Background(), codexaccount.Config{Binary: s.config.CodexBinary, Timeout: 10 * time.Second}, auth)
	if e != nil {
		release()
		return nil, errCodexUnavailable
	}
	rt := &codexRuntime{process: p, conn: conn, actor: a, record: r, ownerID: lockID, connectionID: r.ID, done: make(chan struct{})}
	if s.codexRuntimes == nil {
		s.codexRuntimes = map[string]*codexRuntime{}
	}
	s.codexRuntimes[r.ID] = rt
	go s.watchCodex(rt)
	go s.monitorCodexOwner(rt)
	return rt, nil
}
func (s *Server) codexSave(ctx context.Context, rt *codexRuntime, r codexRecord) error {
	if !codexOwnerAlive(ctx, rt) {
		rt.process.Close()
		return errCodexUnavailable
	}
	credential, err := s.sessionCredentialHash(ctx, rt.actor.Hash)
	if err != nil {
		return err
	}
	native, err := s.currentUser(ctx, credential)
	if err != nil || native.ID != rt.actor.NativeID {
		return errUnauthenticated
	}
	auth, e := rt.process.Snapshot()
	if e != nil || len(auth) > 65536 {
		return errCodexUnavailable
	}
	var encrypted []byte
	var key string
	if r.State == "CONNECTED" && len(auth) == 0 {
		r.State = "REAUTH_REQUIRED"
		r.Reason = "authentication_required"
		r.Email = ""
		r.Plan = ""
	}
	if len(auth) > 0 {
		encrypted, key, e = s.keyring.seal(infrastructureConnectionDomain, string(auth), codexBinding(r.ID))
		if e != nil {
			return e
		}
	}
	e = s.codexGuard(ctx, rt.actor, func(tx *sql.Tx, id int64) error {
		if r.Version == 0 {
			_, e := tx.ExecContext(ctx, `INSERT INTO golf_codex_connections(id,user_id,state,forge_url) VALUES($1,$2,'UNCONFIGURED',$3) ON CONFLICT(user_id) DO NOTHING`, r.ID, id, s.config.GiteaURL)
			if e != nil {
				return errStorageUnavailable
			}
		}
		if err := s.codexManageTx(ctx, tx, id, r); err != nil {
			return err
		}
		var version int64
		e := tx.QueryRowContext(ctx, `SELECT version FROM golf_codex_connections WHERE id=$1 AND forge_url=$2 FOR UPDATE`, r.ID, s.config.GiteaURL).Scan(&version)
		// A newly inserted connection is version 1; this first save is its first CAS.
		expected := r.Version
		if expected == 0 {
			expected = 1
		}
		if e != nil || version != expected {
			return errCodexConflict
		}
		_, e = tx.ExecContext(ctx, `UPDATE golf_codex_connections SET version=version+1,state=$2,auth_method=$3,email=$4,plan_type=$5,checked_at=$6,login_id=$7,verification_url=$8,user_code=$9,login_expires_at=$10,reason_code=$11,updated_at=clock_timestamp() WHERE id=$1`, r.ID, r.State, r.Method, r.Email, r.Plan, r.Checked, r.LoginID, r.URL, r.Code, r.Expires, r.Reason)
		if e != nil {
			return errStorageUnavailable
		}
		if len(auth) == 0 {
			_, e = tx.ExecContext(ctx, `DELETE FROM golf_codex_auth WHERE connection_id=$1`, r.ID)
		} else {
			_, e = tx.ExecContext(ctx, `INSERT INTO golf_codex_auth(connection_id,encrypted_credential,credential_binding,credential_key_id) VALUES($1,$2,$3,$4) ON CONFLICT(connection_id) DO UPDATE SET encrypted_credential=EXCLUDED.encrypted_credential,credential_key_id=EXCLUDED.credential_key_id`, r.ID, encrypted, codexBinding(r.ID), key)
		}
		if e != nil {
			return errStorageUnavailable
		}
		action := r.Action
		if action == "" {
			action = "CODEX_CONNECTION_REFRESHED"
		}
		var sessionID int64
		var kind string
		if e = tx.QueryRowContext(ctx, `SELECT session_id,credential_kind FROM golf_sessions WHERE token_hash=$1`, rt.actor.Hash).Scan(&sessionID, &kind); e != nil {
			return errUnauthenticated
		}
		return appendCodexAudit(ctx, database.New(s.db).WithTx(tx), database.AppendAuditEventParams{UserID: id, Action: action, ActorSessionID: sessionID, CredentialKind: kind}, r.ID)
	})
	if e == nil {
		r.Version++
		if r.Version == 1 {
			r.Version = 2
		}
		rt.record = r
	}
	return e
}
func clearCodexChallenge(r *codexRecord) {
	r.LoginID = ""
	r.URL = ""
	r.Code = ""
	r.Expires = sql.NullTime{}
}
func codexReported(r *codexRecord, a codexaccount.Account) {
	r.Checked = sql.NullTime{Time: time.Now(), Valid: true}
	clearCodexChallenge(r)
	r.Email = ""
	r.Plan = ""
	r.Reason = ""
	if a.Type == "chatgpt" || a.Type == "apiKey" {
		r.State = "CONNECTED"
		if a.Type == "apiKey" {
			r.Method = "apiKey"
		} else {
			r.Method = "chatgptDeviceCode"
		}
		r.Email = a.Email
		r.Plan = a.PlanType
	} else {
		r.State = "REAUTH_REQUIRED"
		r.Reason = "authentication_required"
	}
	if len(r.Email) > 254 || len(r.Plan) > 128 {
		r.Email = ""
		r.Plan = ""
		r.State = "REAUTH_REQUIRED"
		r.Reason = "invalid_provider_account"
	}
}
func (s *Server) watchCodex(rt *codexRuntime) {
	timer := time.NewTimer(codexMaxRuntime)
	defer timer.Stop()
	for {
		select {
		case event, ok := <-rt.process.Events():
			if !ok {
				s.closeCodexRuntime(rt)
				return
			}
			rt.mu.Lock()
			if rt.closed {
				rt.mu.Unlock()
				return
			}
			if rt.record.LoginID == event.LoginID && rt.record.State == "AWAITING_AUTH" {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				r := rt.record
				r.Action = "CODEX_LOGIN_COMPLETED"
				a, e := rt.process.Account(ctx, true)
				if e == nil && event.Success && rt.record.Expires.Valid && rt.record.Expires.Time.After(time.Now()) {
					codexReported(&r, a)
				} else {
					r.State = "REAUTH_REQUIRED"
					r.Reason = "authentication_required"
					clearCodexChallenge(&r)
				}
				if err := s.codexSave(ctx, rt, r); err != nil {
					s.closeCodexLocked(rt)
					rt.mu.Unlock()
					cancel()
					return
				}
				cancel()
			}
			rt.mu.Unlock()
		case <-timer.C:
			rt.mu.Lock()
			if !rt.closed && rt.record.State == "AWAITING_AUTH" && rt.record.Expires.Valid && rt.record.Expires.Time.After(time.Now()) {
				timer.Reset(time.Until(rt.record.Expires.Time))
				rt.mu.Unlock()
				continue
			}
			if !rt.closed && rt.record.State == "AWAITING_AUTH" {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				_ = rt.process.CancelLogin(ctx, rt.record.LoginID)
				r := rt.record
				r.State = "REAUTH_REQUIRED"
				r.Reason = "login_expired"
				r.Action = "CODEX_LOGIN_CANCELED"
				clearCodexChallenge(&r)
				_ = s.codexSave(ctx, rt, r)
				cancel()
			}
			s.closeCodexLocked(rt)
			rt.mu.Unlock()
			return
		}
	}
}
func (s *Server) codexGet(ctx context.Context, h http.Header, connectionID string) (*golfv1.CodexConnection, error) {
	a, e := s.codexIdentity(ctx, h)
	if e != nil {
		return nil, e
	}
	r, e := s.codexAuthorized(ctx, a, connectionID, false)
	if e != nil {
		return nil, e
	}
	if r.Scope == "INSTANCE" && a.Admin {
		a.RequireAdmin = true
	}
	if r.State == "AWAITING_AUTH" && (r.Scope == "PERSONAL" || a.Admin) {
		s.codexMu.Lock()
		rt := s.codexRuntimes[r.ID]
		s.codexMu.Unlock()
		if rt == nil {
			// Another replica may own the login; only a free native owner lock proves
			// that its database ownership ended. Owner heartbeat closes the old broker
			// on detected loss; cross-host partition qualification remains outstanding.
			// Never infer completion from cached auth files.
			conn, e := s.db.Conn(ctx)
			if e != nil {
				return nil, errStorageUnavailable
			}
			defer conn.Close()
			var locked bool
			if e = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, codexLockID(r.ID)).Scan(&locked); e != nil {
				releaseCodexOwner(conn, codexLockID(r.ID))
				return nil, errStorageUnavailable
			}
			if locked {
				defer releaseCodexOwner(conn, codexLockID(r.ID))
				e = s.codexGuard(ctx, a, func(tx *sql.Tx, id int64) error {
					if err := s.codexManageTx(ctx, tx, id, r); err != nil {
						return err
					}
					result, e := tx.ExecContext(ctx, `UPDATE golf_codex_connections SET state='REAUTH_REQUIRED',version=version+1,login_id='',verification_url='',user_code='',login_expires_at=NULL,reason_code='login_interrupted' WHERE id=$1 AND version=$2 AND state='AWAITING_AUTH'`, r.ID, r.Version)
					if e != nil {
						return errStorageUnavailable
					}
					n, _ := result.RowsAffected()
					if n != 1 {
						return errCodexConflict
					}
					return nil
				})
				if e != nil {
					return nil, e
				}
				r, e = s.codexAuthorized(ctx, a, r.ID, false)
				if e != nil {
					return nil, e
				}
			}
		}
	}
	return codexVisible(r, s.config.CodexBinary != "", r.Scope == "PERSONAL" || a.Admin), nil
}
func (s *Server) GetCodexConnection(ctx context.Context, req *connect.Request[golfv1.GetCodexConnectionRequest]) (*connect.Response[golfv1.GetCodexConnectionResponse], error) {
	r, e := s.codexGet(ctx, req.Header(), req.Msg.ConnectionId)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetCodexConnectionResponse{Connection: r}), nil
}
func (s *Server) codexMutate(ctx context.Context, h http.Header, version, action, loginID, connectionID string, method golfv1.CodexLoginMethod, apiKey string) (*golfv1.CodexConnection, error) {
	a, e := s.codexIdentity(ctx, h)
	if e != nil {
		return nil, e
	}
	r, e := s.codexAuthorized(ctx, a, connectionID, true)
	if e != nil {
		return nil, e
	}
	if r.Scope == "INSTANCE" {
		a.RequireAdmin = true
	}
	if e = codexVersion(version, r); e != nil {
		return nil, e
	}
	if action == "start" {
		if method != golfv1.CodexLoginMethod_CODEX_LOGIN_METHOD_CHATGPT_DEVICE && method != golfv1.CodexLoginMethod_CODEX_LOGIN_METHOD_API_KEY {
			return nil, invalid("Select a supported Codex authentication method.")
		}
		if (method == golfv1.CodexLoginMethod_CODEX_LOGIN_METHOD_API_KEY && (!regexp.MustCompile(`^sk-[A-Za-z0-9_-]{20,500}$`).MatchString(apiKey))) || (method == golfv1.CodexLoginMethod_CODEX_LOGIN_METHOD_CHATGPT_DEVICE && apiKey != "") {
			return nil, invalid("Codex authentication input is invalid.")
		}
	}
	if action == "disconnect" {
		return s.codexForget(ctx, a, r)
	}
	if r.ID == "" {
		r.ID = uuid.NewSHA1(uuid.NameSpaceURL, []byte("golf:personal-codex:"+s.config.GiteaURL+":"+strconv.FormatInt(a.UserID, 10))).String()
	}

	rt, e := s.codexOpen(ctx, a, r)
	if e != nil {
		return nil, e
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.closed {
		return nil, errCodexUnavailable
	}
	// Runtime is the single authority owner, but never lends the prior caller's
	// session to another operation. Every explicit request proves its own identity.
	if e = codexVersion(version, rt.record); e != nil {
		return nil, e
	}
	if !codexOwnerAlive(ctx, rt) {
		s.closeCodexLocked(rt)
		return nil, errCodexUnavailable
	}
	if rt.record.State != "AWAITING_AUTH" {
		rt.actor = a
	}
	r = rt.record
	if r.ID == "" {
		r.ID = uuid.NewString()
	}
	switch action {
	case "start":
		r.Action = "CODEX_LOGIN_STARTED"
		if r.State == "AWAITING_AUTH" {
			return nil, errCodexConflict
		}
		// Clear prior provider auth before replacement; failure must not advertise
		// that account as newly connected.
		if e = rt.process.Logout(ctx); e != nil {
			return nil, errCodexUnavailable
		}
		clearCodexChallenge(&r)
		r.Email = ""
		r.Plan = ""
		r.Checked = sql.NullTime{}
		r.State = "REAUTH_REQUIRED"
		r.Reason = "authentication_required"
		m := "chatgptDeviceCode"
		if method == golfv1.CodexLoginMethod_CODEX_LOGIN_METHOD_API_KEY {
			m = "apiKey"
		}
		r.Method = m
		login, err := rt.process.StartLogin(ctx, codexaccount.LoginRequest{Type: m, APIKey: apiKey})
		if err == nil && m == "chatgptDeviceCode" {
			if login.Type != m || login.VerificationURL != "https://auth.openai.com/codex/device" || len(login.LoginID) == 0 || len(login.LoginID) > 128 || len(login.UserCode) == 0 || len(login.UserCode) > 64 || !login.ExpiresAt.After(time.Now()) || login.ExpiresAt.After(time.Now().Add(codexMaxRuntime)) {
				err = errCodexUnavailable
			} else {
				r.State = "AWAITING_AUTH"
				r.Reason = ""
				r.LoginID = login.LoginID
				r.URL = login.VerificationURL
				r.Code = login.UserCode
				r.Expires = sql.NullTime{Time: login.ExpiresAt, Valid: true}
			}
		} else if err == nil {
			account, x := rt.process.Account(ctx, true)
			err = x
			if x == nil {
				codexReported(&r, account)
			}
		}
		saveCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if e = s.codexSave(saveCtx, rt, r); e != nil {
			s.closeCodexLocked(rt)
			return nil, e
		}
		if err != nil {
			s.closeCodexLocked(rt)
			return nil, errCodexUnavailable
		}
	case "refresh":
		r.Action = "CODEX_CONNECTION_REFRESHED"
		if r.State == "AWAITING_AUTH" {
			return nil, errCodexConflict
		}
		account, err := rt.process.Account(ctx, true)
		if err == nil {
			codexReported(&r, account)
		} else {
			r.State = "REAUTH_REQUIRED"
			r.Reason = "provider_refresh_failed"
			r.Email = ""
			r.Plan = ""
			clearCodexChallenge(&r)
		}
		saveCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if e = s.codexSave(saveCtx, rt, r); e != nil {
			s.closeCodexLocked(rt)
			return nil, e
		}
	case "cancel":
		r.Action = "CODEX_LOGIN_CANCELED"
		if r.State != "AWAITING_AUTH" || loginID == "" || loginID != r.LoginID {
			return nil, errCodexConflict
		}
		rt.actor = a
		err := rt.process.CancelLogin(ctx, loginID)
		r.State = "REAUTH_REQUIRED"
		r.Reason = "login_canceled"
		clearCodexChallenge(&r)
		saveCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if e = s.codexSave(saveCtx, rt, r); e != nil {
			s.closeCodexLocked(rt)
			return nil, e
		}
		if err != nil {
			s.closeCodexLocked(rt)
			return nil, errCodexUnavailable
		}
		s.closeCodexLocked(rt)
	}
	return codexVisible(rt.record, true, true), nil
}
func (s *Server) StartCodexLogin(ctx context.Context, req *connect.Request[golfv1.StartCodexLoginRequest]) (*connect.Response[golfv1.StartCodexLoginResponse], error) {
	r, e := s.codexMutate(ctx, req.Header(), req.Msg.ExpectedVersion, "start", "", req.Msg.ConnectionId, req.Msg.Method, req.Msg.ApiKey)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.StartCodexLoginResponse{Connection: r}), nil
}
func (s *Server) CancelCodexLogin(ctx context.Context, req *connect.Request[golfv1.CancelCodexLoginRequest]) (*connect.Response[golfv1.CancelCodexLoginResponse], error) {
	r, e := s.codexMutate(ctx, req.Header(), req.Msg.ExpectedVersion, "cancel", req.Msg.LoginId, req.Msg.ConnectionId, 0, "")
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.CancelCodexLoginResponse{Connection: r}), nil
}
func (s *Server) RefreshCodexConnection(ctx context.Context, req *connect.Request[golfv1.RefreshCodexConnectionRequest]) (*connect.Response[golfv1.RefreshCodexConnectionResponse], error) {
	r, e := s.codexMutate(ctx, req.Header(), req.Msg.ExpectedVersion, "refresh", "", req.Msg.ConnectionId, 0, "")
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.RefreshCodexConnectionResponse{Connection: r}), nil
}
func (s *Server) DisconnectCodexConnection(ctx context.Context, req *connect.Request[golfv1.DisconnectCodexConnectionRequest]) (*connect.Response[golfv1.DisconnectCodexConnectionResponse], error) {
	r, e := s.codexMutate(ctx, req.Header(), req.Msg.ExpectedVersion, "disconnect", "", req.Msg.ConnectionId, 0, "")
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.DisconnectCodexConnectionResponse{Connection: r}), nil
}

// Codex native auth blobs share infrastructure key usage/audit accounting.
// The batch budget spans every credential family; rotation never opens a broker.
func rotateCodexAuth(ctx context.Context, tx *sql.Tx, keys *Keyring, limit int) (int, error) {
	rows, e := tx.QueryContext(ctx, `SELECT connection_id::text,encrypted_credential,credential_binding,credential_key_id FROM golf_codex_auth WHERE credential_key_id<>$1 ORDER BY connection_id LIMIT $2 FOR UPDATE SKIP LOCKED`, keys.active, limit)
	if e != nil {
		return 0, errStorageUnavailable
	}
	type blob struct {
		id, key            string
		encrypted, binding []byte
	}
	var blobs []blob
	for rows.Next() {
		var b blob
		if e = rows.Scan(&b.id, &b.encrypted, &b.binding, &b.key); e != nil {
			rows.Close()
			return 0, errStorageUnavailable
		}
		blobs = append(blobs, b)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return 0, errStorageUnavailable
	}
	for _, b := range blobs {
		plain, e := keys.open(b.key, infrastructureConnectionDomain, b.encrypted, b.binding)
		if e != nil {
			return 0, e
		}
		encrypted, key, e := keys.seal(infrastructureConnectionDomain, plain, b.binding)
		if e != nil {
			return 0, e
		}
		if _, e = tx.ExecContext(ctx, `UPDATE golf_codex_auth SET encrypted_credential=$2,credential_key_id=$3 WHERE connection_id=$1`, b.id, encrypted, key); e != nil {
			return 0, errStorageUnavailable
		}
	}
	return len(blobs), nil
}

func codexOwnerAlive(ctx context.Context, rt *codexRuntime) bool {
	var alive bool
	e := rt.conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=$1::oid AND objid=$2::oid AND objsubid=1 AND granted)`, uint32(uint64(rt.ownerID)>>32), uint32(uint64(rt.ownerID))).Scan(&alive)
	return e == nil && alive
}

// A database connection is the broker's ownership fence. Closing the native
// process on detected loss prevents it continuing device polling/refresh. This
// bounded monitor does not claim instant fencing across a host/network partition.
func (s *Server) monitorCodexOwner(rt *codexRuntime) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-rt.done:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			alive := codexOwnerAlive(ctx, rt)
			cancel()
			if !alive {
				_ = rt.process.Close()
				s.closeCodexRuntime(rt)
				return
			}
		}
	}
}
func releaseCodexOwner(conn *sql.Conn, id int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, e := conn.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, id); e != nil {
		_ = conn.Raw(func(any) error { return driver.ErrBadConn })
	}
	_ = conn.Close()
}

// Disconnect always removes Golf's retained credential, even if the runtime is
// unavailable. It stops a local broker first; it does not revoke a provider API key.
func (s *Server) codexForget(ctx context.Context, a codexActor, r codexRecord) (*golfv1.CodexConnection, error) {
	s.codexMu.Lock()
	rt := s.codexRuntimes[r.ID]
	s.codexMu.Unlock()
	if rt != nil {
		s.closeCodexRuntime(rt)
	}
	if r.ID == "" {
		return codexWire(r, s.config.CodexBinary != ""), nil
	}
	conn, e := s.db.Conn(ctx)
	if e != nil {
		return nil, errStorageUnavailable
	}
	defer conn.Close()
	var locked bool
	if e = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, codexLockID(r.ID)).Scan(&locked); e != nil || !locked {
		if e != nil {
			releaseCodexOwner(conn, codexLockID(r.ID))
		}
		return nil, errCodexUnavailable
	}
	defer releaseCodexOwner(conn, codexLockID(r.ID))
	e = s.codexGuard(ctx, a, func(tx *sql.Tx, id int64) error {
		if err := s.codexManageTx(ctx, tx, id, r); err != nil {
			return err
		}
		result, e := tx.ExecContext(ctx, `UPDATE golf_codex_connections SET version=version+1,state='UNCONFIGURED',auth_method='',email='',plan_type='',checked_at=NULL,login_id='',verification_url='',user_code='',login_expires_at=NULL,reason_code='',updated_at=clock_timestamp() WHERE id=$1 AND forge_url=$2 AND version=$3`, r.ID, s.config.GiteaURL, r.Version)
		if e != nil {
			return errStorageUnavailable
		}
		n, e := result.RowsAffected()
		if e != nil || n != 1 {
			return errCodexConflict
		}
		if _, e = tx.ExecContext(ctx, `DELETE FROM golf_codex_auth WHERE connection_id=$1`, r.ID); e != nil {
			return errStorageUnavailable
		}
		var sessionID int64
		var kind string
		if e = tx.QueryRowContext(ctx, `SELECT session_id,credential_kind FROM golf_sessions WHERE token_hash=$1`, a.Hash).Scan(&sessionID, &kind); e != nil {
			return errUnauthenticated
		}
		return appendCodexAudit(ctx, database.New(s.db).WithTx(tx), database.AppendAuditEventParams{UserID: id, Action: "CODEX_CONNECTION_DISCONNECTED", ActorSessionID: sessionID, CredentialKind: kind}, r.ID)
	})
	if e != nil {
		return nil, e
	}
	r, e = s.codexAuthorized(ctx, a, r.ID, true)
	if e != nil {
		return nil, e
	}
	return codexWire(r, s.config.CodexBinary != ""), nil
}

func codexLockID(id string) int64 {
	h := sha256.Sum256([]byte("golf:codex-owner:v2\x00" + id))
	return int64(binary.BigEndian.Uint64(h[:8]))
}

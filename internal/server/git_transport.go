package server

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

// Bound the buffered readback budget; replicas retain independent read capacity.
// This is not a mutation serialization lock: per-repository durable admission is separate.
var managedGitBuffers = make(chan struct{}, 4)

func (s *Server) liveGitCredential(ctx context.Context, secret string) (gitCredentialRecord, error) {
	hash, e := gitTokenHash(secret)
	if e != nil {
		return gitCredentialRecord{}, e
	}
	if s.db == nil {
		return gitCredentialRecord{}, errStorageUnavailable
	}
	c, e := scanGitCredential(s.db.QueryRowContext(ctx, `SELECT `+gitCredentialColumns+` FROM golf_git_credentials c WHERE c.token_hash=$1 AND c.forge_url=$2`, hash, s.config.ForgeURL))
	if errors.Is(e, sql.ErrNoRows) {
		return c, errUnauthenticated
	}
	if e != nil {
		return c, errStorageUnavailable
	}
	if !c.Active || c.Revoked.Valid || !c.Expires.After(time.Now()) {
		return c, errUnauthenticated
	}
	return c, nil
}

// Source managed user/session locks precede capability and repository locks.
// OAuth refresh is resolved before entering this transaction, never recursively under its session lock.
func (s *Server) gitCredentialTransaction(ctx context.Context, c gitCredentialRecord, op func(*sql.Tx) error) error {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	q := database.New(s.db).WithTx(tx)
	actor, e := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: c.SourceHash, ForgeURL: s.config.ForgeURL})
	if errors.Is(e, sql.ErrNoRows) {
		return errUnauthenticated
	}
	if e != nil {
		return errStorageUnavailable
	}
	if e := s.requireGolfUserAccess(ctx, tx, actor.ID); e != nil {
		return e
	}
	if actor.ID != c.UserID || actor.ForgeUserID != c.NativeUserID {
		return errUnauthenticated
	}
	session, e := q.LockManagedSession(ctx, database.LockManagedSessionParams{CallerTokenHash: c.SourceHash, UserID: c.UserID, ForgeURL: s.config.ForgeURL})
	if errors.Is(e, sql.ErrNoRows) {
		return errUnauthenticated
	}
	if e != nil {
		return errStorageUnavailable
	}
	if session.SessionID != c.SourceSessionID || !session.ExpiresAt.After(time.Now()) {
		return errUnauthenticated
	}
	check := func() error {
		live, e := scanGitCredential(tx.QueryRowContext(ctx, `SELECT `+gitCredentialColumns+` FROM golf_git_credentials c WHERE c.id=$1 AND c.user_id=$2 AND c.forge_url=$3 FOR UPDATE OF c`, c.ID, c.UserID, c.ForgeURL))
		if errors.Is(e, sql.ErrNoRows) {
			return errUnauthenticated
		}
		if e != nil {
			return errStorageUnavailable
		}
		if !live.Active || live.Revoked.Valid || !live.Expires.After(time.Now()) || live.SourceSessionID != c.SourceSessionID || !bytes.Equal(live.SourceHash, c.SourceHash) || live.NativeUserID != c.NativeUserID || live.RepositoryID != c.RepositoryID || live.OwnerID != c.OwnerID || live.Mode != c.Mode {
			return errUnauthenticated
		}
		return nil
	}
	if e = check(); e != nil {
		return e
	}
	if e = op(tx); e != nil {
		return e
	}
	if e = check(); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return errStorageUnavailable
	}
	return nil
}
func gitRequestEncrypted(r *http.Request, c managedGitConfiguration) bool {
	if r.TLS != nil {
		return true
	}
	if !c.AllowLoopback {
		return false
	}
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	return e == nil && isLoopbackHost(host)
}
func gitHTTPFailure(w http.ResponseWriter, e error) {
	status := http.StatusServiceUnavailable
	message := "Golf Git transport could not confirm this request."
	var native forgeError
	switch {
	case errors.Is(e, errUnauthenticated), errors.As(e, &native) && (native.status == http.StatusUnauthorized || native.status == http.StatusForbidden):
		status = 401
		message = "Use a current repository-scoped Golf Git credential."
		w.Header().Set("WWW-Authenticate", `Basic realm="Golf Git"`)
	case errors.Is(e, errResourceNotFound), errors.As(e, &native) && native.status == http.StatusNotFound:
		status = 404
		message = "Repository is unavailable for this credential."
	case errors.Is(e, errGitProtocol):
		status = 400
		message = errGitProtocol.Error()
	case errors.Is(e, errGitTransportDisabled), errors.Is(e, errGitBackgroundUnqualified):
		status = 403
		message = e.Error()
	case errors.Is(e, errGitReceiveRecorded):
		status = 409
		message = errGitReceiveRecorded.Error()
	case errors.Is(e, errGitReceiveUnknown), errors.Is(e, errLifecycleBlocked):
		status = 409
		message = "An unresolved repository operation blocks this Git request. Inspect its original outcome; do not retry."
	}
	http.Error(w, message, status)
}

// managedGitTransport handles only canonical smart-HTTP requests. It is mounted
// solely for the explicit profile; it is not a generic native web/API reverse proxy.
func (s *Server) managedGitTransport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	config, e := s.gitConfiguration()
	if e != nil {
		gitHTTPFailure(w, e)
		return
	}
	if !config.Enabled {
		gitHTTPFailure(w, errGitTransportDisabled)
		return
	}
	if !gitRequestEncrypted(r, config) || len(r.Header.Values("Origin")) != 0 || len(r.Header.Values("Cookie")) != 0 {
		gitHTTPFailure(w, errUnauthenticated)
		return
	}
	user, secret, ok := r.BasicAuth()
	if !ok || user != "golf" || len(r.Header.Values("Authorization")) != 1 {
		gitHTTPFailure(w, errUnauthenticated)
		return
	}
	route, e := classifyGitTransport(r)
	if e != nil {
		gitHTTPFailure(w, e)
		return
	}
	cap, e := s.liveGitCredential(r.Context(), secret)
	if e != nil {
		gitHTTPFailure(w, e)
		return
	}
	write := route.Service == "git-receive-pack"
	if write && cap.Mode != "WRITE" {
		gitHTTPFailure(w, errUnauthenticated)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	select {
	case managedGitBuffers <- struct{}{}:
		defer func() { <-managedGitBuffers }()
	default:
		gitHTTPFailure(w, errStorageUnavailable)
		return
	}
	credential, e := s.sessionCredentialHash(ctx, cap.SourceHash)
	if e != nil {
		gitHTTPFailure(w, e)
		return
	}
	repo, actor, e := s.gitCurrentTarget(ctx, credential, route.Key, strconv.FormatInt(cap.RepositoryID, 10), strconv.FormatInt(cap.OwnerID, 10), write)
	if e != nil {
		gitHTTPFailure(w, e)
		return
	}
	if actor.ID != cap.NativeUserID {
		gitHTTPFailure(w, errUnauthenticated)
		return
	}
	if write {
		if e = s.gitWritePrerequisites(ctx, s.db, credential, route.Key, repo, config); e != nil {
			gitHTTPFailure(w, e)
			return
		}
	}
	limit := int64(16 << 20)
	if write {
		limit = gitReceiveLimit
	}
	var input []byte
	if r.Method == http.MethodPost {
		input, e = io.ReadAll(io.LimitReader(r.Body, limit+1))
		if e != nil || int64(len(input)) > limit {
			gitHTTPFailure(w, errGitProtocol)
			return
		}
	}
	var request gitReceiveRequest
	var operation string
	if write && !route.Advertisement {
		request, e = receiveRequest(input)
		if e == nil && !ordinaryGitUpdate(request) {
			e = errGitProtocol
		}
		if e != nil {
			gitHTTPFailure(w, e)
			return
		}
		operation, e = s.reserveGitReceive(ctx, cap, credential, route, request, config)
		if reviewDraftUUID(operation) == nil {
			w.Header().Set("Golf-Git-Operation", operation)
		}
		if e != nil {
			gitHTTPFailure(w, e)
			return
		}
		w.Header().Set("Golf-Git-Operation", operation)
		// UNKNOWN is durable before handing any potentially effective request to native.
		e = s.markGitDispatch(ctx, operation, cap)
		if e != nil {
			gitHTTPFailure(w, e)
			return
		}
	}
	var response []byte
	var report gitReceiveReport
	e = s.gitCredentialTransaction(ctx, cap, func(tx *sql.Tx) error {
		current, currentActor, e := s.gitCurrentTarget(ctx, credential, route.Key, strconv.FormatInt(cap.RepositoryID, 10), strconv.FormatInt(cap.OwnerID, 10), write)
		if e != nil {
			return e
		}
		if currentActor.ID != cap.NativeUserID {
			return errUnauthenticated
		}
		if write {
			if e = s.gitWritePrerequisites(ctx, tx, credential, route.Key, current, config); e != nil {
				return e
			}
		}
		maxResponse := int64(128 << 20)
		if route.Advertisement || write {
			maxResponse = gitReceiveResultLimit
		}
		response, e = s.forwardGit(ctx, r, credential, currentActor, route, input, maxResponse)
		if e != nil {
			return e
		}
		if write && !route.Advertisement {
			report, e = receiveReport(response, request)
			if e != nil {
				return e
			}
			if e = s.verifyGitReceiveRefs(ctx, credential, route.Key, request, report); e != nil {
				return e
			}
		}
		postRepo, latest, e := s.gitCurrentTarget(ctx, credential, route.Key, strconv.FormatInt(cap.RepositoryID, 10), strconv.FormatInt(cap.OwnerID, 10), write)
		if e != nil {
			return e
		}
		if latest.ID != cap.NativeUserID {
			return errUnauthenticated
		}
		if write {
			if e = s.gitWritePrerequisites(ctx, tx, credential, route.Key, postRepo, config); e != nil {
				return e
			}
		}
		if operation != "" {
			result, e := tx.ExecContext(ctx, `UPDATE golf_git_receive_operations SET phase='COMPLETED',accepted_count=$2,rejected_count=$3,updated_at=clock_timestamp() WHERE id=$1 AND credential_id=$4 AND phase='UNKNOWN'`, operation, report.Accepted, report.Rejected, cap.ID)
			if e != nil {
				return errStorageUnavailable
			}
			n, e := result.RowsAffected()
			if e != nil || n != 1 {
				return errGitReceiveUnknown
			}
		}
		return nil
	})
	if e != nil {
		gitHTTPFailure(w, e)
		return
	}
	if route.Advertisement {
		response, e = filterGitAdvertisement(response, route.Service)
		if e != nil {
			gitHTTPFailure(w, e)
			return
		}
	}
	content := "application/x-" + route.Service + "-result"
	if route.Advertisement {
		content = "application/x-" + route.Service + "-advertisement"
	}
	w.Header().Set("Content-Type", content)
	w.WriteHeader(200)
	_, _ = w.Write(response)
}
func (s *Server) forwardGit(ctx context.Context, incoming *http.Request, credential forgeCredential, actor User, route gitTransportRoute, input []byte, limit int64) ([]byte, error) {
	suffix := "/" + route.Key.Owner + "/" + route.Key.Name + ".git/" + route.Service
	if route.Advertisement {
		suffix = "/" + route.Key.Owner + "/" + route.Key.Name + ".git/info/refs?service=" + route.Service
	}
	request, e := http.NewRequestWithContext(ctx, incoming.Method, strings.TrimRight(s.config.ForgeURL, "/")+suffix, bytes.NewReader(input))
	if e != nil {
		return nil, errGitProtocol
	}
	request.SetBasicAuth(actor.Login, credential.Token)
	for _, header := range []string{"Content-Type", "Content-Encoding", "Git-Protocol"} {
		if value := incoming.Header.Get(header); value != "" {
			request.Header.Set(header, value)
		}
	}
	// Never copy Cookie, Sudo, Forwarded, proxy identity, URL tokens or user selected Host.
	client := *s.client
	client.Timeout = 2 * time.Minute
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, e := client.Do(request)
	if e != nil {
		return nil, errForgeUnavailable
	}
	defer response.Body.Close()
	expected := "application/x-" + route.Service + "-result"
	if route.Advertisement {
		expected = "application/x-" + route.Service + "-advertisement"
	}
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != expected || response.Uncompressed || response.Header.Get("Content-Encoding") != "" {
		return nil, errGitProtocol
	}
	if response.ContentLength > limit {
		return nil, errGitProtocol
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if e != nil || int64(len(data)) > limit {
		return nil, errGitProtocol
	}
	return data, nil
}
func (s *Server) reserveGitReceive(ctx context.Context, cap gitCredentialRecord, credential forgeCredential, route gitTransportRoute, input gitReceiveRequest, config managedGitConfiguration) (string, error) {
	operation := uuid.NewString()
	e := s.gitCredentialTransaction(ctx, cap, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, `SELECT golf_repository_lifecycle_lock($1,$2,true)`, cap.ForgeURL, cap.RepositoryID); e != nil {
			return errStorageUnavailable
		}
		var existing, phase string
		e := tx.QueryRowContext(ctx, `SELECT id,phase FROM golf_git_receive_operations WHERE credential_id=$1 AND command_hash=$2`, cap.ID, input.Digest[:]).Scan(&existing, &phase)
		if e == nil {
			operation = existing
			if phase == "COMPLETED" {
				return errGitReceiveRecorded
			}
			return errGitReceiveUnknown
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		var blocked bool
		var active int64
		if e := tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked($1,$2),golf_repository_lifecycle_active($1,$2)`, cap.ForgeURL, cap.RepositoryID).Scan(&blocked, &active); e != nil {
			return errStorageUnavailable
		}
		if blocked || active != 0 {
			return errGitReceiveUnknown
		}
		repo, actor, e := s.gitCurrentTarget(ctx, credential, route.Key, strconv.FormatInt(cap.RepositoryID, 10), strconv.FormatInt(cap.OwnerID, 10), true)
		if e != nil {
			return e
		}
		if actor.ID != cap.NativeUserID {
			return errUnauthenticated
		}
		if e = s.gitWritePrerequisites(ctx, tx, credential, route.Key, repo, config); e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO golf_git_receive_operations(id,forge_url,repository_id,owner_id,user_id,native_user_id,credential_id,command_hash,command_count,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'RESERVED')`, operation, cap.ForgeURL, cap.RepositoryID, cap.OwnerID, cap.UserID, cap.NativeUserID, cap.ID, input.Digest[:], len(input.Commands))
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return operation, e
}
func (s *Server) markGitDispatch(ctx context.Context, operation string, cap gitCredentialRecord) error {
	e := s.gitCredentialTransaction(ctx, cap, func(tx *sql.Tx) error {
		result, e := tx.ExecContext(ctx, `UPDATE golf_git_receive_operations SET phase='UNKNOWN',updated_at=clock_timestamp() WHERE id=$1 AND credential_id=$2 AND phase='RESERVED'`, operation, cap.ID)
		if e != nil {
			return errStorageUnavailable
		}
		n, e := result.RowsAffected()
		if e != nil || n != 1 {
			return errGitReceiveUnknown
		}
		return nil
	})
	return e
}
func (s *Server) GetGitReceiveOutcome(ctx context.Context, req *connect.Request[golfv1.GetGitReceiveOutcomeRequest]) (*connect.Response[golfv1.GetGitReceiveOutcomeResponse], error) {
	credential, e := gitBrowserCredential(ctx)
	if e != nil {
		return nil, e
	}
	key := keyFrom(req.Msg.Repository)
	if e = gitTarget(key, req.Msg.RepositoryId, req.Msg.OwnerId); e != nil {
		return nil, gitTransportError(e)
	}
	id, e := uuid.Parse(req.Msg.OperationId)
	if e != nil || id.String() != req.Msg.OperationId || id.Version() != 4 {
		return nil, gitTransportError(invalid("Provide the original Git operation identity."))
	}
	_, actor, e := s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, false)
	if e != nil {
		return nil, gitTransportError(e)
	}
	out := &golfv1.GetGitReceiveOutcomeResponse{}
	var created, updated time.Time
	var accepted, rejected sql.NullInt64
	e = s.workflowTransaction(ctx, s.cookieValue(req.Header()), actor.ID, func(tx *sql.Tx, caller database.LockManagedSessionRow, _ []byte) error {
		e := tx.QueryRowContext(ctx, `SELECT id,repository_id,native_user_id,phase,command_count,accepted_count,rejected_count,created_at,updated_at FROM golf_git_receive_operations WHERE id=$1 AND forge_url=$2 AND repository_id=$3 AND owner_id=$4 AND user_id=$5`, req.Msg.OperationId, s.config.ForgeURL, req.Msg.RepositoryId, req.Msg.OwnerId, caller.UserID).Scan(&out.OperationId, &out.RepositoryId, &out.ActorId, &out.Phase, &out.CommandCount, &accepted, &rejected, &created, &updated)
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		_, current, e := s.gitCurrentTarget(ctx, credential, key, req.Msg.RepositoryId, req.Msg.OwnerId, false)
		if e != nil {
			return e
		}
		if current.ID != actor.ID {
			return errUnauthenticated
		}
		return nil
	})
	if e != nil {
		return nil, gitTransportError(e)
	}
	if accepted.Valid {
		v := uint32(accepted.Int64)
		out.AcceptedCount = &v
	}
	if rejected.Valid {
		v := uint32(rejected.Int64)
		out.RejectedCount = &v
	}
	out.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	out.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	return connect.NewResponse(out), nil
}

func (s *Server) verifyGitReceiveRefs(ctx context.Context, credential forgeCredential, key repositoryKey, request gitReceiveRequest, report gitReceiveReport) error {
	base, _ := repositoryPath(key)
	for _, command := range request.Commands {
		expected := command.Old
		if report.RefAccepted[command.Ref] {
			expected = command.New
		}
		var actual string
		var e error
		if strings.HasPrefix(command.Ref, "refs/heads/") {
			actual, e = s.exactSourceBranch(ctx, base, credential, strings.TrimPrefix(command.Ref, "refs/heads/"))
		} else {
			var tag forgeTag
			tag, e = s.exactSourceTag(ctx, base, credential, strings.TrimPrefix(command.Ref, "refs/tags/"))
			actual = tag.ID
		}
		if strings.Trim(expected, "0") == "" {
			if !sourceNotFound(e) {
				return errGitReceiveUnknown
			}
			continue
		}
		if e != nil || actual != expected {
			return errGitReceiveUnknown
		}
	}
	return nil
}

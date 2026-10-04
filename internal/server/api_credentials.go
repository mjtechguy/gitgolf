package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const apiTokenPrefix = "golf_ro_"

type apiAuthKey struct{}
type apiAuth struct{ hash []byte }

func apiTokenHash(value string) ([]byte, error) {
	if len(value) != len(apiTokenPrefix)+43 || !strings.HasPrefix(value, apiTokenPrefix) {
		return nil, errUnauthenticated
	}
	encoded := strings.TrimPrefix(value, apiTokenPrefix)
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return nil, errUnauthenticated
	}
	hash := sha256.Sum256([]byte(value))
	return hash[:], nil
}

// Explicit CLI/MCP read allowlist, including identity inspection. A new
// procedure is denied until explicitly reviewed here; public procedures are
// not an exception, and API credentials cannot manage credentials or sessions.
func apiReadProcedure(procedure string) bool {
	switch procedure {
	case golfv1connect.RepositoryActivityServiceWatchRepositoryProcedure, golfv1connect.SessionServiceGetSessionProcedure,
		golfv1connect.AuditServiceListAuditEventsProcedure,
		golfv1connect.RepositoryServiceListRepositoriesProcedure, golfv1connect.RepositoryServiceGetRepositoryProcedure, golfv1connect.RepositoryServiceGetRepositoryOverviewProcedure,
		golfv1connect.RepositoryServiceGetRepositoryCreationProcedure, golfv1connect.RepositoryServiceListBranchesProcedure,
		golfv1connect.RepositoryServiceListCommitsProcedure, golfv1connect.RepositoryServiceListTagsProcedure, golfv1connect.RepositoryServiceGetContentsProcedure, golfv1connect.RepositoryServiceResolveRepositorySourceProcedure,
		golfv1connect.RepositoryServiceGetCommitDiffProcedure, golfv1connect.RepositoryServiceGetPullRequestDiffProcedure, golfv1connect.RepositoryServiceGetRepositoryComparisonProcedure, golfv1connect.RepositoryServiceListPullRequestCommitsProcedure, golfv1connect.RepositoryServiceListPullRequestChecksProcedure, golfv1connect.RepositoryServiceGetRepositoryImageProcedure, golfv1connect.RepositoryServiceListIssuesProcedure,
		golfv1connect.RepositoryServiceGetIssueProcedure, golfv1connect.RepositoryServiceListPullRequestsProcedure,
		golfv1connect.RepositoryServiceListIssueCommentsProcedure, golfv1connect.RepositoryServiceGetIssueMutationProcedure,
		golfv1connect.RepositoryServiceGetPullRequestProcedure, golfv1connect.RepositoryServiceListPullRequestReviewsProcedure, golfv1connect.RepositoryServiceGetPullRequestReviewCommentsProcedure, golfv1connect.RepositoryServiceGetPullRequestReviewMutationProcedure,
		golfv1connect.OrganizationServiceListOrganizationsProcedure, golfv1connect.OrganizationServiceGetOrganizationProcedure,
		golfv1connect.OrganizationServiceListTeamsProcedure, golfv1connect.OrganizationServiceGetTeamProcedure,
		golfv1connect.OrganizationServiceListTeamMembersProcedure, golfv1connect.OrganizationServiceListTeamRepositoriesProcedure:
		return true
	}
	return false
}

func apiHeader(header http.Header) ([]byte, bool, error) {
	values, present := header["Authorization"]
	if !present {
		return nil, false, nil
	}
	if len(values) != 1 || len(header.Values("Cookie")) != 0 {
		return nil, true, errUnauthenticated
	}
	parts := strings.Split(values[0], " ")
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return nil, true, errUnauthenticated
	}
	hash, err := apiTokenHash(parts[1])
	return hash, true, err
}

func (s *Server) liveApiCredential(ctx context.Context, queries *database.Queries) (database.GetLiveApiCredentialRow, error) {
	auth, ok := ctx.Value(apiAuthKey{}).(apiAuth)
	if !ok {
		return database.GetLiveApiCredentialRow{}, errUnauthenticated
	}
	if s.db == nil {
		return database.GetLiveApiCredentialRow{}, errStorageUnavailable
	}
	if queries == nil {
		queries = database.New(s.db)
	}
	row, err := queries.GetLiveApiCredential(ctx, database.GetLiveApiCredentialParams{TokenHash: auth.hash, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return row, errUnauthenticated
	}
	if err != nil {
		return row, errStorageUnavailable
	}
	return row, nil
}

// Re-resolve delegated authority on every post-wait session check. The context
// carries only a digest, never a synthetic cookie or a cached permission grant.
func (s *Server) authSessionHash(ctx context.Context, value string, queries *database.Queries) ([]byte, error) {
	if _, ok := ctx.Value(apiAuthKey{}).(apiAuth); ok {
		row, err := s.liveApiCredential(ctx, queries)
		return row.SourceTokenHash, err
	}
	return sessionHash(value)
}

func (s *Server) checkApiCaller(ctx context.Context, credential forgeCredential) error {
	user, err := s.currentUser(ctx, credential)
	if err != nil {
		return err
	}
	row, err := s.liveApiCredential(ctx, nil)
	if err != nil {
		return err
	}
	if user.ID != row.ForgeUserID {
		return errUnauthenticated
	}
	return nil
}

func (s *Server) apiReadInterceptor(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
		response, err := next(ctx, request)
		if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated && err == nil {
			credential, tokenErr := rpcToken(ctx)
			if tokenErr != nil {
				return nil, tokenErr
			}
			// This also covers earlier repository handlers which do not take
			// account locks. No private result is encoded before this check.
			if err := s.checkApiCaller(ctx, credential); err != nil {
				return nil, rpcError(err)
			}
		}
		if err == nil {
			credential, credentialErr := rpcToken(ctx)
			if credentialErr == nil && credential.Local && !acknowledgesCurrentSessionRevocation(request, response) {
				user, currentErr := s.currentUser(ctx, credential)
				if currentErr != nil {
					return nil, rpcError(currentErr)
				}
				if _, currentErr = s.localSessionUser(ctx, s.cookieValue(request.Header()), user); currentErr != nil {
					return nil, rpcError(currentErr)
				}
			}
		}
		return response, err
	}
}

func validApiCredentialLabel(label string) bool {
	if len(label) == 0 || len(label) > 64 || !utf8.ValidString(label) || strings.TrimSpace(label) != label {
		return false
	}
	for _, r := range label {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func appendApiCredentialEvent(ctx context.Context, queries *database.Queries, id, actor int64, action string) error {
	operation, err := newAuditOperation()
	if err != nil {
		return err
	}
	if err := queries.AppendApiCredentialEvent(ctx, database.AppendApiCredentialEventParams{CredentialID: id, ActorSessionID: actor, Action: action, OperationID: operation}); err != nil {
		return errStorageUnavailable
	}
	return nil
}

func wireApiCredential(row database.ListApiCredentialsRow) *golfv1.ApiCredential {
	revoked := ""
	if row.RevokedAt.Valid {
		revoked = row.RevokedAt.Time.Format(time.RFC3339Nano)
	}
	return &golfv1.ApiCredential{Id: strconv.FormatInt(row.ID, 10), Label: row.Label, CreatedAt: row.CreatedAt.Format(time.RFC3339Nano),
		ExpiresAt: row.ExpiresAt.Format(time.RFC3339Nano), RevokedAt: revoked, SourceSessionId: strconv.FormatInt(row.SourceSessionID, 10), SourceSessionActive: row.SourceSessionActive}
}

func (s *Server) CreateApiCredential(ctx context.Context, req *connect.Request[golfv1.CreateApiCredentialRequest]) (*connect.Response[golfv1.CreateApiCredentialResponse], error) {
	credential, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated {
		return nil, rpcError(errApiCredentialReadOnly)
	}
	if !validApiCredentialLabel(req.Msg.Label) {
		return nil, rpcError(invalid("Credential label must be nonempty trimmed UTF-8, at most 64 bytes, without control characters."))
	}
	lifetime := req.Msg.LifetimeSeconds
	if lifetime == 0 {
		lifetime = 3600
	}
	if lifetime < 60 || lifetime > 43200 {
		return nil, rpcError(invalid("Credential lifetime must be 60–43200 seconds."))
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	token := apiTokenPrefix + base64.RawURLEncoding.EncodeToString(random[:])
	tokenHash, _ := apiTokenHash(token)
	var result *golfv1.ApiCredential
	err = s.withManagedSession(ctx, s.cookieValue(req.Header()), credential, func(queries *database.Queries, caller database.LockManagedSessionRow, hash []byte) error {
		count, err := queries.CountActiveApiCredentials(ctx, database.CountActiveApiCredentialsParams{UserID: caller.UserID, ForgeURL: s.config.GiteaURL})
		if err != nil {
			return errStorageUnavailable
		}
		if count >= 100 {
			return errApiCredentialLimit
		}
		expires := time.Now().UTC().Add(time.Duration(lifetime) * time.Second)
		if caller.ExpiresAt.Before(expires) {
			expires = caller.ExpiresAt
		}
		row, err := queries.CreateApiCredential(ctx, database.CreateApiCredentialParams{UserID: caller.UserID, TokenHash: tokenHash, Label: req.Msg.Label, SourceSessionID: caller.SessionID, SourceTokenHash: hash, ExpiresAt: expires})
		if err != nil {
			return errStorageUnavailable
		}
		if err := appendApiCredentialEvent(ctx, queries, row.ID, caller.SessionID, "CREATED"); err != nil {
			return err
		}
		result = wireApiCredential(database.ListApiCredentialsRow{ID: row.ID, Label: row.Label, CreatedAt: row.CreatedAt, ExpiresAt: row.ExpiresAt, SourceSessionID: row.SourceSessionID, SourceSessionActive: true})
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.CreateApiCredentialResponse{Credential: result, Token: token}), nil
}

func (s *Server) ListApiCredentials(ctx context.Context, req *connect.Request[golfv1.ListApiCredentialsRequest]) (*connect.Response[golfv1.ListApiCredentialsResponse], error) {
	credential, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated {
		return nil, rpcError(errApiCredentialReadOnly)
	}
	page, limit, err := pagination(pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.ListApiCredentialsResponse{Page: wirePage(0)}
	err = s.withManagedSession(ctx, s.cookieValue(req.Header()), credential, func(queries *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
		rows, err := queries.ListApiCredentials(ctx, database.ListApiCredentialsParams{UserID: caller.UserID, ForgeURL: s.config.GiteaURL, RowLimit: int32(limit + 1), RowOffset: int32((page - 1) * limit)})
		if err != nil {
			return errStorageUnavailable
		}
		if len(rows) > int(limit) {
			if page == 10000 {
				return invalid("Credential listing exceeds the 10000-page limit. Increase the page size and refresh.")
			}
			rows, result.Page.NextPage = rows[:limit], page+1
		}
		for _, row := range rows {
			result.Credentials = append(result.Credentials, wireApiCredential(row))
		}
		result.CurrentSourceExpiresAt = caller.ExpiresAt.Format(time.RFC3339Nano)
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

func (s *Server) RevokeApiCredential(ctx context.Context, req *connect.Request[golfv1.RevokeApiCredentialRequest]) (*connect.Response[golfv1.RevokeApiCredentialResponse], error) {
	credential, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated {
		return nil, rpcError(errApiCredentialReadOnly)
	}
	id, err := strconv.ParseInt(req.Msg.CredentialId, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != req.Msg.CredentialId {
		return nil, rpcError(invalid("Credential ID must be a positive decimal identifier."))
	}
	var result *golfv1.ApiCredential
	err = s.withManagedSession(ctx, s.cookieValue(req.Header()), credential, func(queries *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
		count, err := queries.RevokeApiCredential(ctx, database.RevokeApiCredentialParams{ID: id, UserID: caller.UserID, ForgeURL: s.config.GiteaURL})
		if err != nil {
			return errStorageUnavailable
		}
		if count == 1 {
			if err := appendApiCredentialEvent(ctx, queries, id, caller.SessionID, "REVOKED"); err != nil {
				return err
			}
		}
		row, err := queries.GetOwnApiCredential(ctx, database.GetOwnApiCredentialParams{ID: id, UserID: caller.UserID, ForgeURL: s.config.GiteaURL})
		if errors.Is(err, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if err != nil {
			return errStorageUnavailable
		}
		result = wireApiCredential(database.ListApiCredentialsRow{ID: row.ID, Label: row.Label, CreatedAt: row.CreatedAt, ExpiresAt: row.ExpiresAt, RevokedAt: row.RevokedAt, SourceSessionID: row.SourceSessionID, SourceSessionActive: row.SourceSessionActive})
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.RevokeApiCredentialResponse{Credential: result}), nil
}

// Only the typed current-session revocation acknowledgment intentionally has no
// surviving caller. Other successful reads must recheck their local authority.
func acknowledgesCurrentSessionRevocation(request connect.AnyRequest, response connect.AnyResponse) bool {
	if request == nil || response == nil {
		return false
	}
	// These successful local mutations intentionally delete the caller's
	// session. Only their narrow, verified receipts may bypass postflight.
	credentialReceipt := func(before, after, operation string, revoked uint64, requiresLogin bool) bool {
		version, err := discussionID(before)
		if err != nil || version == 1<<63-1 || after != strconv.FormatInt(version+1, 10) || !requiresLogin || revoked == 0 {
			return false
		}
		id, err := base64.RawURLEncoding.DecodeString(operation)
		return err == nil && len(id) == 24 && base64.RawURLEncoding.EncodeToString(id) == operation
	}
	switch request.Spec().Procedure {
	case golfv1connect.SessionServiceRevokeSessionProcedure:
		reply, ok := response.(*connect.Response[golfv1.RevokeSessionResponse])
		return ok && reply != nil && reply.Msg != nil && reply.Msg.CurrentSessionRevoked
	case golfv1connect.AccountSecurityServiceChangeOwnPasswordProcedure:
		input, inputOK := request.(*connect.Request[golfv1.ChangeOwnPasswordRequest])
		reply, replyOK := response.(*connect.Response[golfv1.ChangeOwnPasswordResponse])
		return inputOK && replyOK && input != nil && input.Msg != nil && reply != nil && reply.Msg != nil &&
			credentialReceipt(input.Msg.ExpectedCredentialVersion, reply.Msg.CredentialVersion, reply.Msg.OperationId, reply.Msg.SessionsRevoked, reply.Msg.RequiresLogin)
	case golfv1connect.AccountSecurityServiceChangeOwnLoginEmailProcedure:
		input, inputOK := request.(*connect.Request[golfv1.ChangeOwnLoginEmailRequest])
		reply, replyOK := response.(*connect.Response[golfv1.ChangeOwnLoginEmailResponse])
		return inputOK && replyOK && input != nil && input.Msg != nil && reply != nil && reply.Msg != nil &&
			credentialReceipt(input.Msg.ExpectedCredentialVersion, reply.Msg.CredentialVersion, reply.Msg.OperationId, reply.Msg.SessionsRevoked, reply.Msg.RequiresLogin)
	default:
		return false
	}
}

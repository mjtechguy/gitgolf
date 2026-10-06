package server

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

// Golf administration comes only from a current operator-enrolled local
// session. Native administrator status and delegated read credentials do not
// acquire this authority, even when they share the same immutable identity.
func (s *Server) requireInstanceAdmin(ctx context.Context, value string, credential forgeCredential) error {
	_, delegated := ctx.Value(apiAuthKey{}).(apiAuth)
	if delegated || !credential.Local {
		return connect.NewError(connect.CodePermissionDenied, errors.New("A current Golf instance-administrator password session is required."))
	}
	user, err := s.currentUser(ctx, credential)
	if err != nil {
		return rpcError(err)
	}
	user, err = s.localSessionUser(ctx, value, user)
	if err != nil {
		return rpcError(err)
	}
	if !user.IsInstanceAdmin {
		return connect.NewError(connect.CodePermissionDenied, errors.New("A current Golf instance-administrator password session is required."))
	}
	return nil
}

func (s *Server) ListLocalAccounts(ctx context.Context, req *connect.Request[golfv1.ListLocalAccountsRequest]) (*connect.Response[golfv1.ListLocalAccountsResponse], error) {
	credential, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	value := s.cookieValue(req.Header())
	if err := s.requireInstanceAdmin(ctx, value, credential); err != nil {
		return nil, err
	}
	page, limit, err := pagination(pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	rows, err := database.New(s.db).ListLocalAccounts(ctx, database.ListLocalAccountsParams{
		ForgeURL: s.config.GiteaURL, RowLimit: int32(limit + 1), RowOffset: int32((page - 1) * limit),
	})
	if err != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	// Withhold private metadata if the caller is disabled, reset, revoked or
	// expires during either the database wait or provider identity verification.
	if err := s.requireInstanceAdmin(ctx, value, credential); err != nil {
		return nil, err
	}
	next := uint32(0)
	if len(rows) > int(limit) {
		if page == 10000 {
			return nil, rpcError(invalid("Local-account listing exceeds the 10000-page limit. Increase the page size and refresh."))
		}
		rows, next = rows[:limit], page+1
	}
	accounts := make([]*golfv1.LocalAccountInfo, 0, len(rows))
	for _, row := range rows {
		account := &golfv1.LocalAccountInfo{Id: strconv.FormatInt(row.ID, 10), Username: row.Username, Email: row.Email.String,
			NativeUserId: strconv.FormatInt(row.ForgeUserID, 10), IsInstanceAdmin: row.IsInstanceAdmin,
			Disabled: row.DisabledAt.Valid, CredentialVersion: strconv.FormatInt(row.CredentialVersion, 10),
			CreatedAt: row.CreatedAt.Format(time.RFC3339Nano), GolfUserId: strconv.FormatInt(row.UserID, 10), MfaVersion: row.MfaVersion, MfaEnabled: row.MfaEnabled}
		if row.DisabledAt.Valid {
			stamp := row.DisabledAt.Time.Format(time.RFC3339Nano)
			account.DisabledAt = &stamp
		}
		if row.MfaPendingExpiresAt.Valid {
			stamp := row.MfaPendingExpiresAt.Time.UTC().Format(time.RFC3339Nano)
			account.MfaPendingExpiresAt = &stamp
		}
		accounts = append(accounts, account)
	}
	out := &golfv1.ListLocalAccountsResponse{Accounts: accounts, Page: wirePage(next), AdminMfaVersion: "0"}
	hash, e := s.authSessionHash(ctx, value, nil)
	if e != nil {
		return nil, rpcError(e)
	}
	actor, e := database.New(s.db).GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
	if e != nil {
		return nil, rpcError(errUnauthenticated)
	}
	mfa, e := loadLocalMFA(ctx, s.db, actor.ID, false)
	if e == nil {
		out.AdminMfaVersion = strconv.FormatInt(mfa.Version, 10)
		out.AdminMfaEnabled = mfa.Enabled
	} else if !errors.Is(e, sql.ErrNoRows) {
		return nil, rpcError(errStorageUnavailable)
	}
	if e = s.requireInstanceAdmin(ctx, value, credential); e != nil {
		return nil, e
	}
	return connect.NewResponse(out), nil
}

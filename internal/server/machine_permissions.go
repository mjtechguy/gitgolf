package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

// Machine source writers reuse the exact browser intent, journal and native
// permission checks. A source grant never enables a protected write or merge.
func (s *Server) sourceMutationCaller(ctx context.Context, h http.Header, key repositoryKey, repositoryID string) (forgeCredential, string, error) {
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); !delegated {
		return s.reviewDraftCaller(ctx, h)
	}
	id, err := discussionID(repositoryID)
	if err != nil {
		return forgeCredential{}, "", rpcError(err)
	}
	if err = s.requireApiWriteTarget(ctx, "source:write", key, id); err != nil {
		return forgeCredential{}, "", rpcError(err)
	}
	token, err := rpcToken(ctx)
	return token, "", err
}

// This identity is confined to reviewed task inspection handlers. Credential
// management and execution still use codexIdentity, which refuses delegation.
func (s *Server) agentInspectionIdentity(ctx context.Context, h http.Header) (codexActor, error) {
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); !delegated {
		return s.codexIdentity(ctx, h)
	}
	grant, err := s.liveApiCredential(ctx, nil)
	if err != nil {
		return codexActor{}, err
	}
	auth := ctx.Value(apiAuthKey{}).(apiAuth)
	if apiWriteScope(auth.procedure) != "agents:read" {
		return codexActor{}, errApiCredentialReadOnly
	}
	token, err := rpcToken(ctx)
	if err != nil {
		return codexActor{}, err
	}
	user, err := s.currentUser(ctx, token)
	if err != nil {
		return codexActor{}, err
	}
	if user.ID != grant.ForgeUserID {
		return codexActor{}, errUnauthenticated
	}
	a := codexActor{NativeID: user.ID, Hash: grant.SourceTokenHash, Credential: token}
	err = s.codexGuard(ctx, a, func(_ *sql.Tx, id int64) error { a.UserID = id; return nil })
	return a, err
}

func (s *Server) machineInspectionTarget(ctx context.Context, key repositoryKey, id int64, scope string) error {
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); !delegated {
		return nil
	}
	err := s.requireApiWriteTarget(ctx, scope, key, id)
	if errors.Is(err, errApiCredentialReadOnly) {
		return errResourceNotFound
	}
	return err
}

func workflowInspectionToken(ctx context.Context) (forgeCredential, error) {
	if auth, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated && apiWriteScope(auth.procedure) != "actions:read" {
		return forgeCredential{}, errApiCredentialReadOnly
	}
	return rpcToken(ctx)
}
func machineCanCancel(ctx context.Context, current bool) bool {
	_, delegated := ctx.Value(apiAuthKey{}).(apiAuth)
	return current && !delegated
}

// Revalidation also covers a token revoked while waiting for an account lock.
func (s *Server) inspectionGuard(ctx context.Context, a codexActor) error {
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated {
		if _, err := s.liveApiCredential(ctx, database.New(s.db)); err != nil {
			return err
		}
	}
	return s.codexGuard(ctx, a, func(*sql.Tx, int64) error { return nil })
}

func (s *Server) machineTaskTarget(ctx context.Context, t agentTaskRecord) error {
	return s.machineInspectionTarget(ctx, repositoryKey{t.Owner, t.Name}, t.RepositoryID, "agents:read")
}

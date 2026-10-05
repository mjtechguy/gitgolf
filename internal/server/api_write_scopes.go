package server

import (
	"context"
	"slices"
	"strconv"
	"strings"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

// Only journaled collaboration operations are delegated. Account administration,
// credentials, source writes, merges and execution never inherit these scopes.
func apiWriteScope(procedure string) string {
	switch procedure {
	case golfv1connect.RepositoryServiceCreateIssueProcedure, golfv1connect.RepositoryServiceUpdateIssueProcedure:
		return "issues:write"
	case golfv1connect.RepositoryServiceCreatePullRequestProcedure, golfv1connect.RepositoryServiceUpdatePullRequestProcedure, golfv1connect.RepositoryServiceCreatePullRequestReviewProcedure:
		return "pulls:write"
	case golfv1connect.RepositoryServiceCreateIssueCommentProcedure:
		return "comment:write" // Native issue vs pull unit is resolved from the request.
	}
	return ""
}

func apiWriteRepository(owner, name string) *golfv1.RepositoryKey {
	if owner == "" && name == "" {
		return nil
	}
	return &golfv1.RepositoryKey{Owner: owner, Name: name}
}
func apiWriteRepositoryID(id int64) string {
	if id == 0 {
		return ""
	}
	return strconv.FormatInt(id, 10)
}

func (s *Server) validateApiWriteGrant(ctx context.Context, token forgeCredential, request *golfv1.CreateApiCredentialRequest) ([]string, repositoryKey, int64, error) {
	scopes := slices.Clone(request.WriteScopes)
	key := keyFrom(request.WriteRepository)
	if len(scopes) == 0 {
		if request.WriteRepository != nil || request.WriteRepositoryId != "" {
			return nil, key, 0, invalid("A write target requires an explicit write scope.")
		}
		return nil, key, 0, nil
	}
	if len(scopes) > 2 {
		return nil, key, 0, invalid("Choose issues:write and/or pulls:write.")
	}
	slices.Sort(scopes)
	for i, scope := range scopes {
		if scope != "issues:write" && scope != "pulls:write" || i > 0 && scopes[i-1] == scope {
			return nil, key, 0, invalid("Choose unique issues:write and/or pulls:write scopes.")
		}
	}
	id, err := discussionID(request.WriteRepositoryId)
	if err != nil {
		return nil, key, 0, err
	}
	if _, err = repositoryPath(key); err != nil {
		return nil, key, 0, err
	}
	repo, err := s.getRepository(ctx, token, key)
	if err != nil {
		return nil, key, 0, err
	}
	if repo.ID != id || repo.FullName != key.Owner+"/"+key.Name || repo.Name != key.Name {
		return nil, key, 0, errIssueTargetChanged
	}
	return scopes, key, id, nil
}

// Re-resolve the immutable grant for every journal entry. A valid source session
// alone is insufficient; native authority is still checked by the operation.
func (s *Server) requireApiWriteTarget(ctx context.Context, scope string, key repositoryKey, id int64) error {
	auth, delegated := ctx.Value(apiAuthKey{}).(apiAuth)
	if !delegated {
		return nil
	}
	required := apiWriteScope(auth.procedure)
	if required == "" || required != scope && required != "comment:write" {
		return errApiCredentialReadOnly
	}
	grant, err := s.liveApiCredential(ctx, nil)
	if err != nil {
		return err
	}
	if !slices.Contains(apiScopes(grant.WriteScopes), scope) || grant.WriteRepositoryID != id || grant.WriteRepositoryOwner != key.Owner || grant.WriteRepositoryName != key.Name {
		return errApiCredentialReadOnly
	}
	return nil
}

func apiScopes(value string) []string {
	if value == "" {
		return nil
	}
	return strings.Split(value, ",")
}

package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

type sessionTokenKey struct{}

func rpcToken(ctx context.Context) (forgeCredential, error) {
	token, _ := ctx.Value(sessionTokenKey{}).(forgeCredential)
	if token.Token == "" {
		return forgeCredential{}, rpcError(errUnauthenticated)
	}
	return token, nil
}
func cookieValue(header http.Header) string {
	cookie, err := (&http.Request{Header: header}).Cookie(cookieName)
	if err != nil {
		return ""
	}
	return cookie.Value
}

func (s *Server) rpcHandler() http.Handler {
	options := []connect.HandlerOption{
		connect.WithReadMaxBytes(16 << 10), connect.WithSendMaxBytes(16 << 20), connect.WithRequireConnectProtocolHeader(),
		connect.WithRecover(func(context.Context, connect.Spec, http.Header, any) error { return rpcError(errors.New("RPC panic")) }),
	}
	mux := http.NewServeMux()
	mux.Handle(golfv1connect.NewSessionServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewOrganizationServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewCapabilityServiceHandler(s, options...))
	return mux
}

// This HTTP boundary runs before Connect reads, decompresses or decodes a body.
// Only explicitly named public procedures skip opaque-session authentication.
func (s *Server) rpcBoundary(next http.Handler) http.Handler {
	writer := connect.NewErrorWriter(connect.WithRequireConnectProtocolHeader())
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fail := func(err error) { _ = writer.Write(w, r, err) }
		if r.Method != http.MethodPost {
			fail(connect.NewError(connect.CodeInvalidArgument, errors.New("RPC requests require POST.")))
			return
		}
		if r.Header.Get("Origin") != s.config.PublicURL || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			fail(connect.NewError(connect.CodePermissionDenied, errors.New("Request origin must match the configured Golf public URL.")))
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.EscapedPath() != r.URL.Path {
			fail(rpcError(invalid("RPC URLs do not accept query parameters or escaped procedure names.")))
			return
		}
		public := false
		switch strings.TrimPrefix(r.URL.Path, "/rpc") {
		case golfv1connect.SessionServiceGetAuthenticationOptionsProcedure, golfv1connect.SessionServiceBeginGiteaOAuthProcedure, golfv1connect.SessionServiceLoginWithGiteaTokenProcedure, golfv1connect.SessionServiceLogoutProcedure, golfv1connect.CapabilityServiceListCapabilitiesProcedure:
			public = true
		case golfv1connect.SessionServiceGetSessionProcedure,
			golfv1connect.SessionServiceListSessionsProcedure, golfv1connect.SessionServiceRevokeSessionProcedure, golfv1connect.SessionServiceRevokeOtherSessionsProcedure,
			golfv1connect.RepositoryServiceListRepositoriesProcedure, golfv1connect.RepositoryServiceCreateRepositoryProcedure, golfv1connect.RepositoryServiceGetRepositoryProcedure,
			golfv1connect.RepositoryServiceListBranchesProcedure, golfv1connect.RepositoryServiceListCommitsProcedure, golfv1connect.RepositoryServiceGetContentsProcedure,
			golfv1connect.RepositoryServiceListIssuesProcedure, golfv1connect.RepositoryServiceGetIssueProcedure,
			golfv1connect.OrganizationServiceListOrganizationsProcedure, golfv1connect.OrganizationServiceGetOrganizationProcedure,
			golfv1connect.OrganizationServiceListTeamsProcedure, golfv1connect.OrganizationServiceGetTeamProcedure,
			golfv1connect.OrganizationServiceListTeamMembersProcedure, golfv1connect.OrganizationServiceListTeamRepositoriesProcedure:
		default:
			fail(connect.NewError(connect.CodeNotFound, errors.New("RPC procedure not found.")))
			return
		}
		if !public {
			token, err := s.sessionCredential(r.Context(), cookieValue(r.Header))
			if err != nil {
				fail(rpcError(err))
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), sessionTokenKey{}, token))
		}
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		next.ServeHTTP(w, r)
	})
}
func wireUser(user User) *golfv1.User {
	return &golfv1.User{Id: strconv.FormatInt(user.ID, 10), Login: user.Login, FullName: user.FullName, AvatarUrl: user.AvatarURL}
}
func wireRepository(repo Repository) *golfv1.Repository {
	updated := ""
	if !repo.UpdatedAt.IsZero() {
		updated = repo.UpdatedAt.Format(time.RFC3339Nano)
	}
	return &golfv1.Repository{Id: strconv.FormatInt(repo.ID, 10), Name: repo.Name, FullName: repo.FullName, Description: repo.Description, Private: repo.Private, HtmlUrl: repo.HTMLURL, DefaultBranch: repo.DefaultBranch, UpdatedAt: updated, Empty: repo.Empty, CloneUrl: repo.CloneURL, SshUrl: repo.SSHURL}
}
func keyFrom(key *golfv1.RepositoryKey) repositoryKey {
	return repositoryKey{key.GetOwner(), key.GetName()}
}
func pageFrom(page *golfv1.PageRequest) pageRequest {
	return pageRequest{page.GetPage(), page.GetLimit()}
}
func wirePage(next uint32) *golfv1.PageResponse { return &golfv1.PageResponse{NextPage: next} }
func sourceType(value string) golfv1.SourceEntryType {
	switch value {
	case "dir":
		return golfv1.SourceEntryType_SOURCE_ENTRY_TYPE_DIRECTORY
	case "file":
		return golfv1.SourceEntryType_SOURCE_ENTRY_TYPE_FILE
	case "symlink":
		return golfv1.SourceEntryType_SOURCE_ENTRY_TYPE_SYMLINK
	case "submodule":
		return golfv1.SourceEntryType_SOURCE_ENTRY_TYPE_SUBMODULE
	default:
		return golfv1.SourceEntryType_SOURCE_ENTRY_TYPE_UNSPECIFIED
	}
}
func wireEntry(entry sourceEntry) *golfv1.SourceEntry {
	return &golfv1.SourceEntry{Name: entry.Name, Path: entry.Path, Type: sourceType(entry.Type), Sha: entry.SHA, Size: uint64(entry.Size)}
}
func wireIssue(issue Issue) *golfv1.Issue {
	state := golfv1.IssueState_ISSUE_STATE_OPEN
	if issue.State == "closed" {
		state = golfv1.IssueState_ISSUE_STATE_CLOSED
	}
	return &golfv1.Issue{Id: strconv.FormatInt(issue.ID, 10), Number: uint32(issue.Number), Title: issue.Title, Body: issue.Body, State: state, User: wireUser(issue.User), Comments: uint32(issue.Comments), CreatedAt: issue.CreatedAt, UpdatedAt: issue.UpdatedAt, HtmlUrl: issue.HTMLURL}
}
func (s *Server) LoginWithGiteaToken(ctx context.Context, req *connect.Request[golfv1.LoginWithGiteaTokenRequest]) (*connect.Response[golfv1.LoginWithGiteaTokenResponse], error) {
	result, err := s.loginSession(ctx, req.Msg.Token, cookieValue(req.Header()))
	if err != nil {
		return nil, rpcError(err)
	}
	response := connect.NewResponse(&golfv1.LoginWithGiteaTokenResponse{User: wireUser(result.User)})
	response.Header().Add("Set-Cookie", s.sessionCookie(result.Value, result.Expires, int(sessionLifetime.Seconds())).String())
	return response, nil
}
func (s *Server) GetSession(ctx context.Context, _ *connect.Request[golfv1.GetSessionRequest]) (*connect.Response[golfv1.GetSessionResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	user, err := s.currentUser(ctx, token)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetSessionResponse{User: wireUser(user)}), nil
}
func (s *Server) Logout(ctx context.Context, req *connect.Request[golfv1.LogoutRequest]) (*connect.Response[golfv1.LogoutResponse], error) {
	if err := s.logoutSession(ctx, cookieValue(req.Header())); err != nil {
		return nil, rpcError(err)
	}
	response := connect.NewResponse(&golfv1.LogoutResponse{})
	response.Header().Add("Set-Cookie", s.sessionCookie("", time.Unix(1, 0), -1).String())
	return response, nil
}
func (s *Server) ListSessions(ctx context.Context, req *connect.Request[golfv1.ListSessionsRequest]) (*connect.Response[golfv1.ListSessionsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listSessions(ctx, cookieValue(req.Header()), token, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListSessionsResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Sessions = append(response.Sessions, &golfv1.SessionInfo{Id: strconv.FormatInt(row.SessionID, 10),
			CreatedAt: row.CreatedAt.Format(time.RFC3339Nano), ExpiresAt: row.ExpiresAt.Format(time.RFC3339Nano),
			Current: row.IsCurrent, CredentialKind: row.CredentialKind})
	}
	return connect.NewResponse(response), nil
}
func (s *Server) RevokeSession(ctx context.Context, req *connect.Request[golfv1.RevokeSessionRequest]) (*connect.Response[golfv1.RevokeSessionResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	current, err := s.revokeSession(ctx, cookieValue(req.Header()), token, req.Msg.SessionId)
	if err != nil {
		return nil, rpcError(err)
	}
	response := connect.NewResponse(&golfv1.RevokeSessionResponse{CurrentSessionRevoked: current})
	if current {
		response.Header().Add("Set-Cookie", s.sessionCookie("", time.Unix(1, 0), -1).String())
	}
	return response, nil
}
func (s *Server) RevokeOtherSessions(ctx context.Context, req *connect.Request[golfv1.RevokeOtherSessionsRequest]) (*connect.Response[golfv1.RevokeOtherSessionsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	count, err := s.revokeOtherSessions(ctx, cookieValue(req.Header()), token)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.RevokeOtherSessionsResponse{RevokedCount: count}), nil
}
func (s *Server) ListRepositories(ctx context.Context, req *connect.Request[golfv1.ListRepositoriesRequest]) (*connect.Response[golfv1.ListRepositoriesResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listRepositories(ctx, token, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListRepositoriesResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Repositories = append(response.Repositories, wireRepository(row))
	}
	return connect.NewResponse(response), nil
}
func (s *Server) CreateRepository(ctx context.Context, req *connect.Request[golfv1.CreateRepositoryRequest]) (*connect.Response[golfv1.CreateRepositoryResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	repo, err := s.createRepository(ctx, token, req.Msg.Name, req.Msg.Description, req.Msg.Private)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.CreateRepositoryResponse{Repository: wireRepository(repo)}), nil
}
func (s *Server) GetRepository(ctx context.Context, req *connect.Request[golfv1.GetRepositoryRequest]) (*connect.Response[golfv1.GetRepositoryResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	repo, err := s.getRepository(ctx, token, keyFrom(req.Msg.Repository))
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetRepositoryResponse{Repository: wireRepository(repo)}), nil
}
func (s *Server) ListBranches(ctx context.Context, req *connect.Request[golfv1.ListBranchesRequest]) (*connect.Response[golfv1.ListBranchesResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listBranches(ctx, token, keyFrom(req.Msg.Repository), pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListBranchesResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Branches = append(response.Branches, &golfv1.Branch{Name: row.Name, CommitId: row.CommitID, Protected: row.Protected})
	}
	return connect.NewResponse(response), nil
}
func (s *Server) ListCommits(ctx context.Context, req *connect.Request[golfv1.ListCommitsRequest]) (*connect.Response[golfv1.ListCommitsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listCommits(ctx, token, keyFrom(req.Msg.Repository), req.Msg.Ref, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListCommitsResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Commits = append(response.Commits, &golfv1.Commit{Sha: row.SHA, Message: row.Commit.Message, AuthorName: row.Commit.Author.Name, AuthoredAt: row.Commit.Author.Date})
	}
	return connect.NewResponse(response), nil
}
func (s *Server) GetContents(ctx context.Context, req *connect.Request[golfv1.GetContentsRequest]) (*connect.Response[golfv1.GetContentsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.getContents(ctx, token, keyFrom(req.Msg.Repository), req.Msg.Ref, req.Msg.Path)
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.GetContentsResponse{CommitId: result.CommitID, Path: result.Path, Kind: sourceType(result.Kind)}
	for _, entry := range result.Entries {
		response.Entries = append(response.Entries, wireEntry(entry))
	}
	if result.File != nil {
		response.File = &golfv1.SourceFile{Entry: wireEntry(result.File.sourceEntry), Content: result.File.Content, PreviewReason: result.File.PreviewReason}
	}
	return connect.NewResponse(response), nil
}
func (s *Server) ListIssues(ctx context.Context, req *connect.Request[golfv1.ListIssuesRequest]) (*connect.Response[golfv1.ListIssuesResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	state := "open"
	switch req.Msg.State {
	case golfv1.IssueState_ISSUE_STATE_UNSPECIFIED, golfv1.IssueState_ISSUE_STATE_OPEN:
	case golfv1.IssueState_ISSUE_STATE_CLOSED:
		state = "closed"
	case golfv1.IssueState_ISSUE_STATE_ALL:
		state = "all"
	default:
		return nil, rpcError(invalid("Issue state is not supported."))
	}
	rows, next, err := s.listIssues(ctx, token, keyFrom(req.Msg.Repository), state, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListIssuesResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Issues = append(response.Issues, wireIssue(row))
	}
	return connect.NewResponse(response), nil
}
func (s *Server) GetIssue(ctx context.Context, req *connect.Request[golfv1.GetIssueRequest]) (*connect.Response[golfv1.GetIssueResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	issue, err := s.getIssue(ctx, token, keyFrom(req.Msg.Repository), req.Msg.Number)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetIssueResponse{Issue: wireIssue(issue)}), nil
}
func (s *Server) ListCapabilities(ctx context.Context, _ *connect.Request[golfv1.ListCapabilitiesRequest]) (*connect.Response[golfv1.ListCapabilitiesResponse], error) {
	_, ready := s.dependencyChecks(ctx)
	state, reason := golfv1.CapabilityState_CAPABILITY_STATE_READY, "Repository listing, creation, code browsing and read-only issues use your Gitea permissions. Issues require read:issue scope."
	if !ready {
		state, reason = golfv1.CapabilityState_CAPABILITY_STATE_DEGRADED, "PostgreSQL or the qualified Gitea 1.27.3 dependency is unavailable. Check readiness before using repositories."
	}
	capabilities := []*golfv1.Capability{{Id: "repositories", Label: "Gitea repositories", State: state, Reason: reason}}
	for _, entry := range []struct{ id, label string }{{"cloudflare", "Cloudflare integration"}, {"pipelines", "Pipeline execution"}, {"agents", "Coding agents"}, {"deployments", "Protected previews and deployment"}} {
		capabilities = append(capabilities, &golfv1.Capability{Id: entry.id, Label: entry.label, State: golfv1.CapabilityState_CAPABILITY_STATE_DISABLED, Reason: "Planned; not implemented. No operation is available."})
	}
	return connect.NewResponse(&golfv1.ListCapabilitiesResponse{Capabilities: capabilities}), nil
}

func wireOrganization(org forgeOrganization) *golfv1.Organization {
	visibility := golfv1.OrganizationVisibility(golfv1.OrganizationVisibility_value["ORGANIZATION_VISIBILITY_"+strings.ToUpper(org.Visibility)])
	return &golfv1.Organization{Id: strconv.FormatInt(org.ID, 10), Name: org.Name, FullName: org.FullName, Description: org.Description, Visibility: visibility}
}
func wireOrganizationTeam(team forgeOrganizationTeam) *golfv1.OrganizationTeam {
	permission := func(value string) golfv1.TeamPermission {
		return golfv1.TeamPermission(golfv1.TeamPermission_value["TEAM_PERMISSION_"+strings.ToUpper(value)])
	}
	units := make(map[string]golfv1.TeamPermission, len(team.UnitPermissions))
	for unit, value := range team.UnitPermissions {
		units[unit] = permission(value)
	}
	visibility := golfv1.TeamVisibility(golfv1.TeamVisibility_value["TEAM_VISIBILITY_"+strings.ToUpper(team.Visibility)])
	return &golfv1.OrganizationTeam{Id: strconv.FormatInt(team.ID, 10), Name: team.Name, Description: team.Description, Permission: permission(team.Permission), UnitPermissions: units, IncludesAllRepositories: team.IncludesAllRepositories, Visibility: visibility}
}
func (s *Server) ListOrganizations(ctx context.Context, req *connect.Request[golfv1.ListOrganizationsRequest]) (*connect.Response[golfv1.ListOrganizationsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listOrganizations(ctx, cookieValue(req.Header()), token, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListOrganizationsResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Organizations = append(response.Organizations, wireOrganization(row))
	}
	return connect.NewResponse(response), nil
}
func (s *Server) GetOrganization(ctx context.Context, req *connect.Request[golfv1.GetOrganizationRequest]) (*connect.Response[golfv1.GetOrganizationResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	org, err := s.getOrganization(ctx, cookieValue(req.Header()), token, req.Msg.Organization)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetOrganizationResponse{Organization: wireOrganization(org)}), nil
}
func (s *Server) ListTeams(ctx context.Context, req *connect.Request[golfv1.ListTeamsRequest]) (*connect.Response[golfv1.ListTeamsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listOrganizationTeams(ctx, cookieValue(req.Header()), token, req.Msg.Organization, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListTeamsResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Teams = append(response.Teams, wireOrganizationTeam(row))
	}
	return connect.NewResponse(response), nil
}
func (s *Server) GetTeam(ctx context.Context, req *connect.Request[golfv1.GetTeamRequest]) (*connect.Response[golfv1.GetTeamResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	team, err := s.getOrganizationTeam(ctx, cookieValue(req.Header()), token, req.Msg.Organization, req.Msg.TeamId)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetTeamResponse{Team: wireOrganizationTeam(team)}), nil
}
func (s *Server) ListTeamMembers(ctx context.Context, req *connect.Request[golfv1.ListTeamMembersRequest]) (*connect.Response[golfv1.ListTeamMembersResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listOrganizationTeamMembers(ctx, cookieValue(req.Header()), token, req.Msg.Organization, req.Msg.TeamId, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListTeamMembersResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Members = append(response.Members, wireUser(row))
	}
	return connect.NewResponse(response), nil
}
func (s *Server) ListTeamRepositories(ctx context.Context, req *connect.Request[golfv1.ListTeamRepositoriesRequest]) (*connect.Response[golfv1.ListTeamRepositoriesResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listOrganizationTeamRepositories(ctx, cookieValue(req.Header()), token, req.Msg.Organization, req.Msg.TeamId, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListTeamRepositoriesResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Repositories = append(response.Repositories, wireRepository(row))
	}
	return connect.NewResponse(response), nil
}

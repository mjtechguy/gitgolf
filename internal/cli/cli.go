// Package cli implements the read-only Golf client using generated Connect contracts.
package cli

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/gitinput"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const help = `Golf — inspect repositories, organizations and your account activity.

Usage: golf [--url ORIGIN] [--token-stdin | --api-token-stdin] COMMAND

  mcp                         serve local MCP on stdin/stdout
  repo list [--page N] [--limit N]
  repo view OWNER/REPO
  repo creation IDEMPOTENCY_KEY
  repo branches OWNER/REPO [--page N] [--limit N]
  repo commits OWNER/REPO [--ref REF] [--path PATH] [--page N] [--limit N]
  repo contents OWNER/REPO [--ref REF] [--path PATH]
  commit diff OWNER/REPO SHA
  issue list OWNER/REPO [--state open|closed|all] [--page N] [--limit N]
  issue view OWNER/REPO NUMBER
  issue comments OWNER/REPO NUMBER [--page N] [--limit N]
  issue operation IDEMPOTENCY_KEY
  pr list OWNER/REPO [--state open|closed|all] [--page N] [--limit N]
  pr view OWNER/REPO NUMBER
  pr reviews OWNER/REPO NUMBER [--page N] [--limit N]
  org list [--page N] [--limit N]
  org view ORG
  org teams ORG [--page N] [--limit N]
  team view ORG TEAM_ID
  team members ORG TEAM_ID [--page N] [--limit N]
  team repos ORG TEAM_ID [--page N] [--limit N]
  audit list [--limit N] [--before-id ID --snapshot-id ID]

Success writes JSON: {"schema_version":"golf.cli.v1","data":...}.
Exit codes: 0 success/help; 1 operation/authentication failure; 2 usage error.
Data uses the versioned API's Protobuf JSON format. No automatic pagination.
Pass a Gitea token on stdin with --token-stdin, or set GOLF_GITEA_TOKEN.
Pass a Golf API token on stdin with --api-token-stdin, or set GOLF_API_TOKEN.
Do not mix Golf API and Gitea token sources. Stdin overrides the same-kind environment token.
GOLF_URL defaults to http://localhost:8080. Remote origins require HTTPS.
Credentials/cookies are never saved. Gitea token commands sign in and sign out.
Golf API tokens send bearer-authenticated reads without a browser session or login/logout.
They remain bound to the issuing browser session; expiry, revocation or source sign-out denies access.
MCP takes one token from GOLF_API_TOKEN or GOLF_GITEA_TOKEN; stdin is reserved for the protocol.
Global flags precede the command; resource flags follow positional arguments.
Organization reads need read:user and read:organization; code needs read:repository.
Account activity needs read:user and records successful session lifecycle operations.
Audit pagination preserves the first snapshot ID; PAT-mode CLI calls also record their login/logout.
Commit diffs require a full lowercase 40- or 64-character commit ID; branch aliases are not accepted.
Diffs preserve bounded native Gitea text; merges compare only the first parent.
Repository creation inspection needs a canonical UUID v4 key from a prior create request.
It never creates or retries a repository; OUTCOME_UNKNOWN can include in-flight work.
Issue comments need read:repository and read:issue; empty pages can have a next page.
Issue operation inspection takes a canonical UUID v4 and never posts or retries a write.
An observed result ID is a provisional receipt; OUTCOME_UNKNOWN still means unconfirmed.
`

// Run writes PAT-mode results only after logout succeeds. Error text excludes credentials
// and upstream response bodies; even an untrusted server cannot echo a token.
func Run(ctx context.Context, args []string, input io.Reader, output, diagnostic io.Writer, getenv func(string) string) int {
	flags := flag.NewFlagSet("golf", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	origin := flags.String("url", getenv("GOLF_URL"), "Golf origin")
	stdin := flags.Bool("token-stdin", false, "read the token from stdin")
	apiStdin := flags.Bool("api-token-stdin", false, "read a Golf API token from stdin")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(output, help)
			return 0
		}
		fmt.Fprintln(diagnostic, "Invalid global flags. Run golf --help.")
		return 2
	}
	if len(flags.Args()) == 0 {
		fmt.Fprint(output, help)
		return 0
	}
	mcpMode := len(flags.Args()) == 1 && flags.Args()[0] == "mcp"
	var command command
	var err error
	if !mcpMode {
		command, err = parseCommand(flags.Args())
	}
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(output, help)
			return 0
		}
		fmt.Fprintln(diagnostic, "Invalid command or arguments. Run golf --help.")
		return 2
	}
	if *origin == "" {
		*origin = "http://localhost:8080"
	}
	base, err := parseOrigin(*origin)
	if err != nil {
		fmt.Fprintln(diagnostic, err)
		return 2
	}
	pat, apiToken := getenv("GOLF_GITEA_TOKEN"), getenv("GOLF_API_TOKEN")
	if (*stdin || pat != "") && (*apiStdin || apiToken != "") {
		fmt.Fprintln(diagnostic, "Choose one credential kind: Golf API token or Gitea token; mixed sources are not accepted.")
		return 2
	}
	if mcpMode && (*stdin || *apiStdin) {
		fmt.Fprintln(diagnostic, "MCP reserves stdin for its protocol; configure one of GOLF_API_TOKEN or GOLF_GITEA_TOKEN in the owner-controlled process environment.")
		return 2
	}
	auth := credential{token: pat}
	if *apiStdin || apiToken != "" {
		auth = credential{token: apiToken, api: true}
	}
	if *stdin || *apiStdin {
		data, err := readToken(ctx, input)
		if err != nil {
			fmt.Fprintln(diagnostic, "Token input failed or was cancelled.")
			return 1
		}
		auth.token = strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r")
	}
	if len(auth.token) < 8 || len(auth.token) > 512 || strings.ContainsAny(auth.token, "\r\n\t ") || (auth.api && !validAPIToken(auth.token)) {
		fmt.Fprintln(diagnostic, "Supply one valid token using its matching stdin flag or environment variable. Run golf --help.")
		return 2
	}
	if mcpMode {
		return runMCP(ctx, base, auth, input, output, diagnostic)
	}
	result, err := execute(ctx, base, command, auth)
	if err != nil {
		fmt.Fprintln(diagnostic, err)
		return 1
	}
	enc := json.NewEncoder(output)
	enc.SetIndent("", "  ")
	if err := enc.Encode(struct {
		Schema string          `json:"schema_version"`
		Data   json.RawMessage `json:"data"`
	}{"golf.cli.v1", result}); err != nil {
		fmt.Fprintln(diagnostic, "Could not write command result.")
		return 1
	}
	return 0
}

func readToken(ctx context.Context, input io.Reader) ([]byte, error) {
	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(input, 515))
		done <- result{data, err}
	}()
	select {
	case value := <-done:
		return value.data, value.err
	case <-ctx.Done():
		// The CLI owns stdin. Closing it unblocks a pipe whose producer is
		// still open when the user interrupts credential entry.
		if closer, ok := input.(io.Closer); ok {
			_ = closer.Close()
		}
		return nil, ctx.Err()
	}
}

func parseOrigin(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("Golf URL must be an HTTP(S) origin without credentials, path, query or fragment")
	}
	if u.Scheme == "http" {
		ip := net.ParseIP(u.Hostname())
		if u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return "", errors.New("remote Golf origins require HTTPS")
		}
	}
	return u.Scheme + "://" + u.Host, nil
}

var organizationName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
var commitID = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
var creationKey = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

type command struct {
	name         string
	organization string
	teamID       string
	repository   *golfv1.RepositoryKey
	page         *golfv1.PageRequest
	ref          string
	commitID     string
	creationKey  string
	path         string
	state        golfv1.IssueState
	number       uint32
	auditLimit   uint32
	beforeID     string
	snapshotID   string
}

func parseCommand(args []string) (command, error) {
	invalid := errors.New("invalid command")
	var result command
	if len(args) < 2 {
		return result, invalid
	}
	result.name = args[0] + " " + args[1]
	rest := args[2:]
	switch result.name {
	case "repo list", "org list", "audit list":
	case "repo creation", "issue operation":
		if len(rest) == 0 || !creationKey.MatchString(rest[0]) {
			return result, invalid
		}
		result.creationKey, rest = rest[0], rest[1:]
	case "org view", "org teams", "team view", "team members", "team repos":
		if len(rest) == 0 || !organizationName.MatchString(rest[0]) || rest[0] == "." || rest[0] == ".." {
			return result, invalid
		}
		result.organization = rest[0]
		rest = rest[1:]
		if args[0] == "team" {
			if len(rest) == 0 {
				return result, invalid
			}
			id, err := strconv.ParseInt(rest[0], 10, 64)
			if err != nil || id <= 0 || strconv.FormatInt(id, 10) != rest[0] {
				return result, invalid
			}
			result.teamID = rest[0]
			rest = rest[1:]
		}
	case "repo view", "repo branches", "repo commits", "repo contents", "commit diff", "issue list", "issue view", "issue comments", "pr list", "pr view", "pr reviews":
		if len(rest) == 0 {
			return result, invalid
		}
		parts := strings.Split(rest[0], "/")
		if len(parts) != 2 {
			return result, invalid
		}
		for _, part := range parts {
			if !organizationName.MatchString(part) || part == "." || part == ".." {
				return result, invalid
			}
		}
		result.repository = &golfv1.RepositoryKey{Owner: parts[0], Name: parts[1]}
		rest = rest[1:]
		if result.name == "commit diff" {
			if len(rest) == 0 || !commitID.MatchString(rest[0]) {
				return result, invalid
			}
			result.commitID = rest[0]
			rest = rest[1:]
		}
		if result.name == "issue view" || result.name == "issue comments" || result.name == "pr view" || result.name == "pr reviews" {
			if len(rest) == 0 {
				return result, invalid
			}
			number, err := strconv.ParseInt(rest[0], 10, 32)
			if err != nil || number < 1 || ((args[0] == "pr" || result.name == "issue comments") && strconv.FormatInt(number, 10) != rest[0]) {
				return result, invalid
			}
			result.number = uint32(number)
			rest = rest[1:]
		}
	default:
		return result, invalid
	}
	flags := flag.NewFlagSet(result.name, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var ref, filePath, state string
	page, limit := 1, 20
	paginated := result.name == "repo list" || result.name == "repo branches" || result.name == "repo commits" || result.name == "issue list" || result.name == "issue comments" || result.name == "pr list" || result.name == "pr reviews" || result.name == "org list" || result.name == "org teams" || result.name == "team members" || result.name == "team repos"
	if result.name == "audit list" {
		flags.IntVar(&limit, "limit", 20, "event limit")
		flags.StringVar(&result.beforeID, "before-id", "", "exclusive event cursor")
		flags.StringVar(&result.snapshotID, "snapshot-id", "", "initial account snapshot")
	}
	if paginated {
		flags.IntVar(&page, "page", 1, "page number")
		flags.IntVar(&limit, "limit", 20, "page size")
	}
	if result.name == "repo commits" || result.name == "repo contents" {
		flags.StringVar(&ref, "ref", "", "branch or commit")
	}
	if result.name == "repo contents" || result.name == "repo commits" {
		flags.StringVar(&filePath, "path", "", "repository-relative file or directory")
	}
	if result.name == "issue list" || result.name == "pr list" {
		flags.StringVar(&state, "state", "open", "open, closed or all")
	}
	if err := flags.Parse(rest); err != nil {
		return result, err
	}
	if len(flags.Args()) != 0 || page < 1 || page > 10000 || limit < 1 || limit > 100 || (state != "" && state != "open" && state != "closed" && state != "all") {
		return result, invalid
	}
	if result.name == "audit list" {
		for _, value := range []string{result.beforeID, result.snapshotID} {
			if value == "" {
				continue
			}
			id, err := strconv.ParseInt(value, 10, 64)
			if err != nil || id <= 0 || strconv.FormatInt(id, 10) != value {
				return result, invalid
			}
		}
		before, _ := strconv.ParseInt(result.beforeID, 10, 64)
		snapshot, _ := strconv.ParseInt(result.snapshotID, 10, 64)
		if before > snapshot {
			return result, invalid
		}
		result.auditLimit = uint32(limit)
	}
	if paginated {
		result.page = &golfv1.PageRequest{Page: uint32(page), Limit: uint32(limit)}
	}
	if !gitinput.ValidRef(ref) || !gitinput.ValidSourcePath(filePath) {
		return result, invalid
	}
	if result.name == "repo commits" && filePath != "" && !commitID.MatchString(ref) {
		return result, invalid
	}
	result.ref, result.path = ref, filePath
	result.state = map[string]golfv1.IssueState{"open": golfv1.IssueState_ISSUE_STATE_OPEN, "closed": golfv1.IssueState_ISSUE_STATE_CLOSED, "all": golfv1.IssueState_ISSUE_STATE_ALL}[state]
	return result, nil
}

type credential struct {
	token string
	api   bool
}

func validAPIToken(token string) bool {
	value, ok := strings.CutPrefix(token, "golf_ro_")
	if !ok || len(value) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func execute(ctx context.Context, origin string, command command, auth credential) (result json.RawMessage, err error) {
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	options := []connect.ClientOption{connect.WithProtoJSON(), connect.WithReadMaxBytes(8 << 20), connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
			request.Header().Set("Origin", origin)
			if auth.api {
				request.Header().Set("Authorization", "Bearer "+auth.token)
			}
			return next(ctx, request)
		}
	}))}
	if !auth.api {
		jar, _ := cookiejar.New(nil)
		client.Jar = jar
		sessions := golfv1connect.NewSessionServiceClient(client, origin+"/rpc", options...)
		_, err = sessions.LoginWithGiteaToken(ctx, connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: auth.token}))
		// Also clear a cookie set by a malformed login response. SIGKILL cannot run
		// cleanup; the server's normal session expiry remains the final bound.
		u, _ := url.Parse(origin)
		if len(jar.Cookies(u)) > 0 {
			defer func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if _, logoutErr := sessions.Logout(cleanup, connect.NewRequest(&golfv1.LogoutRequest{})); logoutErr != nil {
					err = errors.Join(err, errors.New("could not close the temporary Golf session; it will expire on the server"))
				}
			}()
		}
		if err != nil {
			return nil, operationError(err)
		}
		if len(jar.Cookies(u)) == 0 {
			return nil, errors.New("Golf did not establish a session")
		}
	}
	repositories := golfv1connect.NewRepositoryServiceClient(client, origin+"/rpc", options...)
	organizations := golfv1connect.NewOrganizationServiceClient(client, origin+"/rpc", options...)
	audit := golfv1connect.NewAuditServiceClient(client, origin+"/rpc", options...)
	message, err := command.read(ctx, repositories, organizations, audit)
	if err != nil {
		return nil, operationError(err)
	}
	return protojson.MarshalOptions{EmitDefaultValues: true}.Marshal(message)
}

func operationError(err error) error {
	// Never forward a remote error message: a malicious endpoint could echo the
	// credential, source text, or a terminal escape in a diagnostic.
	return fmt.Errorf("Golf returned %s; check the origin, connection, token scopes and resource access", connect.CodeOf(err))
}

func (command command) read(ctx context.Context, client golfv1connect.RepositoryServiceClient, organizations golfv1connect.OrganizationServiceClient, audit golfv1connect.AuditServiceClient) (proto.Message, error) {
	switch command.name {
	case "repo creation":
		response, err := client.GetRepositoryCreation(ctx, connect.NewRequest(&golfv1.GetRepositoryCreationRequest{IdempotencyKey: command.creationKey}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "audit list":
		response, err := audit.ListAuditEvents(ctx, connect.NewRequest(&golfv1.ListAuditEventsRequest{Limit: command.auditLimit, BeforeId: command.beforeID, SnapshotId: command.snapshotID}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "org list":
		response, err := organizations.ListOrganizations(ctx, connect.NewRequest(&golfv1.ListOrganizationsRequest{Page: command.page}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "org view":
		response, err := organizations.GetOrganization(ctx, connect.NewRequest(&golfv1.GetOrganizationRequest{Organization: command.organization}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "org teams":
		response, err := organizations.ListTeams(ctx, connect.NewRequest(&golfv1.ListTeamsRequest{Organization: command.organization, Page: command.page}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "team view":
		response, err := organizations.GetTeam(ctx, connect.NewRequest(&golfv1.GetTeamRequest{Organization: command.organization, TeamId: command.teamID}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "team members":
		response, err := organizations.ListTeamMembers(ctx, connect.NewRequest(&golfv1.ListTeamMembersRequest{Organization: command.organization, TeamId: command.teamID, Page: command.page}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "team repos":
		response, err := organizations.ListTeamRepositories(ctx, connect.NewRequest(&golfv1.ListTeamRepositoriesRequest{Organization: command.organization, TeamId: command.teamID, Page: command.page}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "repo list":
		response, err := client.ListRepositories(ctx, connect.NewRequest(&golfv1.ListRepositoriesRequest{Page: command.page}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "repo view":
		response, err := client.GetRepository(ctx, connect.NewRequest(&golfv1.GetRepositoryRequest{Repository: command.repository}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "repo branches":
		response, err := client.ListBranches(ctx, connect.NewRequest(&golfv1.ListBranchesRequest{Repository: command.repository, Page: command.page}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "repo commits":
		input := &golfv1.ListCommitsRequest{Repository: command.repository, Page: command.page, Ref: command.ref, Path: command.path}
		if command.path != "" {
			metadata, err := client.GetRepository(ctx, connect.NewRequest(&golfv1.GetRepositoryRequest{Repository: command.repository}))
			if err != nil {
				return nil, err
			}
			if metadata.Msg.Repository == nil || metadata.Msg.Repository.Id == "" {
				return nil, errors.New("repository identity unavailable")
			}
			input.RepositoryId = metadata.Msg.Repository.Id
		}
		response, err := client.ListCommits(ctx, connect.NewRequest(input))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "repo contents":
		response, err := client.GetContents(ctx, connect.NewRequest(&golfv1.GetContentsRequest{Repository: command.repository, Ref: command.ref, Path: command.path}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "commit diff":
		response, err := client.GetCommitDiff(ctx, connect.NewRequest(&golfv1.GetCommitDiffRequest{Repository: command.repository, CommitId: command.commitID}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "issue list":
		response, err := client.ListIssues(ctx, connect.NewRequest(&golfv1.ListIssuesRequest{Repository: command.repository, State: command.state, Page: command.page}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "issue view":
		response, err := client.GetIssue(ctx, connect.NewRequest(&golfv1.GetIssueRequest{Repository: command.repository, Number: command.number}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "issue comments":
		// Resolve both native identities within this call's existing authority.
		// The server checks these expected IDs again before returning comments.
		repository, err := client.GetRepository(ctx, connect.NewRequest(&golfv1.GetRepositoryRequest{Repository: command.repository}))
		if err != nil {
			return nil, err
		}
		issue, err := client.GetIssue(ctx, connect.NewRequest(&golfv1.GetIssueRequest{Repository: command.repository, Number: command.number}))
		if err != nil {
			return nil, err
		}
		if repository.Msg.GetRepository().GetId() == "" || issue.Msg.GetIssue().GetId() == "" || issue.Msg.GetIssue().GetNumber() != command.number {
			return nil, errors.New("invalid discussion identity response")
		}
		response, err := client.ListIssueComments(ctx, connect.NewRequest(&golfv1.ListIssueCommentsRequest{
			Repository: command.repository, RepositoryId: repository.Msg.Repository.Id,
			Number: command.number, IssueId: issue.Msg.Issue.Id, Page: command.page,
		}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "issue operation":
		response, err := client.GetIssueMutation(ctx, connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: command.creationKey}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "pr list":
		response, err := client.ListPullRequests(ctx, connect.NewRequest(&golfv1.ListPullRequestsRequest{Repository: command.repository, State: command.state, Page: command.page}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "pr view":
		response, err := client.GetPullRequest(ctx, connect.NewRequest(&golfv1.GetPullRequestRequest{Repository: command.repository, Number: command.number}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	case "pr reviews":
		response, err := client.ListPullRequestReviews(ctx, connect.NewRequest(&golfv1.ListPullRequestReviewsRequest{Repository: command.repository, Number: command.number, Page: command.page}))
		if err != nil {
			return nil, err
		}
		return response.Msg, nil
	default:
		return nil, errors.New("invalid command")
	}
}

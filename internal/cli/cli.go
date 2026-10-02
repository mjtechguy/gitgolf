// Package cli implements the read-only Golf client using generated Connect contracts.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const help = `Golf — inspect repositories using your own permissions.

Usage: golf [--url ORIGIN] [--token-stdin] COMMAND

  repo list [--page N] [--limit N]
  repo view OWNER/REPO
  repo branches OWNER/REPO [--page N] [--limit N]
  repo commits OWNER/REPO [--ref REF] [--page N] [--limit N]
  repo contents OWNER/REPO [--ref REF] [--path PATH]
  issue list OWNER/REPO [--state open|closed|all] [--page N] [--limit N]
  issue view OWNER/REPO NUMBER

Success writes JSON: {"schema_version":"golf.cli.v1","data":...}.
Exit codes: 0 success/help; 1 operation/authentication failure; 2 usage error.
Data uses the versioned API's Protobuf JSON format. No automatic pagination.
Pass a Gitea token on stdin with --token-stdin, or set GOLF_GITEA_TOKEN.
GOLF_URL defaults to http://localhost:8080. Remote origins require HTTPS.
Credentials/cookies are never saved. Each command signs in and signs out.
Global flags precede the command; resource flags follow OWNER/REPO.
`

// Run writes results only after logout succeeds. Error text excludes credentials
// and upstream response bodies; even an untrusted server cannot echo a token.
func Run(ctx context.Context, args []string, input io.Reader, output, diagnostic io.Writer, getenv func(string) string) int {
	flags := flag.NewFlagSet("golf", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	origin := flags.String("url", getenv("GOLF_URL"), "Golf origin")
	stdin := flags.Bool("token-stdin", false, "read the token from stdin")
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
	command, err := parseCommand(flags.Args())
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
	token := getenv("GOLF_GITEA_TOKEN")
	if *stdin {
		data, err := readToken(ctx, input)
		if err != nil {
			fmt.Fprintln(diagnostic, "Token input failed or was cancelled.")
			return 1
		}
		token = strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r")
	}
	if len(token) < 8 || len(token) > 512 || strings.ContainsAny(token, "\r\n\t ") {
		fmt.Fprintln(diagnostic, "Supply one valid Gitea token using --token-stdin or GOLF_GITEA_TOKEN.")
		return 2
	}
	result, err := execute(ctx, base, command, token)
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

type command struct {
	name       string
	repository *golfv1.RepositoryKey
	page       *golfv1.PageRequest
	ref        string
	path       string
	state      golfv1.IssueState
	number     uint32
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
	case "repo list":
	case "repo view", "repo branches", "repo commits", "repo contents", "issue list", "issue view":
		if len(rest) == 0 {
			return result, invalid
		}
		parts := strings.Split(rest[0], "/")
		if len(parts) != 2 {
			return result, invalid
		}
		for _, part := range parts {
			if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\\r\n\x00") {
				return result, invalid
			}
		}
		result.repository = &golfv1.RepositoryKey{Owner: parts[0], Name: parts[1]}
		rest = rest[1:]
		if result.name == "issue view" {
			if len(rest) == 0 {
				return result, invalid
			}
			number, err := strconv.ParseInt(rest[0], 10, 32)
			if err != nil || number < 1 {
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
	paginated := result.name == "repo list" || result.name == "repo branches" || result.name == "repo commits" || result.name == "issue list"
	if paginated {
		flags.IntVar(&page, "page", 1, "page number")
		flags.IntVar(&limit, "limit", 20, "page size")
	}
	if result.name == "repo commits" || result.name == "repo contents" {
		flags.StringVar(&ref, "ref", "", "branch or commit")
	}
	if result.name == "repo contents" {
		flags.StringVar(&filePath, "path", "", "repository-relative file or directory")
	}
	if result.name == "issue list" {
		flags.StringVar(&state, "state", "open", "issue state")
	}
	if err := flags.Parse(rest); err != nil {
		return result, err
	}
	if len(flags.Args()) != 0 || page < 1 || page > 10000 || limit < 1 || limit > 100 || (state != "" && state != "open" && state != "closed" && state != "all") {
		return result, invalid
	}
	if paginated {
		result.page = &golfv1.PageRequest{Page: uint32(page), Limit: uint32(limit)}
	}
	result.ref, result.path = ref, filePath
	result.state = map[string]golfv1.IssueState{"open": golfv1.IssueState_ISSUE_STATE_OPEN, "closed": golfv1.IssueState_ISSUE_STATE_CLOSED, "all": golfv1.IssueState_ISSUE_STATE_ALL}[state]
	return result, nil
}

func execute(ctx context.Context, origin string, command command, token string) (result json.RawMessage, err error) {
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	options := []connect.ClientOption{connect.WithProtoJSON(), connect.WithReadMaxBytes(8 << 20), connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
			request.Header().Set("Origin", origin)
			return next(ctx, request)
		}
	}))}
	sessions := golfv1connect.NewSessionServiceClient(client, origin+"/rpc", options...)
	_, err = sessions.LoginWithGiteaToken(ctx, connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: token}))
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
	repositories := golfv1connect.NewRepositoryServiceClient(client, origin+"/rpc", options...)
	message, err := command.read(ctx, repositories)
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

func (command command) read(ctx context.Context, client golfv1connect.RepositoryServiceClient) (proto.Message, error) {
	switch command.name {
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
		response, err := client.ListCommits(ctx, connect.NewRequest(&golfv1.ListCommitsRequest{Repository: command.repository, Page: command.page, Ref: command.ref}))
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
	default:
		return nil, errors.New("invalid command")
	}
}

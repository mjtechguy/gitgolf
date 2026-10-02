// Package cli implements the bootstrap, read-only Golf JSON client.
package cli

import (
	"bytes"
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

Success writes JSON: {"schema_version":"golf.cli.v0","data":...}.
Exit codes: 0 success/help; 1 operation/authentication failure; 2 usage error.
This bootstrap schema is not a stable public API. No automatic pagination.
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
	path, err := endpoint(flags.Args())
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
	result, err := execute(ctx, base, path, token)
	if err != nil {
		fmt.Fprintln(diagnostic, err)
		return 1
	}
	enc := json.NewEncoder(output)
	enc.SetIndent("", "  ")
	if err := enc.Encode(struct {
		Schema string          `json:"schema_version"`
		Data   json.RawMessage `json:"data"`
	}{"golf.cli.v0", result}); err != nil {
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

func endpoint(args []string) (string, error) {
	invalid := errors.New("invalid command")
	if len(args) < 2 {
		return "", invalid
	}
	command := args[0] + " " + args[1]
	path := "/api/repositories"
	rest := args[2:]
	switch command {
	case "repo list":
	case "repo view", "repo branches", "repo commits", "repo contents", "issue list", "issue view":
		if len(rest) == 0 {
			return "", invalid
		}
		parts := strings.Split(rest[0], "/")
		if len(parts) != 2 {
			return "", invalid
		}
		for _, part := range parts {
			if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\\r\n\x00") {
				return "", invalid
			}
			path += "/" + url.PathEscape(part)
		}
		rest = rest[1:]
		switch command {
		case "repo branches", "repo commits", "repo contents":
			path += "/" + args[1]
		case "issue list", "issue view":
			path += "/issues"
			if command == "issue view" {
				if len(rest) == 0 {
					return "", invalid
				}
				number, err := strconv.ParseInt(rest[0], 10, 32)
				if err != nil || number < 1 {
					return "", invalid
				}
				path += "/" + strconv.FormatInt(number, 10)
				rest = rest[1:]
			}
		}
	default:
		return "", invalid
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var ref, filePath, state string
	page, limit := 1, 20
	paginated := command == "repo list" || command == "repo branches" || command == "repo commits" || command == "issue list"
	if paginated {
		flags.IntVar(&page, "page", 1, "page number")
		flags.IntVar(&limit, "limit", 20, "page size")
	}
	if command == "repo commits" || command == "repo contents" {
		flags.StringVar(&ref, "ref", "", "branch or commit")
	}
	if command == "repo contents" {
		flags.StringVar(&filePath, "path", "", "repository-relative file or directory")
	}
	if command == "issue list" {
		flags.StringVar(&state, "state", "open", "issue state")
	}
	if err := flags.Parse(rest); err != nil {
		return "", err
	}
	if len(flags.Args()) != 0 || page < 1 || page > 10000 || limit < 1 || limit > 100 || (state != "" && state != "open" && state != "closed" && state != "all") {
		return "", invalid
	}
	query := url.Values{}
	if paginated {
		query.Set("page", strconv.Itoa(page))
		query.Set("limit", strconv.Itoa(limit))
	}
	for key, value := range map[string]string{"ref": ref, "path": filePath, "state": state} {
		if value != "" {
			query.Set(key, value)
		}
	}
	if len(query) != 0 {
		path += "?" + query.Encode()
	}
	return path, nil
}

func execute(ctx context.Context, origin, path, token string) (result json.RawMessage, err error) {
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	body, _ := json.Marshal(map[string]string{"token": token})
	_, err = request(ctx, client, origin, "POST", "/api/session", body)
	// Also clear a cookie set by a malformed login response. SIGKILL cannot run
	// cleanup; the server's normal session expiry remains the final bound.
	u, _ := url.Parse(origin)
	if len(jar.Cookies(u)) > 0 {
		defer func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, logoutErr := request(cleanup, client, origin, "DELETE", "/api/session", nil); logoutErr != nil {
				err = errors.Join(err, errors.New("could not close the temporary Golf session; it will expire on the server"))
			}
		}()
	}
	if err != nil {
		return nil, err
	}
	if len(jar.Cookies(u)) == 0 {
		return nil, errors.New("Golf did not establish a session")
	}
	return request(ctx, client, origin, "GET", path, nil)
}

func request(ctx context.Context, client *http.Client, origin, method, path string, body []byte) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, method, origin+path, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("could not construct Golf request")
	}
	req.Header.Set("Origin", origin)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, errors.New("Golf request failed; check the origin, connection and TLS certificate")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("Golf returned HTTP %d for %s; verify your token scopes and resource access", res.StatusCode, method)
	}
	if method == "DELETE" && res.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	const maxResponse = 8 << 20
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxResponse+1))
	if err != nil || len(raw) > maxResponse || !json.Valid(raw) {
		return nil, errors.New("Golf returned invalid JSON or exceeded the 8 MiB response limit")
	}
	return raw, nil
}

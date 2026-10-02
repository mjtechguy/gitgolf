package cli

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var fixtureAPIToken = "golf_ro_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{17}, 32))

type unreadInput struct{ t *testing.T }

func (r unreadInput) Read([]byte) (int, error) {
	r.t.Error("invalid credential configuration consumed stdin")
	return 0, io.EOF
}

func TestCredentialSourcesFailBeforeInputOrNetwork(t *testing.T) {
	for _, test := range []struct {
		args []string
		env  map[string]string
	}{
		{[]string{"repo", "list"}, map[string]string{"GOLF_API_TOKEN": fixtureAPIToken, "GOLF_GITEA_TOKEN": "private-pat"}},
		{[]string{"--api-token-stdin", "--token-stdin", "repo", "list"}, nil},
		{[]string{"--api-token-stdin", "repo", "list"}, map[string]string{"GOLF_GITEA_TOKEN": "private-pat"}},
		{[]string{"--token-stdin", "repo", "list"}, map[string]string{"GOLF_API_TOKEN": fixtureAPIToken}},
		{[]string{"--api-token-stdin", "mcp"}, nil},
		{[]string{"--token-stdin", "mcp"}, nil},
		{[]string{"mcp"}, map[string]string{"GOLF_API_TOKEN": fixtureAPIToken, "GOLF_GITEA_TOKEN": "private-pat"}},
	} {
		var output, diagnostic bytes.Buffer
		code := Run(context.Background(), test.args, unreadInput{t}, &output, &diagnostic, func(key string) string { return test.env[key] })
		if code != 2 || output.Len() != 0 || strings.Contains(diagnostic.String(), fixtureAPIToken) || strings.Contains(diagnostic.String(), "private-pat") {
			t.Fatal("ambiguous/reserved credential input did not fail privately")
		}
	}
	for _, token := range []string{"golf_ro_", fixtureAPIToken + "=", strings.Replace(fixtureAPIToken, "golf_ro_", "golf_rw_", 1), fixtureAPIToken[:50] + "R", " " + fixtureAPIToken, fixtureAPIToken + "\x1b", "golf_ro_" + strings.Repeat("a", 43)} {
		var output, diagnostic bytes.Buffer
		code := Run(context.Background(), []string{"repo", "list"}, unreadInput{t}, &output, &diagnostic, func(key string) string {
			if key == "GOLF_API_TOKEN" {
				return token
			}
			return ""
		})
		if code != 2 || output.Len() != 0 || strings.Contains(diagnostic.String(), token) {
			t.Fatal("noncanonical API credential accepted or disclosed")
		}
	}
}

func TestAPITokenReadUsesOnlyBearerAndNoLifecycle(t *testing.T) {
	for _, stdin := range []bool{false, true} {
		for _, status := range []int{200, 401, 403, 404, 503} {
			t.Run(fmt.Sprintf("stdin=%v/status=%d", stdin, status), func(t *testing.T) {
				var calls []string
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls = append(calls, r.URL.Path)
					if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer "+fixtureAPIToken || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("Connect-Protocol-Version") != "1" {
						t.Error("API token request lost its origin/credential boundary")
					}
					http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "must-not-reuse", Path: "/"})
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(status)
					if status == 200 {
						fmt.Fprint(w, `{"repositories":[{"id":"9007199254740993","name":"private"}]}`)
					} else {
						code := map[int]string{401: "unauthenticated", 403: "permission_denied", 404: "not_found", 503: "unavailable"}[status]
						fmt.Fprintf(w, `{"code":%q,"message":%q}`, code, fixtureAPIToken)
					}
				}))
				defer upstream.Close()
				args := []string{"--url", upstream.URL}
				if stdin {
					args = append(args, "--api-token-stdin")
				}
				args = append(args, "repo", "list")
				for range 2 {
					var output, diagnostic bytes.Buffer
					code := Run(context.Background(), args, strings.NewReader(fixtureAPIToken+"\r\n"), &output, &diagnostic, func(key string) string {
						if key == "GOLF_API_TOKEN" {
							if stdin {
								return "same-kind-env-is-overridden"
							}
							return fixtureAPIToken
						}
						return ""
					})
					if status == 200 {
						if code != 0 || !strings.Contains(output.String(), `"9007199254740993"`) || diagnostic.Len() != 0 {
							t.Fatal("bearer read result failed")
						}
					} else if code != 1 || output.Len() != 0 {
						t.Fatal("bearer denial returned a result")
					}
					if strings.Contains(output.String()+diagnostic.String(), fixtureAPIToken) {
						t.Fatal("remote error disclosed bearer")
					}
				}
				want := []string{"/rpc/golf.v1.RepositoryService/ListRepositories", "/rpc/golf.v1.RepositoryService/ListRepositories"}
				if !reflect.DeepEqual(calls, want) {
					t.Fatal("bearer read called a login/logout or lifecycle procedure")
				}
			})
		}
	}
}

func TestAPITokenRedirectAndCancellation(t *testing.T) {
	var reached atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) }))
	defer redirect.Close()
	auth := credential{token: fixtureAPIToken, api: true}
	if _, err := execute(context.Background(), redirect.URL, command{name: "repo list"}, auth); err == nil || reached.Load() {
		t.Fatal("bearer followed a redirect")
	}
	started, stopped := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+fixtureAPIToken || !strings.HasSuffix(r.URL.Path, "/ListRepositories") {
			t.Error("unexpected bearer procedure")
		}
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer upstream.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := execute(ctx, upstream.URL, command{name: "repo list"}, auth); done <- err }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("bearer request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled bearer request succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("bearer cancellation blocked")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("HTTP request did not observe cancellation")
	}
}

func TestMCPAPICredentialBothProtocolsAndRevocation(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			var reads atomic.Int32
			var revoked atomic.Bool
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/rpc/golf.v1.RepositoryService/ListRepositories" || r.Header.Get("Authorization") != "Bearer "+fixtureAPIToken || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "http://"+r.Host {
					t.Error("MCP bearer crossed owner origin/token/read boundary")
				}
				reads.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if revoked.Load() {
					w.WriteHeader(401)
					fmt.Fprintf(w, `{"code":"unauthenticated","message":%q}`, fixtureAPIToken)
				} else {
					http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "ignored", Path: "/"})
					fmt.Fprint(w, `{"repositories":[{"id":"9007199254740993"}]}`)
				}
			}))
			defer upstream.Close()
			client := mcpTestCredentialSession(t, upstream.URL, version, context.Background(), credential{token: fixtureAPIToken, api: true})
			catalogue, err := client.ListTools(context.Background(), &mcp.ListToolsParams{})
			if err != nil || len(catalogue.Tools) != 21 || reads.Load() != 0 {
				t.Fatal("bearer discovery made an HTTP request")
			}
			for _, tool := range catalogue.Tools {
				if tool.Annotations.ReadOnlyHint || tool.Annotations.IdempotentHint || !strings.Contains(tool.Description, "without login/logout") {
					t.Fatal("bearer tool metadata incorrectly promises session or side-effect semantics")
				}
			}
			for _, args := range []map[string]any{{"token": fixtureAPIToken}, {"api_token": fixtureAPIToken}, {"origin": "https://elsewhere.invalid"}} {
				result, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_repo_list", Arguments: args})
				if err != nil || !result.IsError || reads.Load() != 0 {
					t.Fatal("tool input overrode owner credentials")
				}
			}
			for _, denied := range []bool{false, true} {
				revoked.Store(denied)
				result, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_repo_list", Arguments: map[string]any{}})
				if err != nil || result.IsError != denied || (denied && result.StructuredContent != nil) || strings.Contains(result.Content[0].(*mcp.TextContent).Text, fixtureAPIToken) {
					t.Fatal("MCP bearer result/revocation leaked a credential or stale data")
				}
			}
			for _, name := range []string{"golf_api_credential_create", "golf_api_credential_revoke", "golf_repo_create"} {
				if _, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: map[string]any{}}); err == nil {
					t.Fatal("MCP exposed lifecycle or mutation tooling")
				}
			}
			if reads.Load() != 2 {
				t.Fatal("bearer MCP created extra requests")
			}
		})
	}
}

package cli

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestNativeCredentialModeIsExplicitAndDoesNotBroadenPortableCredentials(t *testing.T) {
	token := "golf_native_" + strings.TrimPrefix(fixtureAPIToken, "golf_ro_")
	if !validNativeToken(token) || validAPIToken(token) || validNativeToken("golf_native_"+strings.Repeat("a", 43)) {
		t.Fatal("credential kind or canonical encoding lost")
	}
	path := filepath.Join(t.TempDir(), "issue.json")
	if err := os.WriteFile(path, []byte(writeBody), 0600); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "http://"+r.Host {
			t.Error("native credential boundary")
		}
		if r.URL.Path != "/rpc/golf.v1.RepositoryService/CreateIssue" {
			t.Error("unexpected native procedure")
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"mutation":{"state":"ISSUE_MUTATION_STATE_SUCCEEDED","idempotencyKey":"12345678-1234-4234-8234-123456789abc"},"issue":{"id":"1","number":1,"title":"Native","state":"ISSUE_STATE_OPEN"}}`)
	}))
	defer upstream.Close()
	var out, diag bytes.Buffer
	code := Run(context.Background(), []string{"--url", upstream.URL, "--native-token-stdin", "issue", "create", "--input", path}, strings.NewReader(token), &out, &diag, func(string) string { return "" })
	if code != 0 || calls.Load() != 1 || !strings.Contains(out.String(), `"ISSUE_MUTATION_STATE_SUCCEEDED"`) || strings.Contains(out.String()+diag.String(), token) {
		t.Fatal("native typed command failed", code, diag.String())
	}
	for _, tc := range []struct {
		args []string
		env  map[string]string
	}{
		{[]string{"issue", "create", "--input", path}, map[string]string{"GOLF_API_TOKEN": token}},
		{[]string{"repo", "list"}, map[string]string{"GOLF_NATIVE_TOKEN": token, "GOLF_GITEA_TOKEN": "private-pat"}},
		{[]string{"repo", "list"}, map[string]string{"GOLF_NATIVE_TOKEN": token, "GOLF_API_TOKEN": fixtureAPIToken}},
		{[]string{"mcp"}, map[string]string{"GOLF_NATIVE_TOKEN": token}},
	} {
		var result, diagnostic bytes.Buffer
		args := append([]string{"--url", upstream.URL}, tc.args...)
		if Run(context.Background(), args, strings.NewReader(""), &result, &diagnostic, func(key string) string { return tc.env[key] }) != 2 || calls.Load() != 1 || strings.Contains(diagnostic.String(), token) {
			t.Fatal("invalid native credential mode dispatched or leaked")
		}
	}
	native := credential{token: token, api: true, native: true}
	if !native.permitsWrite("pr review") || native.permitsWrite("source file") || native.permitsWrite("source ref") || (credential{token: fixtureAPIToken, api: true}).permitsWrite("issue create") {
		t.Fatal("native mode widened portable/source write admission")
	}
}

func TestNativeAccessCredentialsArePairedAndDoNotFollowRedirects(t *testing.T) {
	var leaked atomic.Int32
	foreign := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { leaked.Add(1) }))
	defer foreign.Close()
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("CF-Access-Client-Id") != "test-client-id" || r.Header.Get("CF-Access-Client-Secret") != "test-client-secret" {
			t.Error("Access headers missing")
		}
		http.Redirect(w, r, foreign.URL, http.StatusTemporaryRedirect)
	}))
	defer upstream.Close()
	env := map[string]string{"GOLF_NATIVE_TOKEN": "golf_native_" + strings.TrimPrefix(fixtureAPIToken, "golf_ro_"), "GOLF_ACCESS_CLIENT_ID": "test-client-id", "GOLF_ACCESS_CLIENT_SECRET": "test-client-secret"}
	var out, diag bytes.Buffer
	if Run(context.Background(), []string{"--url", upstream.URL, "repo", "list"}, strings.NewReader(""), &out, &diag, func(k string) string { return env[k] }) != 1 || calls.Load() != 1 || leaked.Load() != 0 || strings.Contains(out.String()+diag.String(), env["GOLF_ACCESS_CLIENT_SECRET"]) {
		t.Fatal("Access redirect boundary lost")
	}
	for _, invalid := range []string{"", "invalid\nheader"} {
		env["GOLF_ACCESS_CLIENT_SECRET"] = invalid
		if Run(context.Background(), []string{"--url", upstream.URL, "repo", "list"}, strings.NewReader(""), &out, &diag, func(k string) string { return env[k] }) != 2 || calls.Load() != 1 {
			t.Fatal("invalid Access credentials dispatched")
		}
	}
	delete(env, "GOLF_NATIVE_TOKEN")
	env["GOLF_API_TOKEN"], env["GOLF_ACCESS_CLIENT_SECRET"] = fixtureAPIToken, "test-client-secret"
	if Run(context.Background(), []string{"--url", upstream.URL, "repo", "list"}, strings.NewReader(""), &out, &diag, func(k string) string { return env[k] }) != 2 || calls.Load() != 1 {
		t.Fatal("Access credentials broadened portable mode")
	}
}

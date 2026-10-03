package codexaccount

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestNativeFixture is a bounded stdio child, never a provider connection.
func TestNativeFixture(t *testing.T) {
	fixture := false
	slow := false
	bad := false
	for _, arg := range os.Args {
		fixture = fixture || arg == "--codex-account-fixture"
		slow = slow || arg == "--fixture-slow"
		bad = bad || arg == "--fixture-bad"
	}
	if !fixture {
		return
	}
	if os.Getenv("CODEX_HOME") == "" || os.Getenv("HOME") != os.Getenv("CODEX_HOME") {
		os.Exit(5)
	}
	encoder := json.NewEncoder(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID     uint64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(6)
		}
		if request.ID == 0 {
			continue
		}
		if slow && request.Method == "account/read" {
			time.Sleep(5 * time.Second)
		}
		if bad && request.Method == "account/read" {
			fmt.Println(strings.Repeat("x", maxAuth*5))
			continue
		}
		result := any(map[string]any{})
		switch request.Method {
		case "initialize":
			result = map[string]string{"userAgent": "fixture"}
		case "account/read":
			var params struct {
				Refresh bool `json:"refreshToken"`
			}
			json.Unmarshal(request.Params, &params)
			if params.Refresh {
				os.WriteFile(filepath.Join(os.Getenv("CODEX_HOME"), "auth.json"), []byte(`{"tokens":{"access_token":"refreshed-private"}}`), 0600)
			}
			result = map[string]any{"account": map[string]string{"type": "chatgpt", "email": "user@example.invalid", "planType": "pro"}, "requiresOpenaiAuth": true}
		case "account/login/start":
			var params struct {
				Type   string `json:"type"`
				APIKey string `json:"apiKey"`
			}
			json.Unmarshal(request.Params, &params)
			if params.Type == "apiKey" {
				os.WriteFile(filepath.Join(os.Getenv("CODEX_HOME"), "auth.json"), []byte(`{"OPENAI_API_KEY":"private-api-fixture"}`), 0600)
				encoder.Encode(map[string]any{"method": "account/login/completed", "params": map[string]any{"loginId": nil, "success": true, "error": nil}})
				result = map[string]string{"type": "apiKey"}
			} else {
				result = map[string]string{"type": "chatgptDeviceCode", "loginId": "login_fixture-1", "verificationUrl": verificationURL, "userCode": "ABCD-1234"}
			}
		case "account/login/cancel":
			encoder.Encode(map[string]any{"method": "account/login/completed", "params": map[string]any{"loginId": "login_fixture-1", "success": false, "error": "private provider details"}})
		case "account/logout":
			os.Remove(filepath.Join(os.Getenv("CODEX_HOME"), "auth.json"))
		default:
			os.Exit(7)
		}
		encoder.Encode(map[string]any{"id": request.ID, "result": result})
	}
	os.Exit(0)
}

func newFixture(t *testing.T, extra ...string) *Process {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args := append([]string{"-test.run=^TestNativeFixture$", "--", "--codex-account-fixture"}, extra...)
	p, err := New(context.Background(), Config{Binary: binary, Args: args, Timeout: time.Second}, []byte(`{"tokens":{"access_token":"initial-private"}}`))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	return p
}
func nextEvent(t *testing.T, p *Process) LoginCompleted {
	t.Helper()
	select {
	case event := <-p.Events():
		return event
	case <-time.After(time.Second):
		t.Fatal("Missing login event")
		return LoginCompleted{}
	}
}
func TestAccountLifecycleAndSnapshot(t *testing.T) {
	p := newFixture(t)
	ctx := context.Background()
	account, err := p.Account(ctx, false)
	if err != nil || account.Type != "chatgpt" || account.Email != "user@example.invalid" || account.PlanType != "pro" || !account.RequiresOpenAIAuth {
		t.Fatal("Sanitized account mismatch")
	}
	before, err := p.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.Account(ctx, true); err != nil {
		t.Fatal(err)
	}
	after, err := p.Snapshot()
	if err != nil || string(after) == string(before) {
		t.Fatal("Refreshed snapshot not preserved")
	}
	login, err := p.StartLogin(ctx, LoginRequest{Type: "chatgptDeviceCode"})
	if err != nil || login.LoginID != "login_fixture-1" || login.VerificationURL != verificationURL || login.UserCode != "ABCD-1234" || time.Until(login.ExpiresAt) < 14*time.Minute {
		t.Fatal("Device challenge mismatch")
	}
	if err = p.CancelLogin(ctx, login.LoginID); err != nil {
		t.Fatal(err)
	}
	event := nextEvent(t, p)
	if event.Success || event.LoginID != login.LoginID {
		t.Fatal("Cancellation event mismatch")
	}
	if _, err = p.StartLogin(ctx, LoginRequest{Type: "apiKey", APIKey: "sk-invalid-fixture-aaaaaaaaaaaaaaaaaaaaaaaa"}); err != nil {
		t.Fatal(err)
	}
	event = nextEvent(t, p)
	if !event.Success || event.LoginID != "" {
		t.Fatal("API login event mismatch")
	}
	if err = p.Logout(ctx); err != nil {
		t.Fatal(err)
	}
	after, err = p.Snapshot()
	if err != nil || after != nil {
		t.Fatal("Logout snapshot survived")
	}
	home := p.home
	p.Close()
	p.Close()
	if _, err = os.Stat(home); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Private home survived close")
	}
	if _, err = p.Account(ctx, false); !errors.Is(err, ErrUnavailable) {
		t.Fatal("Closed process accepted request")
	}
}
func TestTransportAndCredentialBoundaries(t *testing.T) {
	p := newFixture(t)
	if _, err := p.StartLogin(context.Background(), LoginRequest{Type: "chatgpt"}); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("Unsupported flow accepted")
	}
	if _, err := p.StartLogin(context.Background(), LoginRequest{Type: "apiKey", APIKey: "short"}); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("Invalid key accepted")
	}
	auth := filepath.Join(p.home, "auth.json")
	os.Remove(auth)
	os.Symlink("/etc/passwd", auth)
	if _, err := p.Snapshot(); !errors.Is(err, ErrUnavailable) {
		t.Fatal("Symlink snapshot accepted")
	}
	os.Remove(auth)
	os.WriteFile(auth, []byte(`{}`), 0644)
	if _, err := p.Snapshot(); !errors.Is(err, ErrUnavailable) {
		t.Fatal("Public snapshot accepted")
	}
	os.Chmod(auth, 0600)
	os.WriteFile(auth, []byte("not json"), 0600)
	if _, err := p.Snapshot(); !errors.Is(err, ErrUnavailable) {
		t.Fatal("Malformed snapshot accepted")
	}
	for _, mode := range []string{"--fixture-slow", "--fixture-bad"} {
		child := newFixture(t, mode)
		start := time.Now()
		if _, err := child.Account(context.Background(), false); !errors.Is(err, ErrUnavailable) {
			t.Fatal("Invalid transport accepted")
		}
		child.Close()
		if time.Since(start) > 3*time.Second {
			t.Fatal("Unbounded transport deadline")
		}
	}
	if _, err := New(context.Background(), Config{Binary: "relative"}, nil); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("Relative binary accepted")
	}
	if _, err := New(context.Background(), Config{Binary: "/bin/true"}, []byte("bad")); !errors.Is(err, ErrInvalidCredential) {
		t.Fatal("Invalid cache accepted")
	}
}

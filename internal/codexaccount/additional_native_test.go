package codexaccount

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func nativeFixture(t *testing.T) string {
	t.Helper()
	python, e := exec.LookPath("python3")
	if e != nil {
		t.Skip("python3 fixture required")
	}
	path := filepath.Join(t.TempDir(), "native")
	source := `#!` + python + `
import os,sys,json
root=os.environ['CLAUDE_CONFIG_DIR']
if 'auth' not in sys.argv:sys.exit(2)
if sys.argv[-1]=='list':
 data=json.load(open(os.environ['XDG_DATA_HOME']+'/opencode/auth.json'))
 assert len(data)==1 and next(iter(data.values()))['type']=='api'
 print('configured');sys.exit(0)
if sys.argv[-1]=='status':
 if os.environ.get('ANTHROPIC_API_KEY'):
  print(json.dumps({'loggedIn':True,'authMethod':'api_key'}));sys.exit(0)
 try:data=json.load(open(root+'/.credentials.json'))
 except FileNotFoundError:sys.exit(1)
 print(json.dumps({'loggedIn':True,'authMethod':'claude.ai','email':'fixture@example.test','subscriptionType':'fixture-plan'}));sys.exit(0)
if 'login' in sys.argv:
 print('https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=fixture',flush=True)
 code=sys.stdin.readline().strip()
 if code!='fixture-code':sys.exit(1)
 os.makedirs(root,exist_ok=True)
 fd=os.open(root+'/.credentials.json',os.O_WRONLY|os.O_CREAT,0o600)
 with os.fdopen(fd,'w') as f:json.dump({'claudeAiOauth':{'fixture':True}},f)
 sys.exit(0)
sys.exit(2)
`
	if e = os.WriteFile(path, []byte(source), 0700); e != nil {
		t.Fatal(e)
	}
	return path
}
func TestNativeAccountIsolationAndRestore(t *testing.T) {
	ctx := context.Background()
	binary := nativeFixture(t)
	for _, harness := range []string{"claude-code", "opencode"} {
		p, e := NewNative(binary, harness, "anthropic", nil)
		if e != nil {
			t.Fatal(e)
		}
		key := "fixture-key-not-a-provider-key"
		if _, e = p.StartLogin(ctx, LoginRequest{Type: "apiKey", APIKey: key}); e != nil {
			t.Fatal(e)
		}
		if account, e := p.Account(ctx, true); e != nil || account.Type != "apiKey" {
			t.Fatal("native configuration not read", e)
		}
		snapshot, e := p.Snapshot()
		if e != nil {
			t.Fatal(e)
		}
		home := p.home
		p.Close()
		if _, e = os.Stat(home); !os.IsNotExist(e) {
			t.Fatal("private home retained")
		}
		restored, e := NewNative(binary, harness, "anthropic", snapshot)
		if e != nil {
			t.Fatal(e)
		}
		if account, e := restored.Account(ctx, true); e != nil || account.Type != "apiKey" {
			t.Fatal("restoration failed", e)
		}
		restored.Logout(ctx)
		if snapshot, e = restored.Snapshot(); e != nil || len(snapshot) != 0 {
			t.Fatal("disconnect retained credential")
		}
		restored.Close()
	}
	p, e := NewNative(binary, "claude-code", "anthropic", nil)
	if e != nil {
		t.Fatal(e)
	}
	defer p.Close()
	login, e := p.StartLogin(ctx, LoginRequest{Type: "browserCode"})
	if e != nil || login.LoginID == "" || login.UserCode != "" {
		t.Fatal("native browser login not issued", e)
	}
	if e = p.CompleteLogin(ctx, login.LoginID, "fixture-code"); e != nil {
		t.Fatal(e)
	}
	select {
	case event := <-p.Events():
		if !event.Success || event.LoginID != login.LoginID {
			t.Fatal("wrong terminal login evidence")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("missing login completion")
	}
	if account, e := p.Account(ctx, true); e != nil || account.Type != "claude" || account.Email != "fixture@example.test" {
		t.Fatal("provider identity not read", e)
	}
	snapshot, e := p.Snapshot()
	if e != nil {
		t.Fatal(e)
	}
	restored, e := NewNative(binary, "claude-code", "anthropic", snapshot)
	if e != nil {
		t.Fatal(e)
	}
	defer restored.Close()
	if account, e := restored.Account(ctx, true); e != nil || account.Email != "fixture@example.test" {
		t.Fatal("OAuth restoration failed", e)
	}
	bad, _ := json.Marshal(nativeCache{Files: map[string]json.RawMessage{"../../outside": json.RawMessage(`{}`)}})
	if _, e = NewNative(binary, "claude-code", "anthropic", bad); e == nil {
		t.Fatal("unbounded cache path accepted")
	}
}

// Opt-in packaged CLI qualification: isolated homes, invalid keys, no inference.
func TestPinnedAdditionalNativeAccounts(t *testing.T) {
	ctx := context.Background()
	for _, entry := range []struct{ harness, env, provider, version string }{{"claude-code", "GOLF_TEST_CLAUDE_BINARY", "anthropic", "2.1.288"}, {"opencode", "GOLF_TEST_OPENCODE_BINARY", "opencode", "1.18.34"}} {
		binary := os.Getenv(entry.env)
		if binary == "" {
			t.Skip("explicit native binaries required")
		}
		p, e := NewNative(binary, entry.harness, entry.provider, nil)
		if e != nil {
			t.Fatal(e)
		}
		defer p.Close()
		output, e := p.output(ctx, "--version")
		if e != nil || !strings.Contains(string(output), entry.version) {
			t.Fatal("native version mismatch", entry.harness, e)
		}
		if _, e = p.StartLogin(ctx, LoginRequest{Type: "apiKey", APIKey: "fixture-not-real-provider-credential"}); e != nil {
			t.Fatal(e)
		}
		account, e := p.Account(ctx, true)
		if e != nil || account.Type != "apiKey" {
			t.Fatal("native cached configuration not reported", entry.harness, e)
		}
		snapshot, e := p.Snapshot()
		if e != nil {
			t.Fatal("private snapshot failed", entry.harness, e)
		}
		p.Close()
		restored, e := NewNative(binary, entry.harness, entry.provider, snapshot)
		if e != nil {
			t.Fatal(e)
		}
		if account, e = restored.Account(ctx, true); e != nil || account.Type != "apiKey" {
			t.Fatal("native restoration failed", e)
		}
		restored.Logout(ctx)
		restored.Close()
	}
}

func TestPinnedClaudeBrowserIssueCancel(t *testing.T) {
	if os.Getenv("GOLF_TEST_NATIVE_BROWSER") != "1" {
		t.Skip("explicit native browser challenge qualification required")
	}
	p, e := NewNative(os.Getenv("GOLF_TEST_CLAUDE_BINARY"), "claude-code", "anthropic", nil)
	if e != nil {
		t.Fatal(e)
	}
	defer p.Close()
	login, e := p.StartLogin(context.Background(), LoginRequest{Type: "browserCode"})
	if e != nil || login.LoginID == "" || !strings.HasPrefix(login.VerificationURL, "https://claude.com/cai/oauth/authorize?") && !strings.HasPrefix(login.VerificationURL, "https://claude.ai/oauth/authorize?") {
		t.Fatal("native Claude authorization URL not issued", e)
	}
	if _, e = p.Snapshot(); e != nil {
		t.Fatal("native pending state cannot be captured privately", e)
	}
	if e = p.CancelLogin(context.Background(), login.LoginID); e != nil {
		t.Fatal("native browser cancellation failed", e)
	}
	p.Close()
	if _, e = os.Stat(p.home); !os.IsNotExist(e) {
		t.Fatal("private browser state survived close")
	}
}

package server

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func agentNativeFixture(t *testing.T) string {
	t.Helper()
	python, e := exec.LookPath("python3")
	if e != nil {
		t.Skip("python3 required")
	}
	path := filepath.Join(t.TempDir(), "agent")
	script := `#!` + python + `
import os,sys,json
if sys.argv[-1]=='list':
 json.load(open(os.environ['XDG_DATA_HOME']+'/opencode/auth.json'));print('configured');sys.exit(0)
if sys.argv[-1]=='status':
 if os.environ.get('ANTHROPIC_API_KEY'):print(json.dumps({'loggedIn':True,'authMethod':'api_key'}));sys.exit(0)
 try:json.load(open(os.environ['CLAUDE_CONFIG_DIR']+'/.credentials.json'))
 except FileNotFoundError:sys.exit(1)
 print(json.dumps({'loggedIn':True,'authMethod':'claude.ai','email':'agent@example.test','subscriptionType':'fixture-plan'}));sys.exit(0)
if 'login' in sys.argv:
 print('https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=fixture',flush=True)
 if sys.stdin.readline().strip()!='fixture-code':sys.exit(1)
 root=os.environ['CLAUDE_CONFIG_DIR'];os.makedirs(root,exist_ok=True)
 fd=os.open(root+'/.credentials.json',os.O_WRONLY|os.O_CREAT,0o600)
 with os.fdopen(fd,'w') as f:json.dump({'native_fixture':True},f)
 sys.exit(0)
sys.exit(2)
`
	if e = os.WriteFile(path, []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	return path
}
func TestAgentHarnessConnectionsPostgres(t *testing.T) {
	f, owner, _ := codexFixtureRole(t, true)
	binary := agentNativeFixture(t)
	f.s.config.ClaudeBinary = binary
	f.s.config.OpenCodeBinary = binary
	enrollLocal(t, f, "bob", false)
	bob := localLogin(t, f, "bob")
	key := "fixture-agent-key-no-provider-value"
	ids := map[string]bool{}
	for _, pair := range [][2]string{{"claude-code", "anthropic"}, {"opencode", "opencode"}, {"opencode", "openai"}, {"opencode", "anthropic"}} {
		body, _ := json.Marshal(map[string]any{"harness": pair[0], "provider": pair[1], "method": "CODEX_LOGIN_METHOD_API_KEY", "apiKey": key, "expectedVersion": "0"})
		current := codexResponse(t, codexCall(f.s, owner, "StartCodexLogin", string(body)))
		id := current["id"].(string)
		if ids[id] || current["harness"] != pair[0] || current["provider"] != pair[1] || current["state"] != "CODEX_CONNECTION_STATE_CONNECTED" {
			t.Fatal("agent/provider identity collapsed")
		}
		ids[id] = true
		if strings.Contains(string(mustJSON(current)), key) {
			t.Fatal("secret escaped response")
		}
		if w := codexCall(f.s, bob, "GetCodexConnection", `{"connectionId":"`+id+`"}`); w.Code != 404 {
			t.Fatal("foreign agent disclosed", w.Code)
		}
		f.s.CloseCodexAccounts()
		current = codexResponse(t, codexCall(f.s, owner, "RefreshCodexConnection", `{"connectionId":"`+id+`","expectedVersion":"`+current["version"].(string)+`"}`))
		if current["state"] != "CODEX_CONNECTION_STATE_CONNECTED" {
			t.Fatal("encrypted native cache lost")
		}
		if _, e := f.db.Exec(`UPDATE golf_codex_connections SET harness='codex',provider='openai' WHERE id=$1`, id); e == nil {
			t.Fatal("immutable harness changed")
		}
	}
	if w := codexCall(f.s, owner, "StartCodexLogin", `{"harness":"claude-code","provider":"openai","method":"CODEX_LOGIN_METHOD_API_KEY","apiKey":"`+key+`","expectedVersion":"0"}`); w.Code != 400 {
		t.Fatal("unsupported pair accepted")
	}
	if row := codexResponse(t, codexCall(f.s, owner, "GetCodexConnection", `{}`)); row["state"] != "CODEX_CONNECTION_STATE_UNCONFIGURED" {
		t.Fatal("new harness changed Codex")
	}
	if list := sharedCodexList(t, f, owner, false); len(list) != 5 {
		t.Fatal("personal harness inventory omitted", len(list))
	}
	if list := sharedCodexList(t, f, bob, false); len(list) != 1 {
		t.Fatal("foreign harness inventory disclosed")
	}
}
func mustJSON(v any) []byte { data, _ := json.Marshal(v); return data }

func TestAgentNativeBrowserCompletionPostgres(t *testing.T) {
	f, owner, _ := codexFixture(t)
	f.s.config.ClaudeBinary = agentNativeFixture(t)
	row := codexResponse(t, codexCall(f.s, owner, "StartCodexLogin", `{"harness":"claude-code","provider":"anthropic","method":"CODEX_LOGIN_METHOD_BROWSER_CODE","expectedVersion":"0"}`))
	if row["state"] != "CODEX_CONNECTION_STATE_AWAITING_AUTH" || row["userCode"] != nil && row["userCode"] != "" {
		t.Fatal("native code login invented a device code")
	}
	id, version, login := row["id"].(string), row["version"].(string), row["loginId"].(string)
	body, _ := json.Marshal(map[string]any{"connectionId": id, "expectedVersion": version, "loginId": login, "authorizationCode": "fixture-code"})
	enrollLocal(t, f, "bob", false)
	bob := localLogin(t, f, "bob")
	if w := codexCall(f.s, bob, "CompleteAgentLogin", string(body)); w.Code != 404 {
		t.Fatal("foreign native login completion accepted", w.Code)
	}
	receipt := codexResponse(t, codexCall(f.s, owner, "CompleteAgentLogin", string(body)))
	if strings.Contains(string(mustJSON(receipt)), "fixture-code") {
		t.Fatal("authorization code echoed")
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		row = codexResponse(t, codexCall(f.s, owner, "GetCodexConnection", `{"connectionId":"`+id+`"}`))
		if row["state"] == "CODEX_CONNECTION_STATE_CONNECTED" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if row["email"] != "agent@example.test" || row["planType"] != "fixture-plan" {
		t.Fatal("native completion was not authenticated and saved")
	}
	f.s.CloseCodexAccounts()
	row = codexResponse(t, codexCall(f.s, owner, "RefreshCodexConnection", `{"connectionId":"`+id+`","expectedVersion":"`+row["version"].(string)+`"}`))
	if row["email"] != "agent@example.test" {
		t.Fatal("native browser credential was not restored")
	}
}

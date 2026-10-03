package server

import (
	"encoding/json"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func usageCall(s *Server, cookie loginResult, method, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/rpc/golf.v1.AgentUsageService/"+method, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	r.Header.Set("Origin", s.config.PublicURL)
	r.AddCookie(&http.Cookie{Name: cookieName, Value: cookie.Value})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func usageRead(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("usage failed %d: %s", w.Code, w.Body)
	}
	var r map[string]any
	if json.Unmarshal(w.Body.Bytes(), &r) != nil {
		t.Fatal("invalid response")
	}
	return r["settings"].(map[string]any)
}
func TestAgentUsageCeilings(t *testing.T) {
	c := agentDefaults()
	c.Enabled = true
	c.AllowAllModels = true
	c.Triggers = []string{"manual", "push"}
	c.AllowTaskOverrides = true
	e := proto.Clone(c).(*golfv1.AgentUsageConfig)
	p := proto.Clone(c).(*golfv1.AgentUsageConfig)
	p.TimeoutSeconds = 60
	p.TokenBudget = 1000
	p.SpendLimitCents = 0
	p.MaxConcurrent = 1
	p.Triggers = []string{"manual"}
	p.AllowTaskOverrides = false
	agentIntersect(e, p, "model")
	if !e.Enabled || e.TimeoutSeconds != 60 || e.TokenBudget != 1000 || e.SpendLimitCents != 0 || e.AllowTaskOverrides || len(e.Triggers) != 1 {
		t.Fatal("ceiling broadened")
	}
	p.AllowAllModels = false
	p.AllowedModels = []string{"other"}
	agentIntersect(e, p, "model")
	if e.Enabled {
		t.Fatal("model ceiling ignored")
	}
	if agentConfigValid(c) != nil {
		t.Fatal("valid config rejected")
	}
	c.Triggers = []string{"push", "push"}
	if agentConfigValid(c) == nil {
		t.Fatal("duplicate triggers accepted")
	}
}
func TestAgentUsagePostgres(t *testing.T) {
	f, admin, _ := codexFixtureRole(t, true)
	enrollLocal(t, f, "bob", false)
	bob := localLogin(t, f, "bob")
	if w := usageCall(f.s, bob, "GetAgentUsage", `{"scope":"AGENT_USAGE_SCOPE_INSTANCE"}`); w.Code == 200 {
		t.Fatal("ordinary user read admin settings")
	}
	original := usageRead(t, usageCall(f.s, admin, "GetAgentUsage", `{"scope":"AGENT_USAGE_SCOPE_PERSONAL"}`))
	if original["revision"] != "0" {
		t.Fatal("unexpected revision")
	}
	cfg := map[string]any{"enabled": true, "allowAllModels": true, "timeoutSeconds": 60, "tokenBudget": 1000, "spendLimitCents": 0, "maxConcurrent": 1, "triggers": []string{"manual"}, "instructions": "private fixture instructions"}
	body := map[string]any{"scope": "AGENT_USAGE_SCOPE_PERSONAL", "scopeId": original["scopeId"], "expectedRevision": "0", "expectedAuthorityRevision": original["authorityRevision"], "config": cfg}
	raw, _ := json.Marshal(body)
	saved := usageRead(t, usageCall(f.s, admin, "SaveAgentUsage", string(raw)))
	if saved["revision"] != "1" || saved["executionAvailable"] == true {
		t.Fatal("save claimed execution")
	}
	if w := usageCall(f.s, admin, "SaveAgentUsage", string(raw)); w.Code == 200 {
		t.Fatal("stale save accepted")
	}
	foreign := usageRead(t, usageCall(f.s, bob, "GetAgentUsage", `{"scope":"AGENT_USAGE_SCOPE_PERSONAL"}`))
	if strings.Contains(string(mustJSON(foreign)), "private fixture") {
		t.Fatal("personal instructions leaked")
	}
	body["scopeId"] = foreign["scopeId"]
	raw, _ = json.Marshal(body)
	if w := usageCall(f.s, admin, "SaveAgentUsage", string(raw)); w.Code == 200 {
		t.Fatal("foreign scope accepted")
	}
	inst := usageRead(t, usageCall(f.s, admin, "GetAgentUsage", `{"scope":"AGENT_USAGE_SCOPE_INSTANCE"}`))
	body["scope"] = "AGENT_USAGE_SCOPE_INSTANCE"
	body["scopeId"] = inst["scopeId"]
	body["expectedAuthorityRevision"] = inst["authorityRevision"]
	raw, _ = json.Marshal(body)
	if w := usageCall(f.s, bob, "SaveAgentUsage", string(raw)); w.Code == 200 {
		t.Fatal("ordinary user changed ceiling")
	}
	usageRead(t, usageCall(f.s, admin, "SaveAgentUsage", string(raw)))
	mine := usageRead(t, usageCall(f.s, admin, "GetAgentUsage", `{"scope":"AGENT_USAGE_SCOPE_PERSONAL"}`))
	eff := mine["effective"].(map[string]any)
	if eff["timeoutSeconds"] != float64(60) || eff["enabled"] == true {
		t.Fatal("default did not retain denial without account")
	}
	var n int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_agent_usage_events`).Scan(&n); e != nil || n != 2 {
		t.Fatal("events missing", n, e)
	}
}

func TestAgentUsageModelCatalogPostgres(t *testing.T) {
	f, admin, _ := codexFixtureRole(t, true)
	f.s.config.ClaudeBinary = agentNativeFixture(t)
	row := codexResponse(t, codexCall(f.s, admin, "StartCodexLogin", `{"harness":"claude-code","provider":"anthropic","method":"CODEX_LOGIN_METHOD_API_KEY","apiKey":"invalid-fixture-native-model-key","expectedVersion":"0"}`))
	id := row["id"].(string)
	w := usageCall(f.s, admin, "ListAgentModels", `{"connectionId":"`+id+`","refresh":true}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "documented Claude alias") || strings.Contains(w.Body.String(), "invalid-fixture") {
		t.Fatal("safe native catalog missing", w.Code)
	}
	original := usageRead(t, usageCall(f.s, admin, "GetAgentUsage", `{"scope":"AGENT_USAGE_SCOPE_PERSONAL"}`))
	cfg := map[string]any{"enabled": true, "connectionId": id, "modelId": "opus", "reasoning": "high", "allowAllModels": true, "timeoutSeconds": 600, "tokenBudget": 64000, "spendLimitCents": 1000, "maxConcurrent": 2, "triggers": []string{"manual", "push"}, "allowTaskOverrides": true}
	body := map[string]any{"scope": "AGENT_USAGE_SCOPE_PERSONAL", "scopeId": original["scopeId"], "expectedRevision": "0", "expectedAuthorityRevision": original["authorityRevision"], "config": cfg}
	raw, _ := json.Marshal(body)
	usageRead(t, usageCall(f.s, admin, "SaveAgentUsage", string(raw)))
	inst := usageRead(t, usageCall(f.s, admin, "GetAgentUsage", `{"scope":"AGENT_USAGE_SCOPE_INSTANCE"}`))
	delete(cfg, "connectionId")
	delete(cfg, "modelId")
	delete(cfg, "reasoning")
	cfg["timeoutSeconds"] = 60
	cfg["spendLimitCents"] = 0
	cfg["triggers"] = []string{"manual"}
	body["scope"] = "AGENT_USAGE_SCOPE_INSTANCE"
	body["scopeId"] = inst["scopeId"]
	body["expectedAuthorityRevision"] = inst["authorityRevision"]
	raw, _ = json.Marshal(body)
	usageRead(t, usageCall(f.s, admin, "SaveAgentUsage", string(raw)))
	w = usageCall(f.s, admin, "PreviewAgentTask", `{"scope":"AGENT_USAGE_SCOPE_PERSONAL","selection":{"connectionId":"`+id+`","modelId":"opus","reasoning":"high","trigger":"push","timeoutSeconds":7200,"spendLimitCents":5000}}`)
	if w.Code != 200 {
		t.Fatal("preview failed", w.Code, w.Body)
	}
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	v := result["settings"].(map[string]any)
	eff := v["effective"].(map[string]any)
	if eff["enabled"] == true || eff["timeoutSeconds"] != float64(60) || eff["spendLimitCents"] != nil && eff["spendLimitCents"] != float64(0) || v["executionAvailable"] == true {
		t.Fatal("task preview bypassed ceilings")
	}
	if w = usageCall(f.s, admin, "PreviewAgentTask", `{"scope":"AGENT_USAGE_SCOPE_PERSONAL","selection":{"connectionId":"`+id+`","modelId":"unadvertised"}}`); w.Code == 200 {
		t.Fatal("invented model accepted")
	}
}

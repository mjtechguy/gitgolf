package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestAgentTaskBoundaries(t *testing.T) {
	s, e := New(testConfig("http://native.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, method := range []string{"CreateAgentTask", "ListAgentTasks", "GetAgentTask", "CancelAgentTask"} {
		for _, origin := range []string{s.config.PublicURL, "https://foreign.invalid"} {
			r := httptest.NewRequest("POST", "/rpc/golf.v1.AgentTaskService/"+method, strings.NewReader("{}"))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", origin)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want {
				t.Fatalf("%s authority boundary %d", method, w.Code)
			}
		}
	}
	if !agentContainsCredential("accidental private-credential-long-secret", []byte(`{"tokens":{"access":"private-credential-long-secret"}}`)) || agentContainsCredential("safe proposal", []byte(`{"tokens":{"access":"private-credential-long-secret"}}`)) {
		t.Fatal("credential echo boundary failed")
	}
}
func TestAgentTaskPostgres(t *testing.T) {
	f, login, _ := codexFixtureRole(t, true)
	var user int64
	if e := f.db.QueryRow(`SELECT user_id FROM golf_local_accounts WHERE username='alice'`).Scan(&user); e != nil {
		t.Fatal(e)
	}
	connection := uuid.NewString()
	task := uuid.NewString()
	c := []byte(`{"model_id":"model","timeout_seconds":60,"token_budget":1000,"max_concurrent":1}`)
	_, e := f.db.Exec(`INSERT INTO golf_codex_connections(id,user_id,state,forge_url,harness,provider,name) VALUES($1,$2,'CONNECTED',$3,'codex','openai','fixture')`, connection, user, f.s.config.GiteaURL)
	if e != nil {
		t.Fatal(e)
	}
	hash, _ := sessionHash(login.Value)
	_, e = f.db.Exec(`INSERT INTO golf_agent_tasks(id,forge_url,repository_id,owner_id,repository_owner,repository_name,user_id,native_user_id,session_hash,connection_id,connection_version,commit_id,source_archive,config,policy_fingerprint,idempotency_key,input_hash) VALUES($1,$2,11,42,'alice','example',$3,42,$4,$5,1,$6,$7,$8,'f',$9,$10)`, task, f.s.config.GiteaURL, user, hash, connection, strings.Repeat("a", 40), []byte{}, c, uuid.NewString(), bytes.Repeat([]byte{7}, 32))
	if e != nil {
		t.Fatal(e)
	}
	row, e := f.s.taskRecord(context.Background(), task)
	if e != nil || !row.wire(false).CanCancel || row.wire(false).ModelId != "model" {
		t.Fatal("durable task record failed", e)
	}
	if e = f.s.taskAccess(context.Background(), codexActor{UserID: user + 1}, row); e == nil {
		t.Fatal("foreign owner saw task")
	}
	var cfg map[string]any
	if json.Unmarshal(row.RawConfig, &cfg) != nil {
		t.Fatal("config invalid")
	}
	// Lost attempts stay terminal and cannot be silently replayed.
	f.s.finishAgentFailure(context.Background(), task, "", "failure")
	row, _ = f.s.taskRecord(context.Background(), task)
	if row.State != "queued" {
		t.Fatal("queued task incorrectly finalized")
	}
	_, e = f.db.Exec(`UPDATE golf_agent_tasks SET state='running',attempt_id='owned',lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, task)
	if e != nil {
		t.Fatal(e)
	}
	f.s.finishAgentFailure(context.Background(), task, "foreign", "failure")
	row, _ = f.s.taskRecord(context.Background(), task)
	if row.State != "running" {
		t.Fatal("foreign attempt finalized task")
	}
	f.s.finishAgentFailure(context.Background(), task, "owned", "failure")
	row, _ = f.s.taskRecord(context.Background(), task)
	if row.State != "lost" || row.wire(true).CanCancel {
		t.Fatal("lost task stayed executable")
	}
}

func TestAgentTaskAdmissionPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.server.config.GiteaOAuthClientID = "fixture"
	var e error
	f.session, e = f.server.createSession(t.Context(), f.user, "oauth", encodeOAuth(oauthEnvelope{Version: 1, AccessToken: "run-fixture", RefreshToken: "fixture-refresh", Expiry: time.Now().Add(time.Hour), Verified: true}), "")
	if e != nil {
		t.Fatal(e)
	}
	f.server.config.AgentImage = "sha256:" + strings.Repeat("b", 64)
	var user int64
	if e = f.server.db.QueryRow(`SELECT id FROM golf_users WHERE forge_url=$1 AND forge_user_id=42`, f.server.config.GiteaURL).Scan(&user); e != nil {
		t.Fatal(e)
	}
	connection := uuid.NewString()
	_, e = f.server.db.Exec(`INSERT INTO golf_codex_connections(id,user_id,state,auth_method,forge_url,harness,provider,name) VALUES($1,$2,'CONNECTED','chatgptDeviceCode',$3,'codex','openai','fixture')`, connection, user, f.server.config.GiteaURL)
	if e != nil {
		t.Fatal(e)
	}
	_, e = f.server.db.Exec(`INSERT INTO golf_agent_model_catalogs(connection_id,connection_version,models) VALUES($1,1,$2)`, connection, []byte(`[{"id":"model","name":"model","reasoning":["high"]}]`))
	if e != nil {
		t.Fatal(e)
	}
	config := map[string]any{"enabled": true, "allow_all_models": true, "triggers": []string{"manual"}, "allow_task_overrides": true, "timeout_seconds": 60, "token_budget": 1000, "spend_limit_cents": 0, "max_concurrent": 1}
	raw, _ := json.Marshal(config)
	for _, v := range []struct {
		scope, id string
		owner     int64
	}{{"instance", "instance", 0}, {"repository", strconv.FormatInt(f.row.ID, 10), 42}, {"personal", strconv.FormatInt(user, 10), user}} {
		_, e = f.server.db.Exec(`INSERT INTO golf_agent_usage_settings(forge_url,scope,scope_id,owner_id,config,revision) VALUES($1,$2,$3,$4,$5,1)`, f.server.config.GiteaURL, v.scope, v.id, v.owner, raw)
		if e != nil {
			t.Fatal(e)
		}
	}
	_, e = f.server.db.Exec(`INSERT INTO golf_agent_worker_presence(forge_url,worker_id,image) VALUES($1,'fixture',$2)`, f.server.config.GiteaURL, f.server.config.AgentImage)
	if e != nil {
		t.Fatal(e)
	}
	call := func(method string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest("POST", "/rpc/golf.v1.AgentTaskService/"+method, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Connect-Protocol-Version", "1")
		r.Header.Set("Origin", f.server.config.PublicURL)
		r.AddCookie(&http.Cookie{Name: cookieName, Value: f.session.Value})
		w := httptest.NewRecorder()
		f.server.ServeHTTP(w, r)
		return w
	}
	ctx := f.context(t)
	token, _ := rpcToken(ctx)
	actor := codexActor{UserID: user, NativeID: 42, Credential: token}
	actor.Hash, _ = sessionHash(f.session.Value)
	auth, e := f.server.agentAuthority(ctx, actor, golfv1.AgentUsageScope_AGENT_USAGE_SCOPE_REPOSITORY, "", &golfv1.RepositoryKey{Owner: "alice", Name: "example"})
	if e != nil {
		t.Fatal(e)
	}
	body := map[string]any{"repository": map[string]string{"owner": "alice", "name": "example"}, "ref": "main", "instructions": "Update README", "expectedRevision": "1", "expectedAuthorityRevision": auth.Revision, "expectedConnectionVersion": "1", "idempotencyKey": uuid.NewString(), "selection": map[string]string{"connectionId": connection, "modelId": "model", "reasoning": "high", "trigger": "manual"}}
	w := call("CreateAgentTask", body)
	if w.Code != 200 {
		t.Fatalf("Task admission failed %d %s", w.Code, w.Body)
	}
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	task := result["task"].(map[string]any)
	id := task["id"].(string)
	if task["state"] != "queued" || task["modelId"] != "model" {
		t.Fatal("Invalid queue receipt")
	}
	w = call("CreateAgentTask", body)
	if w.Code != 200 {
		t.Fatal("Idempotent request failed", w.Code, w.Body)
	}
	var count int
	f.server.db.QueryRow(`SELECT count(*) FROM golf_agent_tasks`).Scan(&count)
	if count != 1 {
		t.Fatal("Duplicate task admitted")
	}
	w = call("ListAgentTasks", map[string]any{"repository": body["repository"]})
	if w.Code != 200 || !strings.Contains(w.Body.String(), id) {
		t.Fatal("Task inventory failed", w.Code, w.Body)
	}
	w = call("CancelAgentTask", map[string]string{"taskId": id, "expectedVersion": "1"})
	if w.Code != 200 || !strings.Contains(w.Body.String(), "cancelled") {
		t.Fatal("Task cancellation failed", w.Code, w.Body)
	}
	if _, err := f.server.db.Exec(`UPDATE golf_codex_connections SET version=version+1 WHERE id=$1`, connection); err != nil {
		t.Fatal(err)
	}
	if w = call("CreateAgentTask", body); w.Code != 200 || !strings.Contains(w.Body.String(), id) {
		t.Fatal("Existing receipt was replayed or refused after credential revision", w.Code, w.Body)
	}
	body["instructions"] = "Changed request"
	if w = call("CreateAgentTask", body); w.Code == 200 {
		t.Fatal("Changed request reused an existing receipt")
	}
	body["idempotencyKey"] = uuid.NewString()
	body["expectedConnectionVersion"] = "1"
	if w = call("CreateAgentTask", body); w.Code == 200 {
		t.Fatal("Stale account admission accepted")
	}
}

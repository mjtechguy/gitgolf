package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/encoding/protojson"
)

var conversationInitial = []byte(`{"tokens":{"access":"initial-private-credential-123456"}}`)
var conversationRefreshed = []byte(`{"tokens":{"access":"refreshed-private-credential-654321"}}`)

type conversationFixture struct {
	x       *actionFixture
	t       agentTaskRecord
	r       codexRecord
	attempt string
}

func newConversationFixture(t *testing.T) *conversationFixture {
	t.Helper()
	x := newActionFixture(t)
	id := uuid.NewString()
	x.task(t, id, 11, x.user, x.at)
	attempt := strings.Repeat("c", 32)
	actor := codexActor{UserID: x.user, NativeID: 42, Hash: x.hash}
	fingerprint, e := x.f.server.agentPolicyFingerprint(t.Context(), x.f.server.db, actor, 11, 42)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = x.f.server.db.Exec(`UPDATE golf_agent_tasks SET state='running',worker_id='worker',attempt_id=$2,lease_expires_at=clock_timestamp()+interval '1 hour',policy_fingerprint=$3 WHERE id=$1`, id, attempt, fingerprint); e != nil {
		t.Fatal(e)
	}
	row, e := x.f.server.taskRecord(t.Context(), id)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(row.Hash, x.hash) {
		t.Fatal("fixture task session binding mismatch")
	}
	if _, e := x.f.server.sessionCredential(t.Context(), x.login.Value); e != nil {
		t.Fatalf("fixture direct managed session unavailable: %v", e)
	}
	a, e := x.f.server.taskActor(t.Context(), row)
	if e != nil {
		t.Fatal(e)
	}
	r, e := x.f.server.codexAuthorized(t.Context(), a, x.connection, false)
	if e != nil {
		t.Fatal(e)
	}
	return &conversationFixture{x, row, r, attempt}
}
func (f *conversationFixture) start(t *testing.T) {
	t.Helper()
	if e := f.x.f.server.startConversation(t.Context(), f.t, f.r, "worker", f.attempt, "Exact original task prompt", conversationInitial); e != nil {
		t.Fatal(e)
	}
}
func (f *conversationFixture) observe(t *testing.T, v runner.AgentObservation) {
	t.Helper()
	if v.ThreadID == "" {
		v.ThreadID = "native-thread"
	}
	if v.Kind != "thread_started" && v.TurnID == "" {
		v.TurnID = "native-turn"
	}
	if v.Kind == "assistant_message" && v.ItemID == "" {
		v.ItemID = "native-message"
	}
	if e := f.x.f.server.observeConversation(t.Context(), f.t, f.r, "worker", f.attempt, v, conversationInitial); e != nil {
		t.Fatal(e)
	}
}
func conversationCall(s *Server, login loginResult, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/rpc/golf.v1.AgentTaskService/ListAgentTaskEvents", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Origin", s.config.PublicURL)
	req.AddCookie(s.sessionCookie(login.Value, login.Expires, 3600))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
}
func (f *conversationFixture) body() map[string]any {
	return map[string]any{"repository": actionSelection(), "repositoryId": "11", "taskId": f.t.ID, "attemptId": f.attempt}
}
func (f *conversationFixture) read(t *testing.T, body map[string]any) *golfv1.ListAgentTaskEventsResponse {
	t.Helper()
	w := conversationCall(f.x.f.server, f.x.login, body)
	if w.Code != 200 {
		t.Fatal("private observation read", w.Code, w.Body)
	}
	var out golfv1.ListAgentTaskEventsResponse
	if e := protojson.Unmarshal(w.Body.Bytes(), &out); e != nil {
		t.Fatal(e)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private event response cacheable")
	}
	return &out
}
func (f *conversationFixture) finish(t *testing.T, refreshed []byte, wantSafe bool) {
	t.Helper()
	s := f.x.f.server
	tx, e := s.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	safe, e := s.screenConversation(t.Context(), tx, f.t, f.attempt, conversationInitial, refreshed)
	if e != nil || safe != wantSafe {
		t.Fatal("combined credential screen", safe, e)
	}
	state := "failed"
	if safe {
		state = "succeeded"
	}
	if _, e = tx.Exec(`UPDATE golf_agent_tasks SET state=$2 WHERE id=$1`, f.t.ID, state); e != nil {
		t.Fatal(e)
	}
	if e = s.finalizeConversation(t.Context(), tx, f.t, f.attempt, safe); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
}

func TestAgentConversationPrivatePagingPostgres(t *testing.T) {
	f := newConversationFixture(t)
	var activityBefore int
	if e := f.x.f.server.db.QueryRow(`SELECT count(*) FROM golf_repository_activity`).Scan(&activityBefore); e != nil {
		t.Fatal(e)
	}
	f.start(t)
	f.observe(t, runner.AgentObservation{Sequence: 1, Kind: "thread_started", ThreadID: "native-thread"})
	f.observe(t, runner.AgentObservation{Sequence: 2, Kind: "turn_started", ThreadID: "native-thread", TurnID: "native-turn", Status: "inProgress"})
	f.observe(t, runner.AgentObservation{Sequence: 3, Kind: "tool_started", ThreadID: "native-thread", TurnID: "native-turn", ItemID: "native-tool", ToolKind: "commandExecution", Status: "inProgress"})
	f.observe(t, runner.AgentObservation{Sequence: 4, Kind: "assistant_message", ThreadID: "native-thread", TurnID: "native-turn", ItemID: "native-message", Phase: "final_answer", Text: "Exact completed assistant response"})
	total := int64(0)
	f.observe(t, runner.AgentObservation{Sequence: 5, Kind: "usage_updated", ThreadID: "native-thread", TurnID: "native-turn", TotalTokens: &total})
	body := f.body()
	body["limit"] = 2
	first := f.read(t, body)
	if first.BodyState != 1 || len(first.Events) != 2 || first.NextSequence != "2" || first.NativeInitiatorId != "42" || first.CommitId != strings.Repeat("a", 40) {
		t.Fatal("live receipt/first page")
	}
	raw, _ := protojson.Marshal(first)
	for _, secret := range []string{"Exact original", "native-thread", "native-turn", "initial-private", "cipher", "credentialKey", "binding"} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatal("withheld payload exposed")
		}
	}
	body["afterSequence"] = first.NextSequence
	second := f.read(t, body)
	if len(second.Events) != 2 || second.Events[1].Kind != "tool_started" || second.Events[1].ToolKind != "commandExecution" || second.NextSequence != "4" {
		t.Fatal("live fixed metadata/paging lost")
	}
	f.finish(t, conversationRefreshed, true)
	body["afterSequence"] = "0"
	body["limit"] = 64
	available := f.read(t, body)
	if available.BodyState != 2 || len(available.Events) != 6 || available.Events[0].Text != "Exact original task prompt" || available.Events[4].Text != "Exact completed assistant response" || available.Events[4].ThreadId != "native-thread" || available.Events[5].TotalTokens == nil || *available.Events[5].TotalTokens != "0" {
		t.Fatal("vetted original prompt/native identity/zero usage lost")
	}
	var shared int
	if e := f.x.f.server.db.QueryRow(`SELECT count(*) FROM golf_repository_activity WHERE repository_id=11`).Scan(&shared); e != nil {
		t.Fatal(e)
	}
	if shared != activityBefore {
		t.Fatal("private journal emitted shared activity")
	}
	// A fresh runtime reads the same private journal; no native execution occurs.
	fresh, e := New(f.x.f.server.config, f.x.f.server.db)
	if e != nil {
		t.Fatal(e)
	}
	f.x.f.server = fresh
	again := f.read(t, body)
	if len(again.Events) != 6 || again.Events[4].Text != available.Events[4].Text {
		t.Fatal("restart lost private journal")
	}
}
func TestAgentConversationCredentialScreenPostgres(t *testing.T) {
	for _, which := range []string{"initial_prompt", "initial_message", "refreshed_text", "refreshed_native_id", "refreshed_plan", "missing_refresh", "malformed_refresh"} {
		t.Run(which, func(t *testing.T) {
			f := newConversationFixture(t)
			s := f.x.f.server
			if which == "initial_prompt" {
				if e := s.startConversation(t.Context(), f.t, f.r, "worker", f.attempt, "initial-private-credential-123456", conversationInitial); e == nil {
					t.Fatal("initial prompt credential admitted")
				}
				var n int
				s.db.QueryRow(`SELECT count(*) FROM golf_agent_conversations`).Scan(&n)
				if n != 0 {
					t.Fatal("unsafe prompt retained")
				}
				return
			}
			f.start(t)
			v := runner.AgentObservation{Sequence: 1, Kind: "assistant_message", Text: "ordinary message", ThreadID: "native-thread", TurnID: "native-turn", ItemID: "native-message"}
			if which == "initial_message" {
				v.Text = "initial-private-credential-123456"
				if e := s.observeConversation(t.Context(), f.t, f.r, "worker", f.attempt, v, conversationInitial); e == nil {
					t.Fatal("initial credential message acknowledged")
				}
				var n int
				s.db.QueryRow(`SELECT count(*) FROM golf_agent_task_events`).Scan(&n)
				if n != 1 {
					t.Fatal("unsafe message retained")
				}
				return
			}
			if which == "refreshed_text" {
				v.Text = "refreshed-private-credential-654321"
			}
			if which == "refreshed_native_id" {
				v.ThreadID = "refreshed-private-credential-654321"
			}
			if which == "refreshed_plan" {
				v.Kind = "plan_updated"
				v.ItemID = ""
				v.Text = ""
				v.Plan = []runner.AgentPlanStep{{Step: "refreshed-private-credential-654321", Status: "pending"}}
			}
			f.observe(t, v)
			refresh := conversationRefreshed
			if which == "missing_refresh" {
				refresh = nil
			}
			if which == "malformed_refresh" {
				refresh = []byte("null")
			}
			f.finish(t, refresh, false)
			out := f.read(t, f.body())
			raw, _ := protojson.Marshal(out)
			if out.BodyState != 3 || bytes.Contains(raw, []byte("refreshed-private")) || bytes.Contains(raw, []byte("ordinary message")) {
				t.Fatal("unsafe/unvetted terminal body exposed")
			}
		})
	}
}
func TestAgentConversationAckAndIdentityPostgres(t *testing.T) {
	f := newConversationFixture(t)
	f.start(t)
	s := f.x.f.server
	v := runner.AgentObservation{Sequence: 1, Kind: "thread_started", ThreadID: "same-thread"}
	f.observe(t, v)
	f.observe(t, v)
	var n int
	s.db.QueryRow(`SELECT count(*) FROM golf_agent_task_events`).Scan(&n)
	if n != 2 {
		t.Fatal("exact duplicate callback added event")
	}
	v.ThreadID = "different-thread"
	if e := s.observeConversation(t.Context(), f.t, f.r, "worker", f.attempt, v, conversationInitial); e == nil {
		t.Fatal("changed same sequence admitted")
	}
	v.Sequence = 3
	if e := s.observeConversation(t.Context(), f.t, f.r, "worker", f.attempt, v, conversationInitial); e == nil {
		t.Fatal("sequence gap admitted")
	}
	var count int
	s.db.QueryRow(`SELECT count(*) FROM golf_agent_conversation_contents`).Scan(&count)
	if count != 2 {
		t.Fatal("failed callback left orphan private contents")
	}
	// An actual SQL failure prevents durable acknowledgement and rolls back both rows.
	if _, e := s.db.Exec(`CREATE FUNCTION fixture_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER fixture_event_failure BEFORE INSERT ON golf_agent_task_events FOR EACH ROW EXECUTE FUNCTION fixture_event_failure()`); e != nil {
		t.Fatal(e)
	}
	v.Sequence = 2
	if e := s.observeConversation(t.Context(), f.t, f.r, "worker", f.attempt, v, conversationInitial); e == nil {
		t.Fatal("SQL failure acknowledged")
	}
	s.db.QueryRow(`SELECT count(*) FROM golf_agent_conversation_contents`).Scan(&count)
	if count != 2 {
		t.Fatal("lost event transaction leaked content")
	}
	if _, e := s.db.Exec(`DROP TRIGGER fixture_event_failure ON golf_agent_task_events`); e != nil {
		t.Fatal(e)
	}
	for _, stmt := range []string{`UPDATE golf_agent_task_events SET kind='turn_started'`, `DELETE FROM golf_agent_task_events`, `TRUNCATE golf_agent_task_events`, `UPDATE golf_agent_conversation_contents SET sequence=2 WHERE sequence=1`, `UPDATE golf_agent_conversations SET attempt_id='dddddddddddddddddddddddddddddddd'`} {
		if _, e := s.db.Exec(stmt); e == nil {
			t.Fatal("retained immutable identity mutated")
		}
	}
	// The AAD authenticates both exact actor/repository identity and decrypted body.
	row, e := scanConversationEvent(s.db.QueryRow(`SELECT ` + conversationEventColumns + ` FROM golf_agent_task_events e JOIN golf_agent_conversation_contents c ON c.id=e.content_id WHERE e.sequence=1`))
	if e != nil {
		t.Fatal(e)
	}
	other := f.t
	other.UserID++
	if _, e = s.openConversationEvent(other, f.attempt, row); e == nil {
		t.Fatal("cross-owner ciphertext accepted")
	}
	other = f.t
	other.RepositoryID++
	if _, e = s.openConversationEvent(other, f.attempt, row); e == nil {
		t.Fatal("cross-repository ciphertext accepted")
	}
	s.finishAgentFailure(t.Context(), f.t.ID, f.attempt, "fixture durable failure")
	out := f.read(t, f.body())
	if out.BodyState != 3 {
		t.Fatal("lost attempt still advertised future body availability")
	}
	if e := s.observeConversation(t.Context(), f.t, f.r, "worker", f.attempt, v, conversationInitial); e == nil {
		t.Fatal("terminal attempt acknowledged callback")
	}
}
func TestAgentConversationAuthorityPostgres(t *testing.T) {
	for _, which := range []string{"native_writer", "session", "account_version", "policy", "lease", "foreign_attempt"} {
		t.Run(which, func(t *testing.T) {
			f := newConversationFixture(t)
			f.start(t)
			s := f.x.f.server
			switch which {
			case "native_writer":
				f.x.f.mu.Lock()
				f.x.f.permission = "read"
				f.x.f.mu.Unlock()
			case "session":
				s.db.Exec(`DELETE FROM golf_sessions WHERE token_hash=$1`, f.x.hash)
			case "account_version":
				s.db.Exec(`UPDATE golf_codex_connections SET version=version+1 WHERE id=$1`, f.t.Connection)
			case "policy":
				s.db.Exec(`INSERT INTO golf_agent_usage_settings(forge_url,scope,scope_id,owner_id,config,revision) VALUES($1,'instance','instance',0,'{}',1)`, s.config.ForgeURL)
			case "lease":
				s.db.Exec(`UPDATE golf_agent_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, f.t.ID)
			case "foreign_attempt":
				f.attempt = strings.Repeat("f", 32)
			}
			if e := s.observeConversation(t.Context(), f.t, f.r, "worker", f.attempt, runner.AgentObservation{Sequence: 1, Kind: "thread_started", ThreadID: "native"}, conversationInitial); e == nil {
				t.Fatal("revoked fence acknowledged observation")
			}
			var n int
			s.db.QueryRow(`SELECT count(*) FROM golf_agent_task_events`).Scan(&n)
			if n != 1 {
				t.Fatal("revoked callback retained extra event")
			}
		})
	}
}
func TestAgentConversationReadBoundaryPostgres(t *testing.T) {
	f := newConversationFixture(t)
	f.start(t)
	for _, change := range []string{"repository", "owner", "attempt", "cursor", "size"} {
		body := f.body()
		switch change {
		case "repository":
			body["repositoryId"] = "99"
		case "owner":
			body["taskId"] = uuid.NewString()
		case "attempt":
			body["attemptId"] = strings.Repeat("d", 32)
		case "cursor":
			body["afterSequence"] = "01"
		case "size":
			body["limit"] = 65
		}
		w := conversationCall(f.x.f.server, f.x.login, body)
		if w.Code == 200 {
			t.Fatal("wrong selection accepted", change)
		}
	}
	// Same repository global admin cannot inspect a foreign private journal.
	if _, e := f.x.f.server.db.Exec(`UPDATE golf_agent_tasks SET user_id=$2 WHERE id=$1`, f.t.ID, f.x.foreign); e != nil {
		t.Fatal(e)
	}
	if w := conversationCall(f.x.f.server, f.x.login, f.body()); w.Code != 404 {
		t.Fatal("foreign private transcript exposed", w.Code)
	}
	if _, e := f.x.f.server.db.Exec(`UPDATE golf_agent_tasks SET user_id=$2 WHERE id=$1`, f.t.ID, f.x.user); e != nil {
		t.Fatal(e)
	}
	f.x.f.mu.Lock()
	f.x.f.permission = "read"
	f.x.f.mu.Unlock()
	if w := conversationCall(f.x.f.server, f.x.login, f.body()); w.Code != 404 {
		t.Fatal("repo reader saw transcript", w.Code)
	}
}
func TestAgentConversationHistoricalUnavailablePostgres(t *testing.T) {
	f := newConversationFixture(t)
	out := f.read(t, f.body())
	if out.BodyState != 3 || len(out.Events) != 0 {
		t.Fatal("historical task invented journal")
	}
	if _, e := f.x.f.server.db.Exec(`UPDATE golf_agent_tasks SET attempt_id='' WHERE id=$1`, f.t.ID); e != nil {
		t.Fatal(e)
	}
	body := f.body()
	body["attemptId"] = ""
	out = f.read(t, body)
	if out.BodyState != 3 || out.AttemptId != "" {
		t.Fatal("task without attempt invented history")
	}
}
func TestAgentConversationKeyLifecyclePostgres(t *testing.T) {
	f := newConversationFixture(t)
	f.start(t)
	f.observe(t, runner.AgentObservation{Sequence: 1, Kind: "assistant_message", Text: "retained safe message"})
	f.finish(t, conversationRefreshed, true)
	s := f.x.f.server
	// Lost and cancelled withheld payloads remain counted/rotatable even though
	// the reader will never expose them as a successful conversation.
	for _, terminal := range []string{"lost", "cancelled"} {
		id := uuid.NewString()
		f.x.task(t, id, 11, f.x.user, f.x.at)
		attempt := strings.Repeat("d", 32)
		if _, e := s.db.Exec(`UPDATE golf_agent_tasks SET state='running',worker_id='worker',attempt_id=$2,lease_expires_at=clock_timestamp()+interval '1 hour',policy_fingerprint=$3 WHERE id=$1`, id, attempt, f.t.Fingerprint); e != nil {
			t.Fatal(e)
		}
		task, e := s.taskRecord(t.Context(), id)
		if e != nil {
			t.Fatal(e)
		}
		if e = s.startConversation(t.Context(), task, f.r, "worker", attempt, "Retained unexposed prompt", conversationInitial); e != nil {
			t.Fatal(e)
		}
		if terminal == "lost" {
			s.finishAgentFailure(t.Context(), id, attempt, "fixture")
		} else {
			if _, e = s.db.Exec(`UPDATE golf_agent_tasks SET state='cancelled' WHERE id=$1`, id); e != nil {
				t.Fatal(e)
			}
		}
	}
	keys := rotationKeys(t, s.config)
	ctx := context.Background()
	status, e := KeyStatus(ctx, s.db, keys)
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, v := range status.Keys {
		if v.KeyID == "legacy" {
			found = v.ConversationContents == 4
		}
	}
	if !found {
		t.Fatal("retained conversation absent from key inventory")
	}
	mustActivate(t, s.db, keys)
	if _, e = CheckKeyRetirement(ctx, s.db, keys, "legacy"); !errors.Is(e, errKeyRetirement) {
		t.Fatal("retained conversation key allowed retirement", e)
	}
	missing := keyedConfig(s.config)
	missing.EncryptionKey = ""
	if _, e = New(missing, s.db); !errors.Is(e, errKeyPolicy) {
		t.Fatal("startup accepted unavailable historical key", e)
	}
	operation, e := RotateCredentials(ctx, s.db, keys, 1, 20)
	if e != nil || !operation.Complete || operation.RotatedConversationContents != 4 {
		t.Fatal("bounded conversation rotation", e, operation.RotatedConversationContents)
	}
	var events int
	if e = s.db.QueryRow(`SELECT COALESCE(sum(conversation_contents_count),0) FROM golf_crypto_events WHERE action='CREDENTIAL_BATCH_REENCRYPTED'`).Scan(&events); e != nil || events != 4 {
		t.Fatal("rotation counter absent", events, e)
	}
	if _, e = CheckKeyRetirement(ctx, s.db, keys, "legacy"); e != nil {
		t.Fatal(e)
	}
	fresh, e := New(missing, s.db)
	if e != nil {
		t.Fatal("key retirement/restart", e)
	}
	f.x.f.server = fresh
	out := f.read(t, f.body())
	if out.Events[1].Text != "retained safe message" {
		t.Fatal("rotation altered authenticated conversation")
	}
}
func TestAgentConversationTransportBoundary(t *testing.T) {
	s, e := New(testConfig("http://native.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, origin := range []string{s.config.PublicURL, "https://foreign.invalid"} {
		req := httptest.NewRequest(http.MethodPost, "/rpc/golf.v1.AgentTaskService/ListAgentTaskEvents", strings.NewReader("invalid body"))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		want := 401
		if origin != s.config.PublicURL {
			want = 403
		}
		if w.Code != want {
			t.Fatal("private origin/auth decoded body", w.Code)
		}
	}
	if validConversationAuth(nil) || validConversationAuth([]byte("null")) || validConversationAuth([]byte("[]")) || !validConversationAuth([]byte("{}")) {
		t.Fatal("recovered cache bounds")
	}
}

func TestAgentConversationQuotaAndConcurrentAckPostgres(t *testing.T) {
	f := newConversationFixture(t)
	f.start(t)
	s := f.x.f.server
	v := runner.AgentObservation{Sequence: 1, Kind: "thread_started", ThreadID: "thread"}
	done := make(chan error, 8)
	for range 8 {
		go func() {
			done <- s.observeConversation(t.Context(), f.t, f.r, "worker", f.attempt, v, conversationInitial)
		}()
	}
	for range 8 {
		if e := <-done; e != nil {
			t.Fatal(e)
		}
	}
	var count int
	s.db.QueryRow(`SELECT count(*) FROM golf_agent_task_events`).Scan(&count)
	if count != 2 {
		t.Fatal("concurrent duplicate acknowledged twice")
	}
	for seq := int64(2); seq <= 4; seq++ {
		f.observe(t, runner.AgentObservation{Sequence: seq, Kind: "assistant_message", Text: strings.Repeat("x", 65536)})
	}
	if e := s.observeConversation(t.Context(), f.t, f.r, "worker", f.attempt, runner.AgentObservation{Sequence: 5, Kind: "assistant_message", ThreadID: "thread", TurnID: "turn", ItemID: "last", Text: strings.Repeat("x", 65536)}, conversationInitial); e == nil {
		t.Fatal("attempt projected-byte bound exceeded")
	}
	s.db.QueryRow(`SELECT count(*) FROM golf_agent_task_events`).Scan(&count)
	if count != 5 {
		t.Fatal("overbound append changed durable prefix")
	}
	var total int
	if e := s.db.QueryRow(`SELECT projected_bytes FROM golf_agent_conversations`).Scan(&total); e != nil || total > conversationBytes {
		t.Fatal("bounded accounting", total, e)
	}
	if _, e := s.db.Exec(`UPDATE golf_agent_conversations SET body_state='AVAILABLE'`); e == nil {
		t.Fatal("running journal bodies released")
	}
	out := f.read(t, f.body())
	raw, _ := protojson.Marshal(out)
	if len(raw) > 512<<10 || out.BodyState != 1 {
		t.Fatal("bounded withheld read")
	}
}
func TestAgentConversationEscapedCredentialsPostgres(t *testing.T) {
	f := newConversationFixture(t)
	f.start(t)
	// Compare decoded strings: JSON HTML escaping must not bypass a credential
	// match, including when it is a plan/native-ID field rather than assistant text.
	secret := "secret<private>&credential-abcdef123"
	refreshed, _ := json.Marshal(map[string]string{"access_token": secret})
	f.observe(t, runner.AgentObservation{Sequence: 1, Kind: "assistant_message", Text: secret})
	f.finish(t, refreshed, false)
	out := f.read(t, f.body())
	if out.BodyState != 3 || out.Events[1].Text != "" {
		t.Fatal("JSON escaping bypassed refreshed credential screen")
	}
}
func TestAgentConversationMalformedProjection(t *testing.T) {
	for _, v := range []runner.AgentObservation{
		{Sequence: 1, Kind: "thread_started", ThreadID: "native", Text: "hidden nonmessage text"},
		{Sequence: 1, Kind: "assistant_message", ThreadID: "native", TurnID: "turn", ItemID: "item", Text: "bad\x00control"},
		{Sequence: 1, Kind: "tool_completed", ThreadID: "native", TurnID: "turn", ItemID: "item", ToolKind: "commandExecution", Status: "unknown"},
		{Sequence: 1, Kind: "usage_updated", ThreadID: "native", TurnID: "turn"},
		{Sequence: 1, Kind: "plan_updated", ThreadID: "native", TurnID: "turn", Plan: []runner.AgentPlanStep{{Step: "description", Status: "not_known"}}},
	} {
		if _, _, _, _, e := conversationMetadata(conversationPayload{Observation: v}); e == nil {
			t.Fatal("unqualified native strings projected")
		}
	}
}

func TestAgentConversationEmptyPlanPostgres(t *testing.T) {
	f := newConversationFixture(t)
	f.start(t)
	f.observe(t, runner.AgentObservation{Sequence: 1, Kind: "plan_updated", Plan: []runner.AgentPlanStep{{Step: "Prior plan", Status: "pending"}}})
	f.observe(t, runner.AgentObservation{Sequence: 2, Kind: "plan_updated", Plan: []runner.AgentPlanStep{}})
	f.finish(t, conversationRefreshed, true)
	out := f.read(t, f.body())
	if len(out.Events) != 3 || out.Events[1].Plan[0].Step != "Prior plan" || len(out.Events[2].Plan) != 0 || out.Events[2].Kind != "plan_updated" || out.Events[2].BodyState != 2 {
		t.Fatal("explicit native empty plan failed private roundtrip")
	}
}

func TestAgentConversationLegacyBootstrapLaterPagePostgres(t *testing.T) {
	db := testDatabase(t)
	config := testConfig("https://forge.invalid")
	config.EncryptionKey = keyFixture(1)
	keys := parseTestKeys(t, keyFixture(1), nil, "")
	s := &Server{db: db, keyring: keys, config: config}
	user, e := database.New(db).UpsertUser(t.Context(), database.UpsertUserParams{ForgeURL: config.ForgeURL, ForgeUserID: 42, Login: "alice"})
	if e != nil {
		t.Fatal(e)
	}
	connection, id, attempt := uuid.NewString(), uuid.NewString(), strings.Repeat("a", 32)
	if _, e = db.Exec(`INSERT INTO golf_codex_connections(id,user_id,state,forge_url,harness,provider,name) VALUES($1,$2,'CONNECTED',$3,'codex','openai','legacy fixture')`, connection, user, config.ForgeURL); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(`INSERT INTO golf_agent_tasks(id,forge_url,repository_id,owner_id,repository_owner,repository_name,user_id,native_user_id,session_hash,connection_id,connection_version,commit_id,source_archive,config,policy_fingerprint,idempotency_key,input_hash,state,worker_id,attempt_id,lease_expires_at) VALUES($1,$2,11,42,'alice','example',$3,42,$4,$5,1,$6,'','{}','fixture',$7,$4,'running','worker',$8,clock_timestamp()+interval '1 hour')`, id, config.ForgeURL, user, bytes.Repeat([]byte{1}, 32), connection, strings.Repeat("a", 40), uuid.NewString(), attempt); e != nil {
		t.Fatal(e)
	}
	task, e := s.taskRecord(t.Context(), id)
	if e != nil {
		t.Fatal(e)
	}
	tx, e := db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`INSERT INTO golf_agent_conversations(task_id,attempt_id,forge_url,repository_id,owner_id,user_id,native_user_id,worker_id,connection_id,connection_version,commit_id) VALUES($1,$2,$3,11,42,$4,42,'worker',$5,1,$6)`, id, attempt, config.ForgeURL, user, connection, task.Commit); e != nil {
		t.Fatal(e)
	}
	if e = s.appendConversationEvent(t.Context(), tx, task, attempt, 1, conversationPayload{Prompt: "Retained initial prompt"}); e != nil {
		t.Fatal(e)
	}
	for sequence := int64(1); sequence <= 500; sequence++ {
		tokens := sequence
		if e = s.appendConversationEvent(t.Context(), tx, task, attempt, sequence+1, conversationPayload{Observation: runner.AgentObservation{Sequence: sequence, Kind: "usage_updated", ThreadID: "thread", TurnID: "turn", TotalTokens: &tokens}}); e != nil {
			t.Fatal(e)
		}
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	var contentID string
	var original []byte
	if e = db.QueryRow(`SELECT id::text,encrypted_content FROM golf_agent_conversation_contents ORDER BY id DESC LIMIT 1`).Scan(&contentID, &original); e != nil {
		t.Fatal(e)
	}
	damaged := append([]byte(nil), original...)
	damaged[0] ^= 1
	if _, e = db.Exec(`UPDATE golf_agent_conversation_contents SET encrypted_content=$2 WHERE id=$1`, contentID, damaged); e != nil {
		t.Fatal(e)
	}
	if _, e = New(config, db); !errors.Is(e, errKeyBootstrap) {
		t.Fatal("legacy bootstrap skipped corrupt second page", e)
	}
	if _, e = database.New(db).GetKeyFingerprint(t.Context(), "legacy"); !errors.Is(e, sql.ErrNoRows) {
		t.Fatal("incomplete conversation bootstrap registered key")
	}
	if _, e = db.Exec(`UPDATE golf_agent_conversation_contents SET encrypted_content=$2 WHERE id=$1`, contentID, original); e != nil {
		t.Fatal(e)
	}
	if _, e = New(config, db); e != nil {
		t.Fatal("authenticated complete legacy journal bootstrap", e)
	}
	status, e := KeyStatus(t.Context(), db, keys)
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, usage := range status.Keys {
		if usage.KeyID == "legacy" {
			found = usage.ConversationContents == 501
		}
	}
	if !found {
		t.Fatal("complete retained journal inventory lost")
	}
}
func TestAgentConversationReadLateRevocationPostgres(t *testing.T) {
	for _, mode := range []string{"writer", "native_repository", "session"} {
		t.Run(mode, func(t *testing.T) {
			f := newConversationFixture(t)
			f.start(t)
			f.observe(t, runner.AgentObservation{Sequence: 1, Kind: "assistant_message", Text: "private late-screened body"})
			f.finish(t, conversationRefreshed, true)
			base := f.x.f.server.client.Transport
			if base == nil {
				base = http.DefaultTransport
			}
			calls := 0
			f.x.f.server.client.Transport = creationRoundTripper(func(req *http.Request) (*http.Response, error) {
				path := "/api/v1/repos/alice/example/collaborators/alice/permission"
				if mode == "native_repository" {
					path = "/api/v1/repos/alice/example"
				}
				if req.URL.Path == path {
					calls++
					if calls == 2 {
						switch mode {
						case "writer":
							f.x.f.mu.Lock()
							f.x.f.permission = "read"
							f.x.f.mu.Unlock()
						case "native_repository":
							f.x.f.mu.Lock()
							f.x.f.row.ID = 99
							f.x.f.mu.Unlock()
						case "session":
							if _, e := f.x.f.server.db.Exec(`DELETE FROM golf_sessions WHERE token_hash=$1`, f.x.hash); e != nil {
								t.Error(e)
							}
						}
					}
				}
				return base.RoundTrip(req)
			})
			w := conversationCall(f.x.f.server, f.x.login, f.body())
			if w.Code == 200 || strings.Contains(w.Body.String(), "private late-screened body") {
				t.Fatal("late native/session denial released private body", w.Code)
			}
		})
	}
}

func TestAgentConversationRecoveredCredentialPersistencePostgres(t *testing.T) {
	f := newConversationFixture(t)
	s := f.x.f.server
	original, key, e := s.keyring.seal(infrastructureConnectionDomain, string(conversationInitial), codexBinding(f.r.ID))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.db.Exec(`INSERT INTO golf_codex_auth(connection_id,encrypted_credential,credential_binding,credential_key_id) VALUES($1,$2,$3,$4)`, f.r.ID, original, codexBinding(f.r.ID), key); e != nil {
		t.Fatal(e)
	}
	if _, e = s.db.Exec(`INSERT INTO golf_agent_model_catalogs(connection_id,connection_version,models) VALUES($1,1,'[]')`, f.r.ID); e != nil {
		t.Fatal(e)
	}
	for _, bad := range [][]byte{nil, []byte("null"), []byte("[]"), []byte("{malformed"), bytes.Repeat([]byte("x"), 65537)} {
		tx, e := s.db.BeginTx(t.Context(), nil)
		if e != nil {
			t.Fatal(e)
		}
		if e = s.persistAgentCredential(t.Context(), tx, f.r, bad); e != nil {
			tx.Rollback()
			t.Fatal(e)
		}
		if e = tx.Commit(); e != nil {
			t.Fatal(e)
		}
		var stored []byte
		var storedKey string
		var version, catalog int64
		if e = s.db.QueryRow(`SELECT a.encrypted_credential,a.credential_key_id,c.version,m.connection_version FROM golf_codex_auth a JOIN golf_codex_connections c ON c.id=a.connection_id JOIN golf_agent_model_catalogs m ON m.connection_id=c.id WHERE c.id=$1`, f.r.ID).Scan(&stored, &storedKey, &version, &catalog); e != nil {
			t.Fatal(e)
		}
		if !bytes.Equal(stored, original) || storedKey != key || version != 1 || catalog != 1 {
			t.Fatal("malformed recovery overwrote known cache/key/version/catalog")
		}
	}
	tx, e := s.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.persistAgentCredential(t.Context(), tx, f.r, conversationRefreshed); e != nil {
		tx.Rollback()
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	var stored []byte
	var storedKey string
	var version, catalog int64
	if e = s.db.QueryRow(`SELECT a.encrypted_credential,a.credential_key_id,c.version,m.connection_version FROM golf_codex_auth a JOIN golf_codex_connections c ON c.id=a.connection_id JOIN golf_agent_model_catalogs m ON m.connection_id=c.id WHERE c.id=$1`, f.r.ID).Scan(&stored, &storedKey, &version, &catalog); e != nil {
		t.Fatal(e)
	}
	plain, e := s.keyring.open(storedKey, infrastructureConnectionDomain, stored, codexBinding(f.r.ID))
	if e != nil || plain != string(conversationRefreshed) || version != 2 || catalog != 2 {
		t.Fatal("valid current native recovery not retained atomically", e)
	}
	// A stale completion cannot replace a later recovery even with valid shape.
	tx, e = s.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	if e = s.persistAgentCredential(t.Context(), tx, f.r, conversationInitial); !errors.Is(e, errCodexConflict) {
		t.Fatal("stale cache replaced refreshed version", e)
	}
}

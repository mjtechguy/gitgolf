package server

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Golf-owned fixture rows exercise the immutable origin contract; no native
// repository/database files are edited. Public automatic dispatch stays absent.
func automaticRunFixture(t *testing.T) (*workflowRunFixture, workflowRunRecord, *golfv1.AutomationGrant) {
	t.Helper()
	f := newWorkflowRunFixture(t)
	f.enable(t)
	f.mu.Lock()
	f.workflow = []byte(strings.Replace(workflowActionsFixture, "on: workflow_dispatch", "on:\n  workflow_dispatch:\n  push:", 1))
	f.mu.Unlock()
	m := grantFixtureRequest()
	m.NativeToken = "run-fixture"
	response, err := f.server.CreateAutomationGrant(f.context(t), workflowRunRequest(f, m))
	if err != nil {
		t.Fatal(err)
	}
	grant := response.Msg.Grant
	manual, err := f.dispatch(t, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.server.CancelWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.CancelWorkflowRunRequest{RunId: manual.Msg.Run.Id, ExpectedVersion: "1"})); err != nil {
		t.Fatal(err)
	}
	var event int64
	connection := uuid.NewString()
	if _, err = f.server.db.Exec(`INSERT INTO golf_repository_event_connections(id,forge_url,repository_id,owner_id,repository) VALUES($1,$2,$3,42,'alice/example')`, connection, f.server.config.GiteaURL, f.row.ID); err != nil {
		t.Fatal(err)
	}
	if err = f.server.db.QueryRow(`INSERT INTO golf_repository_events(connection_id,delivery_id,payload_sha256,payload_bytes,event_type,ref,before_commit_id,after_commit_id,sender_id) VALUES($1,$2,$3,10,'push','refs/heads/main',$4,$5,84) RETURNING id`, connection, uuid.NewString(), strings.Repeat("e", 64), strings.Repeat("0", 40), f.commit).Scan(&event); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	_, err = f.server.db.Exec(`INSERT INTO golf_workflow_runs(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,user_id,commit_id,workflow_path,blob_id,format,plan,source_archive,source_sha256,policy_epochs,idempotency_key,input_hash,source_storage,source_key,source_fingerprint,source_profile_id,source_profile_version,origin,automation_grant_id,automation_grant_revision,automation_grant_epoch,automation_credential_version,repository_event_id,event_ref)
 SELECT $1,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,user_id,commit_id,workflow_path,blob_id,format,plan,source_archive,source_sha256,policy_epochs,idempotency_key,input_hash,source_storage,source_key,source_fingerprint,source_profile_id,source_profile_version,'push',$2,1,1,1,$3,'refs/heads/main' FROM golf_workflow_runs WHERE id=$4`, id, grant.Id, event, manual.Msg.Run.Id)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.server.loadWorkflowRun(t.Context(), id)
	if err != nil || run.Origin != "push" || len(run.SessionHash) != 0 {
		t.Fatal("automatic origin missing", err)
	}
	return f, run, grant
}

func automationRunnerCall(f *workflowRunFixture, path, attempt, body string) *httptest.ResponseRecorder {
	method := "POST"
	if strings.HasSuffix(path, "/source") {
		method = "GET"
	}
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Golf-Runner-ID", "fixture")
	r.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	if attempt != "" {
		r.Header.Set("Golf-Attempt-Token", attempt)
	}
	w := httptest.NewRecorder()
	f.server.ServeHTTP(w, r)
	return w
}

func TestAutomationRunOriginPostgres(t *testing.T) {
	f, run, _ := automaticRunFixture(t)
	if _, err := f.server.db.Exec(`UPDATE golf_workflow_runs SET origin='manual',session_hash=$2 WHERE id=$1`, run.ID, bytes.Repeat([]byte{0}, 32)); err == nil {
		t.Fatal("automatic origin replaced by fake browser session")
	}
	if _, err := f.server.db.Exec(`UPDATE golf_workflow_runs SET event_ref='refs/heads/other' WHERE id=$1`, run.ID); err == nil {
		t.Fatal("immutable event origin edited")
	}

	for _, patch := range []map[string]any{
		{"origin": "manual"}, {"session_hash": "\\x" + strings.Repeat("00", 32)}, {"automation_grant_revision": nil},
		{"automation_grant_epoch": 0}, {"automation_credential_version": 2}, {"repository_event_id": nil},
		{"event_ref": "refs/heads/other"}, {"commit_id": strings.Repeat("b", 40)}, {"commit_id": strings.Repeat("0", 40)},
		{"repository_id": 123}, {"owner_id": 84}, {"workflow_path": ".github/workflows/other.yml"},
		{"automation_grant_revision": 2}, {"automation_grant_id": uuid.NewString()},
	} {
		patch["id"] = uuid.NewString()
		patch["idempotency_key"] = uuid.NewString()
		encoded, _ := json.Marshal(patch)
		_, err := f.server.db.Exec(`INSERT INTO golf_workflow_runs SELECT (jsonb_populate_record(NULL::golf_workflow_runs,to_jsonb(r)||$2::jsonb)).* FROM golf_workflow_runs r WHERE id=$1`, run.ID, string(encoded))
		var pgError *pgconn.PgError
		if !errors.As(err, &pgError) || (pgError.Code != "P0001" && pgError.Code != "23514") {
			t.Fatal("insert binding did not reject invalid authority before uniqueness", patch, err)
		}
	}

	var oldEvent int64
	if err := f.server.db.QueryRow(`INSERT INTO golf_repository_events(connection_id,delivery_id,payload_sha256,payload_bytes,event_type,ref,before_commit_id,after_commit_id,sender_id,received_at) SELECT connection_id,$2,payload_sha256,payload_bytes,event_type,ref,before_commit_id,after_commit_id,sender_id,(SELECT created_at-interval '1 second' FROM golf_automation_grants WHERE id=$3) FROM golf_repository_events WHERE id=$1 RETURNING id`, run.RepositoryEventID.Int64, uuid.NewString(), run.AutomationGrantID.String).Scan(&oldEvent); err != nil {
		t.Fatal(err)
	}
	oldPatch, _ := json.Marshal(map[string]any{"id": uuid.NewString(), "idempotency_key": uuid.NewString(), "repository_event_id": oldEvent})
	_, oldErr := f.server.db.Exec(`INSERT INTO golf_workflow_runs SELECT (jsonb_populate_record(NULL::golf_workflow_runs,to_jsonb(r)||$2::jsonb)).* FROM golf_workflow_runs r WHERE id=$1`, run.ID, string(oldPatch))
	var oldFailure *pgconn.PgError
	if !errors.As(oldErr, &oldFailure) || oldFailure.Code != "P0001" {
		t.Fatal("historical receipt admitted after grant creation", oldErr)
	}

	// The same client key remains a manual receipt; it cannot expose an automatic
	// run from the sponsor's separate origin namespace.
	again, err := f.dispatch(t, run.IdempotencyKey)
	if err != nil || again.Msg.Run.Id == run.ID || again.Msg.Run.State != golfv1.WorkflowRunState_WORKFLOW_RUN_STATE_CANCELLED {
		t.Fatal("manual replay crossed authority origin", err)
	}
	// Same event/grant/path is a single run, even with another client UUID.
	patch, _ := json.Marshal(map[string]any{"id": uuid.NewString(), "idempotency_key": uuid.NewString()})
	_, err = f.server.db.Exec(`INSERT INTO golf_workflow_runs SELECT (jsonb_populate_record(NULL::golf_workflow_runs,to_jsonb(r)||$2::jsonb)).* FROM golf_workflow_runs r WHERE id=$1`, run.ID, string(patch))
	var duplicate *pgconn.PgError
	if !errors.As(err, &duplicate) || duplicate.Code != "23505" || duplicate.ConstraintName != "golf_workflow_runs_event_grant_path" {
		t.Fatal("duplicate event acquired second execution", err)
	}

	var count int
	if err := f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_runs WHERE origin='push'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("origin mutation persisted", err)
	}
}

func TestAutomationRunRunnerFencesPostgres(t *testing.T) {
	for _, scenario := range []string{"logout", "manual-only", "revoke-queued", "revoke-running", "policy-running", "expired", "native-denied", "native-owner-change", "expired-running", "sponsor-disabled", "policy-outage-running", "restart", "push-only", "native-principal-change", "native-archived", "native-mirror"} {
		t.Run(scenario, func(t *testing.T) {
			f, run, grant := automaticRunFixture(t)
			exec := func(query string, args ...any) {
				t.Helper()
				if _, err := f.server.db.Exec(query, args...); err != nil {
					t.Fatal(err)
				}
			}
			if scenario != "manual-only" {
				exec(`UPDATE golf_execution_policies SET push_allowed=true`)
			}
			if scenario == "logout" {
				exec(`DELETE FROM golf_sessions`)
			}
			if scenario == "revoke-queued" {
				_, err := f.server.RevokeAutomationGrant(f.context(t), workflowRunRequest(f, &golfv1.RevokeAutomationGrantRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, GrantId: grant.Id, ExpectedRevision: "1"}))
				if err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "expired" {
				exec(`UPDATE golf_automation_grants SET expires_at=created_at+interval '1 microsecond' WHERE id=$1`, grant.Id)
			}
			if scenario == "native-denied" {
				f.mu.Lock()
				f.denied = true
				f.mu.Unlock()
			}
			if scenario == "native-owner-change" {
				f.mu.Lock()
				f.row.Owner.ID = 84
				f.mu.Unlock()
			}
			if scenario == "native-principal-change" {
				f.mu.Lock()
				f.user.ID = 84
				f.mu.Unlock()
			}
			if scenario == "native-archived" {
				f.mu.Lock()
				*f.row.Archived = true
				f.mu.Unlock()
			}
			if scenario == "native-mirror" {
				f.mu.Lock()
				*f.row.Mirror = true
				f.mu.Unlock()
			}
			if scenario == "push-only" {
				exec(`UPDATE golf_execution_policies SET manual_dispatch_enabled=false`)
			}
			if scenario == "restart" {
				reloaded, err := New(f.server.config, f.server.db)
				if err != nil {
					t.Fatal(err)
				}
				f.server = reloaded
			}
			poll := automationRunnerCall(f, "/internal/ci/poll", "", "{}")
			queuedDenied := scenario == "manual-only" || scenario == "revoke-queued" || scenario == "expired" || scenario == "native-denied" || scenario == "native-owner-change" || scenario == "native-principal-change" || scenario == "native-archived" || scenario == "native-mirror"
			if queuedDenied {
				if poll.Code != 204 {
					t.Fatal("denied automatic run assigned", poll.Code)
				}
				status, err := f.server.loadWorkflowRun(t.Context(), run.ID)
				if err != nil || status.State != "cancelled" {
					t.Fatal("queue denial not fenced", err)
				}
				return
			}
			if poll.Code != 200 {
				t.Fatal("automatic grant did not admit worker", poll.Code)
			}
			if bytes.Contains(poll.Body.Bytes(), []byte("run-fixture")) || bytes.Contains(poll.Body.Bytes(), []byte(f.session.Value)) {
				t.Fatal("credential reached worker assignment")
			}
			var lease struct{ AttemptID, AttemptToken, RunID string }
			if json.Unmarshal(poll.Body.Bytes(), &lease) != nil || lease.RunID != run.ID {
				t.Fatal("wrong automatic assignment")
			}
			prefix := "/internal/ci/attempt/" + lease.AttemptID
			if scenario == "revoke-running" {
				_, err := f.server.RevokeAutomationGrant(f.context(t), workflowRunRequest(f, &golfv1.RevokeAutomationGrantRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, GrantId: grant.Id, ExpectedRevision: "1"}))
				if err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "policy-running" {
				exec(`UPDATE golf_execution_policies SET push_allowed=false,revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE scope='instance'`)
			}
			if scenario == "expired-running" {
				exec(`UPDATE golf_automation_grants SET expires_at=created_at+interval '1 microsecond' WHERE id=$1`, grant.Id)
			}
			if scenario == "sponsor-disabled" {
				_, err := ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "create", LocalAccountInput{Username: "fixture-sponsor", Email: "sponsor@example.invalid", Password: "a sufficiently long local password", ForgeToken: "run-fixture"})
				if err != nil {
					t.Fatal(err)
				}
				if _, err = ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "disable", LocalAccountInput{Username: "fixture-sponsor"}); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "policy-outage-running" {
				exec(`ALTER TABLE golf_execution_policies RENAME TO temporarily_unavailable_policy`)
				for _, action := range []string{"source", "heartbeat", "logs", "finish"} {
					if got := automationRunnerCall(f, prefix+"/"+action, lease.AttemptToken, "{}"); got.Code != 503 {
						t.Fatal("storage outage not reported as unavailable", action, got.Code)
					}
				}
				preserved, err := f.server.loadWorkflowRun(t.Context(), run.ID)
				if err != nil || preserved.State != "running" || len(preserved.LeaseTokenHash) != 32 {
					t.Fatal("temporary storage outage destroyed attempt", err)
				}
				exec(`ALTER TABLE temporarily_unavailable_policy RENAME TO golf_execution_policies`)
			}
			denied := scenario == "revoke-running" || scenario == "policy-running" || scenario == "expired-running" || scenario == "sponsor-disabled"
			sourceStatus := 200
			if denied {
				sourceStatus = 403
			}
			if source := automationRunnerCall(f, prefix+"/source", lease.AttemptToken, ""); source.Code != sourceStatus {
				t.Fatal("automatic source fence", source.Code)
			}
			want := 204
			if denied {
				want = 403
			}
			if heartbeat := automationRunnerCall(f, prefix+"/heartbeat", lease.AttemptToken, "{}"); heartbeat.Code != want {
				t.Fatal("automatic heartbeat fence", heartbeat.Code)
			}
			if finish := automationRunnerCall(f, prefix+"/finish", lease.AttemptToken, `{"exitCode":0}`); finish.Code != want {
				t.Fatal("automatic result fence", finish.Code)
			}
			status, err := f.server.loadWorkflowRun(t.Context(), run.ID)
			state := "succeeded"
			if denied {
				state = "cancelled"
			}
			if err != nil || status.State != state || len(status.LeaseTokenHash) != 0 {
				t.Fatal("automatic terminal state/capability mismatch", err)
			}
			if !denied && status.UserID <= 0 {
				t.Fatal("sponsor audit subject missing")
			}
		})
	}
}

func TestAutomationRunGrantMatch(t *testing.T) {
	g := automationGrantRecord{ID: uuid.NewString(), ForgeURL: "http://forge.invalid", RepositoryID: 1, OwnerID: 2, RepositoryOwner: "alice", RepositoryName: "example", SponsorUserID: 3, Revision: 1, RevocationEpoch: 1, Enabled: true, Branches: []string{"main"}, WorkflowPaths: []string{runWorkflowPath}, ExpiresAt: time.Now().Add(time.Hour)}
	run := workflowRunRecord{Origin: "push", ForgeURL: g.ForgeURL, RepositoryID: 1, OwnerID: 2, RepositoryOwner: "alice", RepositoryName: "example", UserID: 3, AutomationGrantID: sql.NullString{String: g.ID, Valid: true}, AutomationGrantRevision: sql.NullInt64{Int64: 1, Valid: true}, AutomationGrantEpoch: sql.NullInt64{Int64: 1, Valid: true}, EventRef: "refs/heads/main", WorkflowPath: runWorkflowPath}
	if !automationRunMatchesGrant(run, g) {
		t.Fatal("matching immutable grant rejected")
	}
	for _, edit := range []func(*workflowRunRecord){func(r *workflowRunRecord) { r.ForgeURL = "http://other.invalid" }, func(r *workflowRunRecord) { r.OwnerID = 4 }, func(r *workflowRunRecord) { r.RepositoryID = 4 }, func(r *workflowRunRecord) { r.UserID = 4 }, func(r *workflowRunRecord) { r.AutomationGrantEpoch.Int64++ }, func(r *workflowRunRecord) { r.EventRef = "refs/tags/main" }, func(r *workflowRunRecord) { r.WorkflowPath = ".gitlab-ci.yml" }, func(r *workflowRunRecord) { r.AutomationGrantRevision.Valid = false }} {
		changed := run
		edit(&changed)
		if automationRunMatchesGrant(changed, g) {
			t.Fatal("changed authority accepted", strconv.FormatInt(changed.OwnerID, 10))
		}
	}
}

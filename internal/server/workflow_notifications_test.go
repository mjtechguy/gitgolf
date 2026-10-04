package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestWorkflowNotificationModeAndOutcomeText(t *testing.T) {
	for _, tc := range []struct {
		prior     int32
		requested *golfv1.WorkflowNotificationMode
		want      int32
		bad       bool
	}{
		{0, nil, 1, false}, {2, nil, 2, false}, {3, nil, 3, false}, {0, golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_COMPLETED.Enum(), 2, false},
		{1, golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_UNSPECIFIED.Enum(), 0, true}, {1, golfv1.WorkflowNotificationMode(4).Enum(), 0, true}, {4, nil, 0, true},
	} {
		got, e := workflowNotificationMode(tc.requested, tc.prior)
		if (e != nil) != tc.bad || !tc.bad && got != tc.want {
			t.Fatal("mode consent contract", got, e)
		}
	}
	for _, state := range []string{"succeeded", "failed", "timed_out", "cancelled", "lost"} {
		text, e := workflowOutcomeEmailText(workflowNotificationEvent{RunID: "owned-run", AttemptID: "", RepositoryID: 9007199254740993, OwnerID: 42, State: state, ObservedAt: time.Unix(0, 0)}, "https://golf.test/owned", "https://golf.test/unsubscribe")
		if e != nil || !strings.Contains(text, "9007199254740993") || !strings.Contains(text, "Not assigned") || state == "lost" && !strings.Contains(text, "Outcome unconfirmed") {
			t.Fatal("outcome not honest", state, e)
		}
	}
	if _, e := workflowOutcomeLabel("running"); e == nil {
		t.Fatal("nonterminal rendered as outcome")
	}
}

func saveOutcomeWebhook(t *testing.T, f *webhookFixture, mode golfv1.WorkflowNotificationMode) *golfv1.RepositoryWebhookSubscription {
	t.Helper()
	r, e := f.s.SaveRepositoryWebhook(f.ctx, webhookRequest(f, &golfv1.SaveRepositoryWebhookRequest{Target: f.target, Id: uuid.NewString(), ExpectedVersion: "0", Name: "Owned outcome receiver", EventTopics: []string{"source", "issues", "pulls", "actions"}, Endpoint: f.sink.URL + "/owned", SigningSecret: strings.Repeat("K", 32), Enabled: true, AuthorizeBackground: true, WorkflowNotifications: mode.Enum()}))
	if e != nil {
		t.Fatal(e)
	}
	if r.Msg.Subscription.WorkflowNotifications != mode {
		t.Fatal("mode receipt")
	}
	return r.Msg.Subscription
}
func insertOutcomeRun(t *testing.T, f *webhookFixture, owner int64, attempt string) string {
	t.Helper()
	id := uuid.NewString()
	_, e := f.db.Exec(`INSERT INTO golf_workflow_runs(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,user_id,session_hash,commit_id,workflow_path,blob_id,format,plan,source_archive,source_sha256,policy_epochs,idempotency_key,input_hash,attempt_id)
 SELECT $1,$2,$3,$4,'alice','example',false,user_id,$5,$6,'.github/workflows/owned.yml',$6,1,'{}',$7,$8,'[]',$1,$5,$9 FROM golf_local_accounts WHERE id=$10`, id, f.s.config.GiteaURL, int64(9007199254740993), owner, bytes.Repeat([]byte{1}, 32), strings.Repeat("a", 40), []byte("source-sensitive-sentinel"), strings.Repeat("b", 64), attempt, f.localID)
	if e != nil {
		t.Fatal("owned queued workflow", e)
	}
	return id
}
func countOutcome(t *testing.T, db *sql.DB, table, id string) int {
	t.Helper()
	var n int
	// table is a test-owned closed constant, never user input.
	if e := db.QueryRow(`SELECT count(*) FROM `+table+` WHERE event_id=$1`, "workflow-terminal:"+id).Scan(&n); e != nil {
		t.Fatal(e)
	}
	return n
}
func TestWorkflowNotificationsFanoutRollbackDedupAndOwnerPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	contact := f.verifyAndEnable(t)
	for _, mode := range []golfv1.WorkflowNotificationMode{golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_ACTIVITY, golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_COMPLETED, golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_FAILURES} {
		saveOutcomeWebhook(t, f.webhookFixture, mode)
	}
	email, e := f.s.SaveRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, &golfv1.SaveRepositoryEmailSubscriptionRequest{Target: f.target, Id: uuid.NewString(), ExpectedVersion: "0", ExpectedContactVersion: contact.ContactVersion, EventTopics: []string{"source", "actions"}, Enabled: true, AuthorizeBackground: true, WorkflowNotifications: golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_COMPLETED.Enum()}))
	if e != nil {
		t.Fatal(e)
	}
	if email.Msg.Subscription.WorkflowNotifications != golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_COMPLETED {
		t.Fatal("email mode receipt")
	}
	for _, state := range []string{"succeeded", "failed", "timed_out", "cancelled", "lost"} {
		id := insertOutcomeRun(t, f.webhookFixture, 42, strings.Repeat("c", 32))
		// Logs still produce SSE/activity, never semantic outcome notifications.
		if _, e = f.db.Exec(`UPDATE golf_workflow_runs SET log_sequence=log_sequence+1,version=version+1 WHERE id=$1`, id); e != nil {
			t.Fatal(e)
		}
		if countOutcome(t, f.db, "golf_webhook_deliveries", id) != 0 || countOutcome(t, f.db, "golf_email_deliveries", id) != 0 {
			t.Fatal("log generated terminal event")
		}
		var activity int
		if e = f.db.QueryRow(`SELECT count(*) FROM golf_webhook_deliveries d JOIN golf_webhook_subscriptions s ON s.id=d.subscription_id WHERE s.workflow_notifications<>1 AND d.event_topic='actions' AND d.event_id LIKE 'activity:%'`).Scan(&activity); e != nil || activity != 0 {
			t.Fatal("outcome webhook received log-frame activity", e)
		}
		if e = f.db.QueryRow(`SELECT count(*) FROM golf_email_deliveries WHERE kind='activity' AND event_id LIKE 'activity:%'`).Scan(&activity); e != nil || activity != 0 {
			t.Fatal("outcome email received log-frame activity", e)
		}

		tx, e := f.db.Begin()
		if e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(`UPDATE golf_workflow_runs SET state=$2,version=version+1 WHERE id=$1`, id, state); e != nil {
			t.Fatal(e)
		}
		if e = tx.Rollback(); e != nil {
			t.Fatal(e)
		}
		if countOutcome(t, f.db, "golf_workflow_notification_events", id) != 0 {
			t.Fatal("rollback retained event")
		}
		if _, e = f.db.Exec(`UPDATE golf_workflow_runs SET state=$2,version=version+1 WHERE id=$1`, id, state); e != nil {
			t.Fatal(e)
		}
		want := 1
		if state == "failed" || state == "timed_out" {
			want = 2
		}
		if countOutcome(t, f.db, "golf_webhook_deliveries", id) != want || countOutcome(t, f.db, "golf_email_deliveries", id) != 1 || countOutcome(t, f.db, "golf_workflow_notification_events", id) != 1 {
			t.Fatal("terminal fanout", state)
		}
		var payload []byte
		if e = f.db.QueryRow(`SELECT payload FROM golf_webhook_deliveries WHERE event_id=$1 LIMIT 1`, "workflow-terminal:"+id).Scan(&payload); e != nil {
			t.Fatal(e)
		}
		var decoded map[string]any
		if json.Unmarshal(payload, &decoded) != nil || len(decoded) != 10 || decoded["event"] != "workflow.run.terminal" || decoded["state"] != state || decoded["repository_id"] != "9007199254740993" || decoded["owner_id"] != "42" || decoded["run_id"] != id || decoded["attempt_id"] != strings.Repeat("c", 32) {
			t.Fatal("exact bounded payload")
		}
		for _, private := range []string{"source-sensitive-sentinel", "native-token", ".github/workflows", "log_sequence", "commit_id", "prompt"} {
			if strings.Contains(string(payload), private) {
				t.Fatal("private payload included")
			}
		}
		// A late log/version update and even a reset cannot mutate/resend the original receipt.
		if _, e = f.db.Exec(`UPDATE golf_workflow_runs SET reason='private-error-sentinel',version=version+1,log_sequence=log_sequence+1 WHERE id=$1`, id); e != nil {
			t.Fatal(e)
		}
		if _, e = f.db.Exec(`UPDATE golf_workflow_runs SET state='queued' WHERE id=$1`, id); e != nil {
			t.Fatal(e)
		}
		if _, e = f.db.Exec(`UPDATE golf_workflow_runs SET state='failed' WHERE id=$1`, id); e != nil {
			t.Fatal(e)
		}
		if countOutcome(t, f.db, "golf_webhook_deliveries", id) != want || countOutcome(t, f.db, "golf_email_deliveries", id) != 1 {
			t.Fatal("late update replayed receipt")
		}
		var observed string
		if e = f.db.QueryRow(`SELECT state FROM golf_workflow_notification_events WHERE run_id=$1`, id).Scan(&observed); e != nil || observed != state {
			t.Fatal("journal changed", e)
		}
		if _, e = f.db.Exec(`UPDATE golf_workflow_notification_events SET state='failed' WHERE run_id=$1`, id); e == nil {
			t.Fatal("journal mutable")
		}
	}
	oldOwner := insertOutcomeRun(t, f.webhookFixture, 43, "")
	if _, e = f.db.Exec(`UPDATE golf_workflow_runs SET state='failed' WHERE id=$1`, oldOwner); e != nil {
		t.Fatal(e)
	}
	if countOutcome(t, f.db, "golf_webhook_deliveries", oldOwner) != 0 || countOutcome(t, f.db, "golf_email_deliveries", oldOwner) != 0 {
		t.Fatal("old owner consent received terminal event")
	}
	// Private agent activity and non-action topics keep existing routing semantics.
	var before, after int
	f.db.QueryRow(`SELECT count(*) FROM golf_webhook_deliveries`).Scan(&before)
	f.event(t, "agents")
	f.db.QueryRow(`SELECT count(*) FROM golf_webhook_deliveries`).Scan(&after)
	if before != after {
		t.Fatal("private agent event fanned out")
	}
	f.event(t, "source")
	f.db.QueryRow(`SELECT count(*) FROM golf_webhook_deliveries`).Scan(&after)
	if after-before != 3 {
		t.Fatal("non-action topic behavior changed")
	}
}

func TestWorkflowNotificationsConsentPreservationAndRenderingPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	contact := f.verifyAndEnable(t)
	sub := saveOutcomeWebhook(t, f.webhookFixture, golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_COMPLETED)
	r, e := f.s.SaveRepositoryWebhook(f.ctx, webhookRequest(f.webhookFixture, &golfv1.SaveRepositoryWebhookRequest{Target: f.webhookFixture.target, Id: sub.Id, ExpectedVersion: sub.Version, Name: sub.Name, EventTopics: []string{"actions"}, Enabled: true, AuthorizeBackground: true}))
	if e != nil || r.Msg.Subscription.WorkflowNotifications != golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_COMPLETED {
		t.Fatal("omitted webhook edit changed consent", e)
	}
	var mode int
	if e = f.db.QueryRow(`SELECT workflow_notifications FROM golf_webhook_configuration_events WHERE subscription_id=$1 AND version=2`, sub.Id).Scan(&mode); e != nil || mode != 2 {
		t.Fatal("webhook mode audit", e)
	}
	id := uuid.NewString()
	save := &golfv1.SaveRepositoryEmailSubscriptionRequest{Target: f.target, Id: id, ExpectedVersion: "0", ExpectedContactVersion: contact.ContactVersion, EventTopics: []string{"actions"}, Enabled: true, AuthorizeBackground: true, WorkflowNotifications: golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_FAILURES.Enum()}
	first, e := f.s.SaveRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, save))
	if e != nil {
		t.Fatal(e)
	}
	save.ExpectedVersion = first.Msg.Subscription.Version
	save.WorkflowNotifications = nil
	second, e := f.s.SaveRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, save))
	if e != nil || second.Msg.Subscription.WorkflowNotifications != golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_FAILURES {
		t.Fatal("omitted email edit changed consent", e)
	}
	save.ExpectedVersion = "1"
	if _, e = f.s.SaveRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, save)); connect.CodeOf(e) != connect.CodeAborted {
		t.Fatal("stale mode edit accepted", e)
	}
	save.ExpectedVersion = "2"
	save.WorkflowNotifications = golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_UNSPECIFIED.Enum()
	if _, e = f.s.SaveRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, save)); connect.CodeOf(e) != connect.CodeInvalidArgument {
		t.Fatal("unspecified accepted", e)
	}
	if e = f.db.QueryRow(`SELECT workflow_notifications FROM golf_email_events WHERE object_id=$1 AND version=2 AND action='subscription_saved'`, id).Scan(&mode); e != nil || mode != 3 {
		t.Fatal("email mode audit", e)
	}
	run := insertOutcomeRun(t, f.webhookFixture, 42, "")
	if _, e = f.db.Exec(`UPDATE golf_workflow_runs SET state='lost' WHERE id=$1`, run); e != nil {
		t.Fatal(e)
	}
	if countOutcome(t, f.db, "golf_email_deliveries", run) != 0 {
		t.Fatal("failure mode included lost")
	}
	if _, e = f.db.Exec(`UPDATE golf_email_subscriptions SET workflow_notifications=2,version=version+1,epoch=epoch+1 WHERE id=$1`, id); e != nil {
		t.Fatal(e)
	}
	run = insertOutcomeRun(t, f.webhookFixture, 42, "")
	if _, e = f.db.Exec(`UPDATE golf_workflow_runs SET state='lost' WHERE id=$1`, run); e != nil {
		t.Fatal(e)
	}
	d, e := scanEmailDelivery(f.db.QueryRow(`SELECT `+emailDeliveryColumns+` FROM golf_email_deliveries WHERE event_id=$1`, "workflow-terminal:"+run))
	if e != nil {
		t.Fatal(e)
	}
	event, e := f.s.workflowEmailEvent(t.Context(), d)
	if e != nil || event.RunID != run || event.State != "lost" {
		t.Fatal("immutable outcome binding", e)
	}
	leased := f.claim(t)
	if leased.ID != d.ID {
		t.Fatal("different outcome claimed")
	}
	actor, e := f.s.emailAuthority(t.Context(), leased)
	if e != nil {
		t.Fatal(e)
	}
	profile, _, secret, e := f.s.emailActive(t.Context(), f.db)
	if e != nil {
		t.Fatal(e)
	}
	mail, e := f.s.prepareEmail(t.Context(), leased, actor, profile, secret)
	if e != nil || !strings.Contains(mail.Body, "Outcome unconfirmed (lost)") || !strings.Contains(mail.Body, "/actions/runs/"+run) || strings.Contains(mail.Body, "source-sensitive-sentinel") {
		t.Fatal("journal email was not rendered safely", e)
	}
	if _, e = f.db.Exec(`UPDATE golf_workflow_runs SET state='failed',reason='private-new-error' WHERE id=$1`, run); e != nil {
		t.Fatal(e)
	}
	again, e := f.s.prepareEmail(t.Context(), leased, actor, profile, secret)
	if e != nil || again.Body != mail.Body {
		t.Fatal("retry changed frozen mail", e)
	}

	if _, e = f.db.Exec(`UPDATE golf_email_subscriptions SET enabled=false,authorization_state='unsubscribed',epoch=epoch+1 WHERE id=$1`, id); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.emailAuthority(t.Context(), d); e == nil {
		t.Fatal("unsubscribed consent remained live")
	}
	if _, e = f.s.workflowEmailEvent(t.Context(), d); e == nil {
		t.Fatal("stale delivery epoch looked up outcome")
	}
}

func TestWorkflowNotificationsFanoutFailureAndConcurrentTerminalPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	saveOutcomeWebhook(t, f, golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_COMPLETED)
	id := insertOutcomeRun(t, f, 42, "")
	if _, e := f.db.Exec(`CREATE FUNCTION golf_owned_notification_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id LIKE 'workflow-terminal:%' THEN RAISE EXCEPTION 'Owned outbox fault'; END IF;RETURN NEW;END $$;CREATE TRIGGER golf_owned_notification_fault BEFORE INSERT ON golf_webhook_deliveries FOR EACH ROW EXECUTE FUNCTION golf_owned_notification_fault()`); e != nil {
		t.Fatal(e)
	}
	if _, e := f.db.Exec(`UPDATE golf_workflow_runs SET state='succeeded',version=version+1 WHERE id=$1`, id); e == nil {
		t.Fatal("outbox fault ignored")
	}
	var state string
	if e := f.db.QueryRow(`SELECT state FROM golf_workflow_runs WHERE id=$1`, id).Scan(&state); e != nil || state != "queued" || countOutcome(t, f.db, "golf_workflow_notification_events", id) != 0 || countOutcome(t, f.db, "golf_webhook_deliveries", id) != 0 {
		t.Fatal("partial terminal event committed", e)
	}
	if _, e := f.db.Exec(`DROP TRIGGER golf_owned_notification_fault ON golf_webhook_deliveries`); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	results := make(chan int64, 2)
	failures := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := f.db.Exec(`UPDATE golf_workflow_runs SET state='succeeded',version=version+1 WHERE id=$1 AND state='queued'`, id)
			if e != nil {
				failures <- e
				return
			}
			n, e := r.RowsAffected()
			if e != nil {
				failures <- e
				return
			}
			results <- n
		}()
	}
	wg.Wait()
	close(results)
	close(failures)
	for e := range failures {
		t.Fatal(e)
	}
	var writes int64
	for n := range results {
		writes += n
	}
	if writes != 1 || countOutcome(t, f.db, "golf_workflow_notification_events", id) != 1 || countOutcome(t, f.db, "golf_webhook_deliveries", id) != 1 {
		t.Fatal("concurrent terminal dedup failed")
	}
	var payload []byte
	if e := f.db.QueryRow(`SELECT payload FROM golf_webhook_deliveries WHERE event_id=$1`, "workflow-terminal:"+id).Scan(&payload); e != nil {
		t.Fatal(e)
	}
	var body map[string]any
	if json.Unmarshal(payload, &body) != nil || body["attempt_id"] != nil {
		t.Fatal("unassigned attempt was fabricated")
	}
	// Existing current native-admin read is still required at every delivery.
	f.revoked.Store(true)
	d := f.claim(t)
	f.s.attemptWebhook(t.Context(), d)
	if f.received.Load() != 0 {
		t.Fatal("revoked repository delivered terminal payload")
	}
}

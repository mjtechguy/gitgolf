package server

import (
	"context"
	"errors"
	"strconv"
	"testing"
)

func passwordAttempts(t *testing.T, s *Server, username string) (account, global int) {
	t.Helper()
	if err := s.db.QueryRowContext(t.Context(), `SELECT (SELECT attempts FROM golf_local_login_limits WHERE bucket=$1),(SELECT attempts FROM golf_local_login_limits WHERE bucket=0)`, localLoginBucket(username)).Scan(&account, &global); err != nil {
		t.Fatal(err)
	}
	return
}
func passwordAttemptHash(t *testing.T, f *managementFixture) string {
	t.Helper()
	var encoded string
	if err := f.db.QueryRowContext(t.Context(), `SELECT password_hash FROM golf_local_accounts WHERE username='alice'`).Scan(&encoded); err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestPasswordAttemptMissingStorage(t *testing.T) {
	s := new(Server)
	if _, err := s.reserveLocalPasswordAttempt(t.Context(), "alice"); !errors.Is(err, errStorageUnavailable) {
		t.Fatal("missing reservation storage accepted", err)
	}
	if correct, err := s.verifyLocalPasswordAttempt(t.Context(), "alice", localTestPassword, ""); correct || !errors.Is(err, errStorageUnavailable) {
		t.Fatal("KDF accepted without a durable charge", err)
	}
}

func TestPasswordAttemptSuccessBudgetPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", false)
	encoded := passwordAttemptHash(t, f)
	good := func() {
		t.Helper()
		correct, err := f.s.verifyLocalPasswordAttempt(t.Context(), "alice", localTestPassword, encoded)
		if !correct || err != nil {
			t.Fatal("successful step-up exhausted failed-guess budget", err)
		}
	}
	bad := func() {
		t.Helper()
		correct, err := f.s.verifyLocalPasswordAttempt(t.Context(), "alice", "Deliberately wrong password", encoded)
		if correct || err != nil {
			t.Fatal("wrong attempt not charged normally", err)
		}
	}
	for range 15 {
		good()
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 0 || global != 15 {
		t.Fatal("successful verification reset global allowance or retained account charges", account, global)
	}
	bad()
	for range 15 {
		good()
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 1 || global != 31 {
		t.Fatal("success erased another failed guess", account, global)
	}
	for range 9 {
		bad()
	}
	if _, err := f.s.verifyLocalPasswordAttempt(t.Context(), "alice", localTestPassword, encoded); !errors.Is(err, errLocalRateLimited) {
		t.Fatal("correct password bypassed accumulated failed budget", err)
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 11 || global != 41 {
		t.Fatal("overflow charges not preserved", account, global)
	}
}

func TestPasswordAttemptActualEnvironmentStepupsPostgres(t *testing.T) {
	f, login, target := environmentFixture(t)
	for i := range 13 {
		input := environmentInput(target)
		input.Name = "Verified environment " + strconv.Itoa(i)
		result, err := environmentSave(t, f, login, input)
		if err != nil || result.Operation.State != "SUCCEEDED" || result.Environment.DeploymentAvailable {
			t.Fatal("actual configuration step-up failed", i, err)
		}
	}
	if account, global := passwordAttempts(t, f.server, "alice"); account != 0 || global != 14 {
		t.Fatal("real login/settings confirmations were not individually charged/refunded", account, global)
	}
}

func TestPasswordAttemptExactWindowAndOnceOnlyPostgres(t *testing.T) {
	f := newManagementFixture(t)
	old, err := f.s.reserveLocalPasswordAttempt(t.Context(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.ExecContext(t.Context(), `UPDATE golf_local_login_limits SET resets_at=clock_timestamp()-interval '1 second' WHERE bucket=$1`, old.bucket); err != nil {
		t.Fatal(err)
	}
	current, err := f.s.reserveLocalPasswordAttempt(t.Context(), "alice")
	if err != nil || old.resetsAt.Equal(current.resetsAt) {
		t.Fatal("fresh window not created", err)
	}
	if err = f.s.releaseLocalPasswordAttempt(t.Context(), old); err != nil {
		t.Fatal(err)
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 1 || global != 2 {
		t.Fatal("expired reservation cleared the new window", account, global)
	}
	if err = f.s.releaseLocalPasswordAttempt(t.Context(), old); !errors.Is(err, errStorageUnavailable) {
		t.Fatal("one reservation was released twice", err)
	}
	if err = f.s.releaseLocalPasswordAttempt(t.Context(), current); err != nil {
		t.Fatal(err)
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 0 || global != 2 {
		t.Fatal("own current reservation/global isolation failed", account, global)
	}
}

func TestPasswordAttemptSaturatedConcurrentChargesPostgres(t *testing.T) {
	f := newManagementFixture(t)
	first, err := f.s.reserveLocalPasswordAttempt(t.Context(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.s.reserveLocalPasswordAttempt(t.Context(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	// Two in-flight valid verifications plus ten failed/denied reservations cap
	// at11. Refunding both successes must not lower ten failures to nine.
	for i := range 10 {
		_, err := f.s.reserveLocalPasswordAttempt(t.Context(), "alice")
		if (i < 8 && err != nil) || (i >= 8 && !errors.Is(err, errLocalRateLimited)) {
			t.Fatal("unexpected saturation admission", i, err)
		}
	}
	for _, reservation := range []*localPasswordAttempt{first, second} {
		if err := f.s.releaseLocalPasswordAttempt(t.Context(), reservation); err != nil {
			t.Fatal(err)
		}
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 11 || global != 12 {
		t.Fatal("saturated overflow was refunded", account, global)
	}
	if _, err := f.s.reserveLocalPasswordAttempt(t.Context(), "alice"); !errors.Is(err, errLocalRateLimited) {
		t.Fatal("saturation reopened failed-guess allowance", err)
	}
}

func TestPasswordAttemptConcurrentSuccessAndFailurePostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", false)
	encoded := passwordAttemptHash(t, f)
	start := make(chan struct{})
	type outcome struct {
		correct bool
		err     error
	}
	results := make(chan outcome, 2)
	for _, password := range []string{localTestPassword, "Deliberately wrong password"} {
		go func(password string) {
			<-start
			correct, err := f.s.verifyLocalPasswordAttempt(t.Context(), "alice", password, encoded)
			results <- outcome{correct, err}
		}(password)
	}
	close(start)
	successes := 0
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.correct {
			successes++
		}
	}
	if account, global := passwordAttempts(t, f.s, "alice"); successes != 1 || account != 1 || global != 2 {
		t.Fatal("concurrent success erased or duplicated the failed charge", successes, account, global)
	}
}

func TestPasswordAttemptCancelledAndStorageReleasePostgres(t *testing.T) {
	f := newManagementFixture(t)
	cancelled, err := f.s.reserveLocalPasswordAttempt(t.Context(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err = f.s.releaseLocalPasswordAttempt(ctx, cancelled); !errors.Is(err, errStorageUnavailable) {
		t.Fatal("cancelled release acknowledged", err)
	}
	failed, err := f.s.reserveLocalPasswordAttempt(t.Context(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.ExecContext(t.Context(), `CREATE FUNCTION password_release_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.attempts<OLD.attempts THEN RAISE EXCEPTION 'Owned refund fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER password_release_fault BEFORE UPDATE ON golf_local_login_limits FOR EACH ROW EXECUTE FUNCTION password_release_fault()`); err != nil {
		t.Fatal(err)
	}
	if err = f.s.releaseLocalPasswordAttempt(t.Context(), failed); !errors.Is(err, errStorageUnavailable) {
		t.Fatal("failed SQL release acknowledged", err)
	}
	if _, err = f.db.ExecContext(t.Context(), `DROP TRIGGER password_release_fault ON golf_local_login_limits; DROP FUNCTION password_release_fault()`); err != nil {
		t.Fatal(err)
	}
	for _, reservation := range []*localPasswordAttempt{cancelled, failed} {
		if err = f.s.releaseLocalPasswordAttempt(t.Context(), reservation); !errors.Is(err, errStorageUnavailable) {
			t.Fatal("failed acknowledgement retried a refund", err)
		}
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 2 || global != 2 {
		t.Fatal("cancelled/failed verification charge erased", account, global)
	}
}

func TestLocalLoginPasswordAttemptFinalAuthorityPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", false)
	previous := ""
	for range 14 {
		result, err := f.s.loginLocalSession(t.Context(), "alice", localTestPassword, previous)
		if err != nil {
			t.Fatal("successful managed login incorrectly exhausted account budget", err)
		}
		previous = result.Value
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 0 || global != 14 {
		t.Fatal("login success cleared global charges", account, global)
	}
	for _, mode := range []int32{1, 2} {
		f.mode.Store(mode)
		if _, err := f.s.loginLocalSession(t.Context(), "alice", localTestPassword, previous); !errors.Is(err, errLocalCredentials) {
			t.Fatal("native replacement/revocation accepted", mode, err)
		}
	}
	f.mode.Store(0)
	if _, err := f.s.loginLocalSession(t.Context(), "alice", localTestPassword, previous); err != nil {
		t.Fatal(err)
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 2 || global != 17 {
		t.Fatal("correct KDF refunded failed native login authority", account, global)
	}
}

func TestPasswordAttemptGlobalCeilingRemainsPostgres(t *testing.T) {
	f := newManagementFixture(t)
	for range 120 {
		reservation, err := f.s.reserveLocalPasswordAttempt(t.Context(), "alice")
		if err != nil {
			t.Fatal("global budget refused early", err)
		}
		if err = f.s.releaseLocalPasswordAttempt(t.Context(), reservation); err != nil {
			t.Fatal(err)
		}
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 0 || global != 120 {
		t.Fatal("account refunds erased global capacity", account, global)
	}
	if _, err := f.s.reserveLocalPasswordAttempt(t.Context(), "alice"); !errors.Is(err, errLocalRateLimited) {
		t.Fatal("successful verifications bypassed global ceiling", err)
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 1 || global != 121 {
		t.Fatal("denied global overflow was refunded", account, global)
	}
}

func TestLocalLoginPasswordAttemptRefundFailurePostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", false)
	old, err := f.s.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.ExecContext(t.Context(), `CREATE FUNCTION password_release_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.attempts<OLD.attempts THEN RAISE EXCEPTION 'Owned refund fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER password_release_fault BEFORE UPDATE ON golf_local_login_limits FOR EACH ROW EXECUTE FUNCTION password_release_fault()`); err != nil {
		t.Fatal(err)
	}
	bound, err := f.s.loginLocalSession(t.Context(), "alice", localTestPassword, old.Value)
	if err != nil || bound.Value == "" || bound.Value == old.Value || bound.User.ID != 42 {
		t.Fatal("committed sign-in became a false failure", err)
	}
	if _, err = f.db.ExecContext(t.Context(), `DROP TRIGGER password_release_fault ON golf_local_login_limits; DROP FUNCTION password_release_fault()`); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.sessionCredential(t.Context(), old.Value); !errors.Is(err, errUnauthenticated) {
		t.Fatal("original session was not replaced", err)
	}
	if _, err = f.s.sessionCredential(t.Context(), bound.Value); err != nil {
		t.Fatal("acknowledged session unavailable", err)
	}
	var sessions, signIns, replacements int
	if err = f.db.QueryRowContext(t.Context(), `SELECT (SELECT count(*) FROM golf_sessions),(SELECT count(*) FROM golf_audit_events WHERE action='SIGN_IN'),(SELECT count(*) FROM golf_audit_events WHERE action='SESSION_REPLACED')`).Scan(&sessions, &signIns, &replacements); err != nil || sessions != 1 || signIns != 2 || replacements != 1 {
		t.Fatal("refund failure retried session effects", err, sessions, signIns, replacements)
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 1 || global != 2 {
		t.Fatal("failed refund erased a charge", account, global)
	}
	if _, err = f.s.loginLocalSession(t.Context(), "alice", localTestPassword, bound.Value); err != nil {
		t.Fatal(err)
	}
	if account, global := passwordAttempts(t, f.s, "alice"); account != 1 || global != 3 {
		t.Fatal("subsequent sign-in cleared an earlier retained charge", account, global)
	}
}

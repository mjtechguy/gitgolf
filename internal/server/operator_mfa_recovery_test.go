package server

import (
	"strings"
	"sync"
	"testing"
)

func operatorMFAInput(account LocalAccountResult) LocalAccountInput {
	return LocalAccountInput{Username: account.Username, AccountID: account.ID, GolfUserID: account.UserID, ExpectedNativeUserID: "42", ExpectedCredentialVersion: account.CredentialVersion, ExpectedMFAVersion: "2", RecoveryReason: "Privileged console recovery after writer drain", AcknowledgeMFAReset: true, WritersDrained: true}
}
func TestOperatorMFARecoveryAdminAndAuditPostgres(t *testing.T) {
	f := newManagementFixture(t)
	account := enrollLocal(t, f, "alice", true)
	_, codes := enableMFATest(t, f, "alice")
	session, _ := recoverySession(t, f, "alice", codes[0])
	_, challenge := recoverySession(t, f, "alice", "")
	input := operatorMFAInput(account)
	observed, e := ManageLocalAccount(t.Context(), f.db, nil, f.s.config.GiteaURL, "inspect", LocalAccountInput{Username: "alice"})
	if e != nil || observed.ID != account.ID || observed.UserID != account.UserID || observed.NativeUserID != "42" || observed.MFAVersion != "2" || !observed.MFAEnabled || !observed.IsInstanceAdmin {
		t.Fatal("privileged readonly version discovery", e)
	}

	for _, change := range []func(*LocalAccountInput){func(v *LocalAccountInput) { v.WritersDrained = false }, func(v *LocalAccountInput) { v.AcknowledgeMFAReset = false }, func(v *LocalAccountInput) { v.ExpectedNativeUserID = "999" }, func(v *LocalAccountInput) { v.AccountID = "999" }, func(v *LocalAccountInput) { v.ExpectedMFAVersion = "3" }, func(v *LocalAccountInput) { v.Password = "private-password" }, func(v *LocalAccountInput) { v.GolfUserID = "999" }} {
		copy := input
		change(&copy)
		if _, e := ManageLocalAccount(t.Context(), f.db, f.s.keyring, f.s.config.GiteaURL, "reset-mfa", copy); e == nil || strings.Contains(e.Error(), "private-password") {
			t.Fatal("operator identity/acknowledgement fence")
		}
	}
	f.mode.Store(1)
	if _, e := ManageLocalAccount(t.Context(), f.db, f.s.keyring, f.s.config.GiteaURL, "reset-mfa", input); e == nil {
		t.Fatal("current native ID substitution accepted")
	}
	f.mode.Store(0)
	out, e := ManageLocalAccount(t.Context(), f.db, f.s.keyring, f.s.config.GiteaURL, "reset-mfa", input)
	if e != nil || !out.IsInstanceAdmin || out.MFAVersion != "3" || out.CredentialVersion != "2" || out.SessionsRevoked != 1 || out.ChallengesRevoked != 1 || out.RecoveryCodesRevoked != 10 || out.OperationID == "" {
		t.Fatal("operator recovery effect", e)
	}
	if _, e = f.s.sessionCredential(t.Context(), session.Value); e == nil {
		t.Fatal("operator old session retained")
	}
	if w := mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": codes[1]}, challenge); w.Code != 401 {
		t.Fatal("operator old challenge retained", w.Code)
	}
	fresh, e := f.s.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil || !fresh.User.IsInstanceAdmin || fresh.MFAChallenge != "" {
		t.Fatal("operator did not preserve password/admin role", e)
	}
	var audit int
	e = f.db.QueryRow(`SELECT count(*) FROM golf_mfa_events WHERE action='operator_reset' AND actor_kind='operator' AND actor_user_id IS NULL AND actor_session_id IS NULL AND account_id=$1 AND user_id=$2 AND operation_id=$3`, account.ID, account.UserID, out.OperationID).Scan(&audit)
	if e != nil || audit != 1 {
		t.Fatal("operator audit impersonated user", e)
	}
	if _, e = ManageLocalAccount(t.Context(), f.db, f.s.keyring, f.s.config.GiteaURL, "reset-mfa", input); e == nil {
		t.Fatal("stale operator reset repeated")
	}
}
func TestOperatorMFARecoveryConcurrencyPostgres(t *testing.T) {
	f := newManagementFixture(t)
	account := enrollLocal(t, f, "alice", true)
	_, _ = enableMFATest(t, f, "alice")
	input := operatorMFAInput(account)
	observed, e := ManageLocalAccount(t.Context(), f.db, nil, f.s.config.GiteaURL, "inspect", LocalAccountInput{Username: "alice"})
	if e != nil || observed.ID != account.ID || observed.UserID != account.UserID || observed.NativeUserID != "42" || observed.MFAVersion != "2" || !observed.MFAEnabled || !observed.IsInstanceAdmin {
		t.Fatal("privileged readonly version discovery", e)
	}

	var group sync.WaitGroup
	out := make(chan error, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			_, e := ManageLocalAccount(t.Context(), f.db, f.s.keyring, f.s.config.GiteaURL, "reset-mfa", input)
			out <- e
		}()
	}
	group.Wait()
	close(out)
	success := 0
	for e := range out {
		if e == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatal("operator recovery race", success)
	}
}

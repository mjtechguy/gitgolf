package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

type ruleFenceFixture struct {
	s          *Server
	native     *ruleMutationFixture
	db         *sql.DB
	session    loginResult
	credential forgeCredential
	ctx        context.Context
	request    *connect.Request[golfv1.MutateRepositoryRulesRequest]
}

func newRuleFenceFixture(t *testing.T) *ruleFenceFixture {
	t.Helper()
	f := &ruleFenceFixture{db: testDatabase(t), native: newRuleMutationFixture(t), credential: forgeCredential{Kind: "pat", Token: "rules-source-only"}}
	var err error
	f.s, err = New(testConfig(f.native.provider.URL), f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.session, err = f.s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", f.credential.Token, "")
	if err != nil {
		t.Fatal(err)
	}
	var cancel context.CancelFunc
	f.ctx, cancel = context.WithCancel(context.WithValue(t.Context(), sessionTokenKey{}, f.credential))
	t.Cleanup(cancel)
	inventory, err := f.s.currentRuleInventory(f.ctx, f.session.Value, f.credential, repositoryKey{"alice", "example"}, "9007199254740993", "42")
	if err != nil {
		t.Fatal(err)
	}
	m := ruleRequestFixture()
	m.ExpectedAccessRevision = inventory.AccessRevision
	m.ExpectedRulesRevision = inventory.RulesRevision
	m.DesiredBranch.RequiredApprovals = "3"
	f.request = connect.NewRequest(m)
	f.request.Header().Set("Origin", f.s.config.PublicURL)
	f.request.Header().Set("Cookie", f.s.sessionCookie(f.session.Value, f.session.Expires, 3600).String())
	return f
}
func (f *ruleFenceFixture) unknown() bool {
	var value bool
	err := f.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM golf_repository_rule_mutations WHERE operation_id=$1 AND phase='DISPATCH_UNKNOWN')`, rulesOperationTestKey).Scan(&value)
	return err == nil && value
}
func ruleFenceWait(t *testing.T, ch <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("did not reach", label)
	}
}
func TestRuleMutationsNativePrewriteLogoutSerializationPostgres(t *testing.T) {
	f := newRuleFenceFixture(t)
	original := f.native.provider.Config.Handler
	entered, release, logoutFinished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var held atomic.Bool
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	f.native.provider.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/api/v1/repos/alice/example" && f.unknown() && held.CompareAndSwap(false, true) {
			close(entered)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		// The dispatch transaction releases its user/session locks before postflight.
		// Force postflight behind the already-queued logout to verify private refusal.
		if r.Method == "GET" && r.URL.Path == "/api/v1/user" && f.native.writes.Load() > 0 {
			select {
			case <-logoutFinished:
			case <-r.Context().Done():
				return
			}
		}
		original.ServeHTTP(w, r)
	})
	done := make(chan error, 1)
	go func() { _, err := f.s.MutateRepositoryRules(f.ctx, f.request); done <- err }()
	ruleFenceWait(t, entered, "held native prewrite metadata")
	logoutDone := make(chan error, 1)
	go func() {
		err := f.s.logoutSession(t.Context(), f.session.Value)
		logoutDone <- err
		close(logoutFinished)
	}()
	waitManagementLock(t, f.db, "LockLogoutUser", 1)
	select {
	case err := <-logoutDone:
		t.Fatal("logout passed the held mutation", err)
	default:
	}
	if f.native.writes.Load() != 0 {
		t.Fatal("write occurred before held native metadata released")
	}
	unblock()
	select {
	case err := <-logoutDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("logout failed to complete")
	}
	select {
	case err := <-done:
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("private receipt survived completed logout", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("mutation did not finish after logout")
	}
	if f.native.writes.Load() != 1 || !f.unknown() {
		t.Fatal("accepted native write lost original uncertainty")
	}
	var activity int
	if err := f.db.QueryRow(`SELECT count(*) FROM golf_repository_activity WHERE repository_id=9007199254740993`).Scan(&activity); err != nil || activity != 0 {
		t.Fatal("revoked postflight emitted success activity", activity, err)
	}
}
func TestRuleMutationsQueuedArchiveDoesNotDeadlockNativeWritePostgres(t *testing.T) {
	f := newRuleFenceFixture(t)
	original := f.native.provider.Config.Handler
	entered, release := make(chan struct{}), make(chan struct{})
	var held atomic.Bool
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	f.native.provider.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/api/v1/repos/alice/example" && f.unknown() && held.CompareAndSwap(false, true) {
			close(entered)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		original.ServeHTTP(w, r)
	})
	done := make(chan error, 1)
	go func() {
		result, err := f.s.MutateRepositoryRules(f.ctx, f.request)
		if err == nil && (result.Msg.Operation.Phase != "SUCCEEDED" || result.Msg.CurrentRules == nil) {
			err = connect.NewError(connect.CodeInternal, errors.New("required receipt or active intent absent"))
		}
		done <- err
	}()
	ruleFenceWait(t, entered, "held native metadata")
	archiveDone := make(chan error, 1)
	go func() {
		tx, err := f.db.BeginTx(t.Context(), nil)
		if err != nil {
			archiveDone <- err
			return
		}
		defer tx.Rollback()
		_, err = tx.ExecContext(t.Context(), `-- name: RuleArchiveExclusiveWaiter
SELECT golf_repository_lifecycle_lock($1,$2,true)`, f.s.config.ForgeURL, int64(9007199254740993))
		if err == nil {
			var active int64
			err = tx.QueryRowContext(t.Context(), `SELECT golf_repository_lifecycle_active($1,$2)`, f.s.config.ForgeURL, int64(9007199254740993)).Scan(&active)
			if err == nil && active < 1 {
				err = connect.NewError(connect.CodeInternal, errors.New("required receipt or active intent absent"))
			}
		}
		archiveDone <- err
	}()
	waitManagementLock(t, f.db, "RuleArchiveExclusiveWaiter", 1)
	unblock()
	select {
	case err := <-archiveDone:
		if err != nil {
			t.Fatal("archive failed to observe the original unknown intent", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("exclusive waiter retained a nested shared-lock deadlock")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal("write/readback did not complete", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("outcome transaction retained a nested shared-lock deadlock")
	}
	if f.native.writes.Load() != 1 {
		t.Fatal("queued archive altered native dispatch count")
	}
}
func TestRuleMutationsRevocationBeforeDispatchLocksHasNoNativeEffectPostgres(t *testing.T) {
	f := newRuleFenceFixture(t)
	original := f.native.provider.Config.Handler
	entered, release := make(chan struct{}), make(chan struct{})
	var held atomic.Bool
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	f.native.provider.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/api/v1/user" && f.unknown() && held.CompareAndSwap(false, true) {
			close(entered)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		original.ServeHTTP(w, r)
	})
	done := make(chan error, 1)
	go func() { _, err := f.s.MutateRepositoryRules(f.ctx, f.request); done <- err }()
	ruleFenceWait(t, entered, "native identity before dispatch lock")
	if err := f.s.logoutSession(t.Context(), f.session.Value); err != nil {
		t.Fatal(err)
	}
	unblock()
	select {
	case err := <-done:
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("revoked session dispatched or exposed a receipt", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("revoked operation did not finish")
	}
	if f.native.writes.Load() != 0 || !f.unknown() {
		t.Fatal("revocation erased durable reservation or dispatched a native write")
	}
	// A fresh session may inspect the same managed actor's original key only.
	session, err := f.s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", f.credential.Token, "")
	if err != nil {
		t.Fatal(err)
	}
	q := connect.NewRequest(&golfv1.GetRepositoryRuleMutationRequest{Repository: f.request.Msg.Repository, RepositoryId: f.request.Msg.RepositoryId, OwnerId: f.request.Msg.OwnerId, OperationId: rulesOperationTestKey})
	q.Header().Set("Origin", f.s.config.PublicURL)
	q.Header().Set("Cookie", f.s.sessionCookie(session.Value, session.Expires, 3600).String())
	receipt, err := f.s.GetRepositoryRuleMutation(f.ctx, q)
	if err != nil || receipt.Msg.Operation.Phase != "DISPATCH_UNKNOWN" || f.native.writes.Load() != 0 {
		t.Fatal("status inspection resumed a revoked original", receipt, err)
	}
}

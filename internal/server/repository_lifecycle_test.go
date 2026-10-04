package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestRepositoryLifecycleWritePaths(t *testing.T) {
	for _, c := range []struct {
		method, path string
		scoped       bool
		owner, name  string
	}{
		{"PATCH", "/repos/alice/example", true, "alice", "example"},
		{"PUT", "/repos/alice/example/contents/file", true, "alice", "example"},
		{"DELETE", "/teams/17/repos/alice/example", true, "alice", "example"},
		{"GET", "/repos/alice/example", false, "", ""},
		{"POST", "/user/repos", false, "", ""},
		{"PATCH", "/teams/17", false, "", ""},
	} {
		key, scoped, err := lifecycleWriteRepository(c.method, c.path)
		if err != nil || scoped != c.scoped || key.Owner != c.owner || key.Name != c.name {
			t.Fatal(c, key, scoped, err)
		}
	}
	for _, path := range []string{"/teams/01/repos/alice/example", "/repos/alice/.."} {
		if _, _, err := lifecycleWriteRepository("DELETE", path); err == nil {
			t.Fatal("unvalidated mutation path", path)
		}
	}
	for _, c := range []struct{ repo, owner, rev string }{{"01", "42", ""}, {"17", "00", ""}, {"17", "42", strings.Repeat("A", 64)}} {
		if lifecycleTarget(repositoryKey{"alice", "example"}, c.repo, c.owner, c.rev) == nil {
			t.Fatal("invalid immutable target accepted")
		}
	}
	closed, released := 0, 0
	body := &lifecycleBody{ReadCloser: lifecycleTestBody{close: func() { closed++ }}, release: func() { released++ }}
	body.Close()
	body.Close()
	if released != 1 || closed != 2 {
		t.Fatal("permit release not once-only", released, closed)
	}
}

type lifecycleTestBody struct{ close func() }

func (lifecycleTestBody) Read([]byte) (int, error) { return 0, io.EOF }
func (b lifecycleTestBody) Close() error           { b.close(); return nil }

type repositoryLifecycleFixture struct {
	mu         sync.Mutex
	row        forgeRepositorySettings
	mode       string
	writes     int
	s          *Server
	session    loginResult
	credential forgeCredential
}

func newRepositoryLifecycleFixture(t *testing.T) *repositoryLifecycleFixture {
	t.Helper()
	f := &repositoryLifecycleFixture{row: settingsFixtureRow()}
	f.row.HTMLURL = "http://forge.invalid/alice/example"
	db := testDatabase(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
			return
		case "/api/v1/user":
			json.NewEncoder(w).Encode(User{ID: 42, Login: "alice"})
			return
		case "/api/v1/users/search":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{{ID: 42, Login: "alice"}}})
			return
		}
		if r.URL.Path != "/api/v1/repos/alice/example" {
			w.WriteHeader(404)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.mode == "denied" {
			w.WriteHeader(404)
			return
		}
		if r.Method == "GET" {
			json.NewEncoder(w).Encode(lifecycleNativeRepository{forgeRepositorySettings: f.row, NativeActions: lifecycleActionsFixture(f.mode)})
			return
		}
		if r.Method != "PATCH" {
			w.WriteHeader(405)
			return
		}
		var patch map[string]bool
		if json.NewDecoder(r.Body).Decode(&patch) != nil || len(patch) != 1 {
			t.Error("unexpected archive body")
			w.WriteHeader(400)
			return
		}
		archived, ok := patch["archived"]
		if !ok {
			t.Error("nonarchive write")
			w.WriteHeader(400)
			return
		}
		f.writes++
		f.row.Archived = &archived
		if f.mode == "lost" {
			w.WriteHeader(500)
			return
		}
		if f.mode == "mismatch" {
			x := f.row
			x.ID++
			json.NewEncoder(w).Encode(lifecycleNativeRepository{forgeRepositorySettings: x, NativeActions: lifecycleActionsFixture(f.mode)})
			return
		}
		json.NewEncoder(w).Encode(lifecycleNativeRepository{forgeRepositorySettings: f.row, NativeActions: lifecycleActionsFixture(f.mode)})
		if f.mode == "deny-after" {
			f.mode = "denied"
		}
	}))
	t.Cleanup(provider.Close)
	var err error
	f.s, err = New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	mf := &managementFixture{s: f.s, db: db}
	enrollLocal(t, mf, "alice", false)
	f.session = localLogin(t, mf, "alice")
	f.credential, err = f.s.sessionCredential(t.Context(), f.session.Value)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *repositoryLifecycleFixture) ctx(t *testing.T) context.Context {
	return context.WithValue(t.Context(), sessionTokenKey{}, f.credential)
}
func (f *repositoryLifecycleFixture) header(h http.Header) {
	h.Set("Origin", f.s.config.PublicURL)
	h.Set("Cookie", f.s.sessionCookie(f.session.Value, f.session.Expires, 3600).String())
}
func (f *repositoryLifecycleFixture) get(t *testing.T) *golfv1.RepositoryLifecycle {
	t.Helper()
	r := connect.NewRequest(&golfv1.GetRepositoryLifecycleRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "9007199254740993"})
	f.header(r.Header())
	out, e := f.s.GetRepositoryLifecycle(f.ctx(t), r)
	if e != nil {
		t.Fatal(e)
	}
	return out.Msg.Lifecycle
}
func (f *repositoryLifecycleFixture) change(t *testing.T, l *golfv1.RepositoryLifecycle, key string, desired bool, password string) (*golfv1.ChangeRepositoryArchiveStateResponse, error) {
	t.Helper()
	r := connect.NewRequest(&golfv1.ChangeRepositoryArchiveStateRequest{Repository: l.Repository, RepositoryId: l.RepositoryId, OwnerId: l.OwnerId, ExpectedRevision: l.Revision, Archived: &desired, ConfirmationName: "alice/example", CurrentPassword: password, IdempotencyKey: key})
	f.header(r.Header())
	out, e := f.s.ChangeRepositoryArchiveState(f.ctx(t), r)
	if e != nil {
		return nil, e
	}
	return out.Msg, nil
}
func (f *repositoryLifecycleFixture) operation(t *testing.T, key string) (*golfv1.RepositoryLifecycleOperation, error) {
	t.Helper()
	r := connect.NewRequest(&golfv1.GetRepositoryLifecycleOperationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "9007199254740993", OwnerId: "42", IdempotencyKey: key})
	f.header(r.Header())
	out, e := f.s.GetRepositoryLifecycleOperation(f.ctx(t), r)
	if e != nil {
		return nil, e
	}
	return out.Msg.Operation, nil
}
func TestRepositoryLifecycleArchivePostgres(t *testing.T) {
	f := newRepositoryLifecycleFixture(t)
	before := f.get(t)
	if !before.CanManage || !before.ArchiveAvailable || before.ActiveWorkCount != "0" {
		t.Fatal("initial capability", before)
	}
	key := "6c38174c-a431-4a01-93ce-000000000001"
	if _, e := f.change(t, before, key, true, "Wrong password long enough"); !errors.Is(e, errPasswordConfirmation) && connect.CodeOf(e) != connect.CodePermissionDenied {
		t.Fatal("wrong stepup", e)
	}
	if f.writes != 0 {
		t.Fatal("wrong password wrote")
	}
	result, e := f.change(t, before, key, true, localTestPassword)
	if e != nil || result.Operation.Phase != "SUCCEEDED" || result.Lifecycle == nil || !result.Lifecycle.Archived {
		t.Fatal("archive", e, result)
	}
	if f.writes != 1 || !f.get(t).UnarchiveAvailable {
		t.Fatal("readback or count")
	}
	// Replays inspect the durable result, without step-up or native redispatch.
	replay, e := f.change(t, before, key, true, "")
	if e != nil || replay.Operation.Phase != "SUCCEEDED" || replay.Lifecycle != nil || f.writes != 1 {
		t.Fatal("replay", e)
	}
	if _, e = f.change(t, before, key, false, localTestPassword); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("changed intent replay", e)
	}
	current := f.get(t)
	unarchive, e := f.change(t, current, "6c38174c-a431-4a01-93ce-000000000002", false, localTestPassword)
	if e != nil || unarchive.Operation.Phase != "SUCCEEDED" || f.writes != 2 || f.get(t).Archived {
		t.Fatal("unarchive", e)
	}
	var activities, events int
	if e = f.s.db.QueryRow("SELECT count(*) FROM golf_repository_activity WHERE forge_url=$1 AND repository_id=$2", f.s.config.GiteaURL, int64(9007199254740993)).Scan(&activities); e != nil {
		t.Fatal(e)
	}
	if e = f.s.db.QueryRow("SELECT count(*) FROM golf_repository_lifecycle_events").Scan(&events); e != nil {
		t.Fatal(e)
	}
	if activities != 2 || events != 6 {
		t.Fatal("once-only events", activities, events)
	}
}
func TestRepositoryLifecycleUnknownPostgres(t *testing.T) {
	for _, mode := range []string{"lost", "mismatch"} {
		t.Run(mode, func(t *testing.T) {
			f := newRepositoryLifecycleFixture(t)
			before := f.get(t)
			f.mode = mode
			key := "6c38174c-a431-4a01-93ce-000000000003"
			result, e := f.change(t, before, key, true, localTestPassword)
			if e != nil || result.Operation.Phase != "DISPATCH_UNKNOWN" || f.writes != 1 {
				t.Fatal("uncertain native effect", e, result)
			}
			observed := f.get(t)
			if !observed.Unresolved || observed.ArchiveAvailable || observed.UnarchiveAvailable {
				t.Fatal("unknown grants action")
			}
			if _, e = f.change(t, observed, "6c38174c-a431-4a01-93ce-000000000004", false, localTestPassword); connect.CodeOf(e) != connect.CodeFailedPrecondition {
				t.Fatal("new intent during uncertainty", e)
			}
			replay, e := f.change(t, before, key, true, "")
			if e != nil || replay.Operation.Phase != "DISPATCH_UNKNOWN" || f.writes != 1 {
				t.Fatal("unknown replay", e)
			}
			f.mode = "denied"
			if _, e = f.operation(t, key); e == nil {
				t.Fatal("private receipt after access loss")
			}
			f.mode = ""
			operation, e := f.operation(t, key)
			if e != nil || operation.Phase != "DISPATCH_UNKNOWN" {
				t.Fatal("inspection after restoration", e)
			}
			var count int
			f.s.db.QueryRow("SELECT count(*) FROM golf_repository_activity").Scan(&count)
			if count != 0 {
				t.Fatal("unknown activity")
			}
		})
	}
}
func TestRepositoryLifecycleStaleAndAuthorityPostgres(t *testing.T) {
	f := newRepositoryLifecycleFixture(t)
	before := f.get(t)
	f.row.Description = "External change"
	result, e := f.change(t, before, "6c38174c-a431-4a01-93ce-000000000005", true, localTestPassword)
	if e != nil || result.Operation.Phase != "REJECTED" || f.writes != 0 {
		t.Fatal("stale refused", e)
	}
	before = f.get(t)
	f.row.Permissions.Admin = false
	if f.get(t).CanManage {
		t.Fatal("reader owner can manage")
	}
	if _, e = f.change(t, before, "6c38174c-a431-4a01-93ce-000000000006", true, localTestPassword); connect.CodeOf(e) != connect.CodePermissionDenied || f.writes != 0 {
		t.Fatal("authority", e)
	}
	f.row.Permissions.Admin = true
	f.row.Owner.ID = 84
	if _, e = f.change(t, before, "6c38174c-a431-4a01-93ce-000000000007", true, localTestPassword); connect.CodeOf(e) != connect.CodeFailedPrecondition || f.writes != 0 {
		t.Fatal("owner identity", e)
	}
}
func TestRepositoryLifecycleWriteGatePostgres(t *testing.T) {
	f := newRepositoryLifecycleFixture(t)
	ctx := f.ctx(t)
	request, _ := http.NewRequestWithContext(ctx, "PUT", "http://native.invalid", nil)
	release, e := f.s.beginRepositoryLifecycleWrite(ctx, "PUT", "/repos/alice/example/contents/a", f.credential, nil, request)
	if e != nil {
		t.Fatal(e)
	}
	blocked := make(chan error, 1)
	go func() {
		_, e := f.s.db.ExecContext(ctx, "SELECT golf_repository_lifecycle_lock($1,$2,true)", f.s.config.GiteaURL, int64(9007199254740993))
		blocked <- e
	}()
	select {
	case <-blocked:
		t.Fatal("exclusive admission bypassed open response")
	case <-time.After(50 * time.Millisecond):
	}
	release()
	release()
	select {
	case e := <-blocked:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("native response close leaked gate")
	}
	before := f.get(t)
	result, e := f.change(t, before, "6c38174c-a431-4a01-93ce-000000000008", true, localTestPassword)
	if e != nil || result.Operation.Phase != "SUCCEEDED" {
		t.Fatal(e)
	}
	release, e = f.s.beginRepositoryLifecycleWrite(ctx, "PUT", "/repos/alice/example/contents/a", f.credential, nil, request)
	if e == nil {
		release()
		t.Fatal("archived native direct write allowed")
	}
	if !errors.Is(e, errLifecycleBlocked) {
		t.Fatal(e)
	}
}

func TestRepositoryLifecycleBrowserCaller(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, managementToken())
	for _, variant := range []string{"origin", "bearer", "delegated", "session"} {
		r := connect.NewRequest(&golfv1.GetRepositoryLifecycleRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "17"})
		r.Header().Set("Origin", s.config.PublicURL)
		r.Header().Set("Cookie", "golf_session=fixture")
		callCtx := ctx
		switch variant {
		case "origin":
			r.Header().Set("Origin", "https://other.invalid")
		case "bearer":
			r.Header().Set("Authorization", "Bearer fixture")
		case "delegated":
			callCtx = context.WithValue(ctx, apiAuthKey{}, apiAuth{})
		case "session":
			r.Header().Del("Cookie")
		}
		_, e = s.GetRepositoryLifecycle(callCtx, r)
		expected := connect.CodePermissionDenied
		if variant == "session" {
			expected = connect.CodeUnauthenticated
		}
		if connect.CodeOf(e) != expected {
			t.Fatal(variant, e)
		}
	}
}
func TestRepositoryLifecycleAdmissionRacePostgres(t *testing.T) {
	f := newRepositoryLifecycleFixture(t)
	ctx := t.Context()
	var userID int64
	if e := f.s.db.QueryRow("SELECT id FROM golf_users WHERE forge_user_id=42").Scan(&userID); e != nil {
		t.Fatal(e)
	}
	admissionSQL := `INSERT INTO golf_issue_mutations(user_id,actor_forge_user_id,idempotency_key,payload_fingerprint,kind,repository_id,repository_owner,repository_name,issue_id,issue_number,state) VALUES($1,42,$2,decode(repeat('00',32),'hex'),'CREATE_ISSUE',9007199254740993,'alice','example',0,0,'OUTCOME_UNKNOWN')`
	// A committed lifecycle reservation is visible only after its exclusive lock
	// is released; an already waiting admission must then refuse, not slip past.
	tx, e := f.s.db.BeginTx(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, "SELECT golf_repository_lifecycle_lock($1,$2,true)", f.s.config.GiteaURL, int64(9007199254740993)); e != nil {
		t.Fatal(e)
	}
	lifecycleSQL := `INSERT INTO golf_repository_lifecycle_operations(user_id,forge_url,actor_id,idempotency_key,repository_id,owner_id,repository_owner,repository_name,expected_revision,from_archived,to_archived,fingerprint) VALUES($1,$2,42,$3,9007199254740993,42,'alice','example',repeat('a',64),false,true,decode(repeat('00',32),'hex'))`
	if _, e = tx.ExecContext(ctx, lifecycleSQL, userID, f.s.config.GiteaURL, "6c38174c-a431-4a01-93ce-000000000009"); e != nil {
		t.Fatal(e)
	}
	waiting := make(chan error, 1)
	go func() {
		_, e := f.s.db.ExecContext(ctx, admissionSQL, userID, "6c38174c-a431-4a01-93ce-000000000010")
		waiting <- e
	}()
	select {
	case e := <-waiting:
		t.Fatal("admission passed exclusive lifecycle reservation", e)
	case <-time.After(50 * time.Millisecond):
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-waiting:
		var state interface{ SQLState() string }
		if !errors.As(e, &state) || state.SQLState() != "55000" {
			t.Fatal("waiting admission not refused", e)
		}
	case <-time.After(time.Second):
		t.Fatal("admission stuck")
	}
	var n int
	if e = f.s.db.QueryRow("SELECT count(*) FROM golf_issue_mutations").Scan(&n); e != nil || n != 0 {
		t.Fatal("refused work was stored", e, n)
	}
	// An unresolved record is durable and cannot be bypassed by a second key.
	if _, e = f.s.db.ExecContext(ctx, lifecycleSQL, userID, f.s.config.GiteaURL, "6c38174c-a431-4a01-93ce-000000000011"); e == nil {
		t.Fatal("second unresolved operation inserted")
	}
	if _, e = f.s.db.ExecContext(ctx, "DELETE FROM golf_repository_lifecycle_operations"); e == nil {
		t.Fatal("durable operation deleted")
	}
	if _, e = f.s.db.ExecContext(ctx, "UPDATE golf_repository_lifecycle_operations SET owner_id=99"); e == nil {
		t.Fatal("durable identity changed")
	}
}
func TestRepositoryLifecycleActiveWorkRefusalPostgres(t *testing.T) {
	f := newRepositoryLifecycleFixture(t)
	var userID int64
	f.s.db.QueryRow("SELECT id FROM golf_users WHERE forge_user_id=42").Scan(&userID)
	_, e := f.s.db.Exec(`INSERT INTO golf_issue_mutations(user_id,actor_forge_user_id,idempotency_key,payload_fingerprint,kind,repository_id,repository_owner,repository_name,issue_id,issue_number,state) VALUES($1,42,'6c38174c-a431-4a01-93ce-000000000012',decode(repeat('00',32),'hex'),'CREATE_ISSUE',9007199254740993,'alice','example',0,0,'OUTCOME_UNKNOWN')`, userID)
	if e != nil {
		t.Fatal(e)
	}
	before := f.get(t)
	if before.ArchiveAvailable || before.ActiveWorkCount != "1" || before.BlockedReason != "active_work" {
		t.Fatal("active work observation", before)
	}
	result, e := f.change(t, before, "6c38174c-a431-4a01-93ce-000000000013", true, localTestPassword)
	if e != nil || result.Operation.Phase != "REJECTED" || f.writes != 0 {
		t.Fatal("active work wrote", e)
	}
	var count int
	f.s.db.QueryRow("SELECT count(*) FROM golf_repository_activity WHERE topic='source'").Scan(&count)
	if count != 0 {
		t.Fatal("refusal emitted source activity")
	}
}

func TestRepositoryLifecyclePasswordRefusalMarker(t *testing.T) {
	var ce *connect.Error
	e := lifecycleRPCError(errPasswordConfirmation)
	if !errors.As(e, &ce) || ce.Code() != connect.CodePermissionDenied || ce.Meta().Get("Golf-Lifecycle-Effect") != "none" {
		t.Fatal(e)
	}
	for _, e := range []error{errLifecycleBlocked, errStorageUnavailable, errUnauthenticated} {
		ce = nil
		converted := lifecycleRPCError(e)
		if errors.As(converted, &ce) && ce.Meta().Get("Golf-Lifecycle-Effect") != "" {
			t.Fatal("unproven no-effect marker", e)
		}
	}
}
func TestRepositoryLifecyclePostflightDenialPostgres(t *testing.T) {
	f := newRepositoryLifecycleFixture(t)
	before := f.get(t)
	f.mode = "deny-after"
	key := "6c38174c-a431-4a01-93ce-000000000014"
	if result, e := f.change(t, before, key, true, localTestPassword); connect.CodeOf(e) != connect.CodeNotFound || result != nil || f.writes != 1 {
		t.Fatal("late authority loss exposed receipt", e, result)
	}
	f.mode = ""
	op, e := f.operation(t, key)
	if e != nil || op.Phase != "DISPATCH_UNKNOWN" {
		t.Fatal("durable unknown lost", e, op)
	}
}

func lifecycleActionsFixture(mode string) *bool {
	if mode == "actions-unknown" {
		return nil
	}
	enabled := mode == "actions-enabled"
	return &enabled
}
func TestRepositoryLifecycleNativeActionsPostgres(t *testing.T) {
	for _, mode := range []string{"actions-enabled", "actions-unknown"} {
		t.Run(mode, func(t *testing.T) {
			f := newRepositoryLifecycleFixture(t)
			f.mode = mode
			observed := f.get(t)
			if observed.ArchiveAvailable || observed.UnarchiveAvailable || observed.BlockedReason != "native_actions_unqualified" {
				t.Fatal("unqualified native scheduler enabled archive", observed)
			}
			result, e := f.change(t, observed, "6c38174c-a431-4a01-93ce-000000000015", true, localTestPassword)
			if e != nil || result.Operation.Phase != "REJECTED" || f.writes != 0 {
				t.Fatal("native scheduler wrote", e, result)
			}
		})
	}
}

func TestRepositoryLifecycleExternalUnarchiveDriftPostgres(t *testing.T) {
	f := newRepositoryLifecycleFixture(t)
	before := f.get(t)
	result, e := f.change(t, before, "6c38174c-a431-4a01-93ce-000000000016", true, localTestPassword)
	if e != nil || result.Operation.Phase != "SUCCEEDED" {
		t.Fatal(e)
	}
	// An out-of-Golf unarchive is observed, not silently adopted as a release of
	// Golf's durable archived admission latch.
	off := false
	f.row.Archived = &off
	drift := f.get(t)
	if drift.Archived || drift.ArchiveAvailable || drift.UnarchiveAvailable || drift.BlockedReason != "managed_archive_fence" {
		t.Fatal("external edit silently cleared admission", drift)
	}
	result, e = f.change(t, drift, "6c38174c-a431-4a01-93ce-000000000017", true, localTestPassword)
	if e != nil || result.Operation.Phase != "REJECTED" || f.writes != 1 {
		t.Fatal("drift dispatched", e, result)
	}
}

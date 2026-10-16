package server

import (
	"context"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestActivityBoundary(t *testing.T) {
	s, e := New(testConfig("http://forgejo.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
		r := httptest.NewRequest("POST", "/rpc"+golfv1connect.RepositoryActivityServiceWatchRepositoryProcedure, strings.NewReader("malformed"))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/connect+json")
		r.Header.Set("Connect-Protocol-Version", "1")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		want := `"code":"unauthenticated"`
		if origin != s.config.PublicURL {
			want = `"code":"permission_denied"`
		}
		if !strings.Contains(w.Body.String(), want) || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("stream boundary", w.Code)
		}
	}
}
func activityClient(t *testing.T, f *pullFixture, session loginResult) golfv1connect.RepositoryActivityServiceClient {
	t.Helper()
	server := httptest.NewServer(f.s)
	t.Cleanup(server.Close)
	// Streaming interceptors differ from unary interceptors; set Origin on the
	// request itself, exactly as the browser's same-origin Fetch does.
	c := server.Client()
	c.Timeout = 15 * time.Second
	return golfv1connect.NewRepositoryActivityServiceClient(c, server.URL+"/rpc")
}
func activityRequest(f *pullFixture, session loginResult, cursor string) *connect.Request[golfv1.WatchRepositoryRequest] {
	r := connect.NewRequest(&golfv1.WatchRepositoryRequest{Repository: pullKey, RepositoryId: "11", Cursor: cursor})
	r.Header().Set("Origin", f.s.config.PublicURL)
	r.Header().Set("Cookie", f.s.sessionCookie(session.Value, session.Expires, 3600).String())
	return r
}
func appendActivity(t *testing.T, f *pullFixture, repo, user int64, topic string) string {
	t.Helper()
	if _, e := f.db.Exec("SELECT golf_append_repository_activity($1,$2,$3,$4)", f.s.config.ForgeURL, repo, user, topic); e != nil {
		t.Fatal(e)
	}
	var id int64
	if e := f.db.QueryRow("SELECT max(id) FROM golf_repository_activity WHERE forge_url=$1 AND repository_id=$2", f.s.config.ForgeURL, repo).Scan(&id); e != nil {
		t.Fatal(e)
	}
	return strconv.FormatInt(id, 10)
}
func TestActivityStreamPostgres(t *testing.T) {
	f := newPullFixture(t)
	session := f.session(t, "pat")
	client := activityClient(t, f, session)
	start := appendActivity(t, f, 11, 0, "issues")
	appendActivity(t, f, 12, 0, "source")
	appendActivity(t, f, 11, 99999, "agents")
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	stream, e := client.WatchRepository(ctx, activityRequest(f, session, ""))
	if e != nil {
		t.Fatal(e)
	}
	defer stream.Close()
	if !stream.Receive() {
		t.Fatal("no initial stream frame", stream.Err())
	}
	first := stream.Msg()
	if first.Kind != "reset" || first.Cursor != start || first.RepositoryId != "11" || len(first.Topics) != 0 {
		t.Fatal("initial scope", first)
	}
	if stream.ResponseHeader().Get("Cache-Control") != "no-store" || stream.ResponseHeader().Get("X-Accel-Buffering") != "no" {
		t.Fatal("missing private/proxy headers")
	}
	id := appendActivity(t, f, 11, 0, "pulls")
	if !stream.Receive() {
		t.Fatal("no change", stream.Err())
	}
	if m := stream.Msg(); m.Kind != "change" || m.Cursor != id || len(m.Topics) != 1 || m.Topics[0] != "pulls" {
		t.Fatal("scope/replay", m)
	}
	hash, _ := sessionHash(session.Value)
	if _, e = f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); e != nil {
		t.Fatal(e)
	}
	if stream.Receive() || connect.CodeOf(stream.Err()) != connect.CodeUnauthenticated {
		t.Fatal("session revocation did not end stream", stream.Err())
	}
}
func TestActivityCursorPostgres(t *testing.T) {
	f := newPullFixture(t)
	session := f.session(t, "pat")
	client := activityClient(t, f, session)
	start := appendActivity(t, f, 11, 0, "issues")
	last := appendActivity(t, f, 11, 0, "actions")
	for _, cursor := range []string{"00", "01", "+0", " 0", "-1", "9223372036854775808", appendActivity(t, f, 12, 0, "source"), appendActivity(t, f, 11, 99999, "agents")} {
		stream, e := client.WatchRepository(context.Background(), activityRequest(f, session, cursor))
		if e == nil {
			stream.Receive()
			e = stream.Err()
			stream.Close()
		}
		if connect.CodeOf(e) != connect.CodeInvalidArgument {
			t.Fatal("accepted cursor outside caller/scope", cursor, e)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, e := client.WatchRepository(ctx, activityRequest(f, session, start))
	if e != nil {
		t.Fatal(e)
	}
	defer stream.Close()
	if !stream.Receive() {
		t.Fatal(stream.Err())
	}
	if m := stream.Msg(); m.Kind != "change" || m.Cursor != last || len(m.Topics) != 1 || m.Topics[0] != "actions" {
		t.Fatal("resume dropped events", m)
	}
}
func TestActivityCommitOrderPostgres(t *testing.T) {
	f := newPullFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, e := f.db.BeginTx(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, "SELECT golf_append_repository_activity($1,11,0,'issues')", f.s.config.ForgeURL); e != nil {
		t.Fatal(e)
	}
	var first int64
	if e = tx.QueryRowContext(ctx, "SELECT max(id) FROM golf_repository_activity").Scan(&first); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() {
		_, e := f.db.ExecContext(ctx, "SELECT golf_append_repository_activity($1,11,0,'pulls')", f.s.config.ForgeURL)
		done <- e
	}()
	select {
	case e := <-done:
		t.Fatal("second writer passed uncommitted cursor", e)
	case <-time.After(100 * time.Millisecond):
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	var last int64
	if e = f.db.QueryRow("SELECT max(id) FROM golf_repository_activity").Scan(&last); e != nil || last <= first {
		t.Fatal("cursor commit order", e)
	}
	rollback, e := f.db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	if _, e = rollback.Exec("SELECT golf_append_repository_activity($1,11,0,'source')", f.s.config.ForgeURL); e != nil {
		t.Fatal(e)
	}
	if e = rollback.Rollback(); e != nil {
		t.Fatal(e)
	}
	var count int
	if e = f.db.QueryRow("SELECT count(*) FROM golf_repository_activity").Scan(&count); e != nil || count != 2 {
		t.Fatal("rolled-back event escaped", e, count)
	}
}
func TestActivityLimits(t *testing.T) {
	s := &Server{}
	for i := 0; i < 4; i++ {
		if !s.admitActivity(1) {
			t.Fatal("admission")
		}
	}
	if s.admitActivity(1) {
		t.Fatal("user limit")
	}
	for i := int64(2); i <= 29; i++ {
		if !s.admitActivity(i) {
			t.Fatal("total admission")
		}
	}
	if s.admitActivity(30) {
		t.Fatal("server limit")
	}
	s.releaseActivity(1)
	if !s.admitActivity(30) {
		t.Fatal("cancellation slot not reusable")
	}
}

// An empty durable history has a resumable watermark, not a fresh subscription.
// Exercise the real ten-second rotation and a first event committed between
// streams; neither global sequence gaps nor other recipients belong to this read.
func TestActivityEmptyWatermarkPostgres(t *testing.T) {
	f := newPullFixture(t)
	session := f.session(t, "pat")
	client := activityClient(t, f, session)
	appendActivity(t, f, 12, 0, "source")
	appendActivity(t, f, 11, 99999, "agents")
	ctx, cancel := context.WithTimeout(context.Background(), 14*time.Second)
	defer cancel()
	stream, e := client.WatchRepository(ctx, activityRequest(f, session, ""))
	if e != nil {
		t.Fatal(e)
	}
	resets, heartbeats, rotations := 0, 0, 0
	for stream.Receive() {
		m := stream.Msg()
		if m.RepositoryId != "11" || m.Cursor != "0" || len(m.Topics) != 0 {
			t.Fatal("empty watermark scope", m)
		}
		switch m.Kind {
		case "reset":
			resets++
		case "heartbeat":
			heartbeats++
		case "reconnect":
			rotations++
		default:
			t.Fatal("unexpected empty-history event", m)
		}
	}
	if stream.Err() != nil || resets != 1 || heartbeats == 0 || rotations != 1 {
		t.Fatal("idle stream rotation", resets, heartbeats, rotations, stream.Err())
	}
	stream.Close()
	resumeCtx, resumeCancel := context.WithCancel(context.Background())
	resumed, e := client.WatchRepository(resumeCtx, activityRequest(f, session, "0"))
	if e != nil {
		t.Fatal(e)
	}
	if !resumed.Receive() {
		t.Fatal("zero resume", resumed.Err())
	}
	if m := resumed.Msg(); m.Kind != "heartbeat" || m.Cursor != "0" || len(m.Topics) != 0 {
		t.Fatal("zero was reset", m)
	}
	resumeCancel()
	resumed.Close()
	first := appendActivity(t, f, 11, 0, "issues")
	replayCtx, replayCancel := context.WithCancel(context.Background())
	defer replayCancel()
	replay, e := client.WatchRepository(replayCtx, activityRequest(f, session, "0"))
	if e != nil {
		t.Fatal(e)
	}
	defer replay.Close()
	if !replay.Receive() {
		t.Fatal("missing first replay", replay.Err())
	}
	if m := replay.Msg(); m.Kind != "change" || m.Cursor != first || len(m.Topics) != 1 || m.Topics[0] != "issues" {
		t.Fatal("first event skipped or foreign event replayed", m)
	}
	replayCancel()
	replay.Close()
	wrong := activityRequest(f, session, "0")
	wrong.Msg.RepositoryId = "12"
	denied, e := client.WatchRepository(context.Background(), wrong)
	if e == nil {
		denied.Receive()
		e = denied.Err()
		denied.Close()
	}
	if connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("zero bypassed exact repository identity", e)
	}
	f.mode.Store("repository-denied")
	privateDenied, e := client.WatchRepository(context.Background(), activityRequest(f, session, "0"))
	if e == nil {
		privateDenied.Receive()
		e = privateDenied.Err()
		privateDenied.Close()
	}
	if connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("zero bypassed current native authority", e)
	}
	f.mode.Store("")
	hash, _ := sessionHash(session.Value)
	if _, e = f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); e != nil {
		t.Fatal(e)
	}
	revoked, e := client.WatchRepository(context.Background(), activityRequest(f, session, "0"))
	if e == nil {
		revoked.Receive()
		e = revoked.Err()
		revoked.Close()
	}
	if connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("zero bypassed revoked session", e)
	}
}

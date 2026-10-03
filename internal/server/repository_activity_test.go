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
	s, e := New(testConfig("http://gitea.invalid"), nil)
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
	if _, e := f.db.Exec("SELECT golf_append_repository_activity($1,$2,$3,$4)", f.s.config.GiteaURL, repo, user, topic); e != nil {
		t.Fatal(e)
	}
	var id int64
	if e := f.db.QueryRow("SELECT max(id) FROM golf_repository_activity WHERE forge_url=$1 AND repository_id=$2", f.s.config.GiteaURL, repo).Scan(&id); e != nil {
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
	for _, cursor := range []string{"00", "-1", "9223372036854775808", appendActivity(t, f, 12, 0, "source"), appendActivity(t, f, 11, 99999, "agents")} {
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
	if _, e = tx.ExecContext(ctx, "SELECT golf_append_repository_activity($1,11,0,'issues')", f.s.config.GiteaURL); e != nil {
		t.Fatal(e)
	}
	var first int64
	if e = tx.QueryRowContext(ctx, "SELECT max(id) FROM golf_repository_activity").Scan(&first); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() {
		_, e := f.db.ExecContext(ctx, "SELECT golf_append_repository_activity($1,11,0,'pulls')", f.s.config.GiteaURL)
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
	if _, e = rollback.Exec("SELECT golf_append_repository_activity($1,11,0,'source')", f.s.config.GiteaURL); e != nil {
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

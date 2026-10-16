package server

import (
	"connectrpc.com/connect"
	"encoding/json"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

type forgeInboxFixture struct {
	*engagementFixture
	unread, foreign    bool
	notificationWrites int
	notificationFault  string
}

func newForgeInboxFixture(t *testing.T) *forgeInboxFixture {
	f := &forgeInboxFixture{engagementFixture: newEngagementFixture(t), unread: true}
	provider := httptest.NewServer(http.HandlerFunc(f.serveNotifications))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.ForgePublicURL, config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var e error
	f.s, e = New(config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *forgeInboxFixture) row() nativeForgeNotification {
	n := nativeForgeNotification{ID: 901, Repository: &Repository{ID: 11, Name: "private", FullName: "alice/private", HTMLURL: "https://forge.invalid/alice/private"}, Unread: f.unread, Updated: "2026-10-05T00:00:00Z"}
	n.Subject = &struct {
		Title   string `json:"title"`
		HTMLURL string `json:"html_url"`
		Type    string `json:"type"`
	}{Title: "stale native title", HTMLURL: "https://forge.invalid/alice/private/pulls/7", Type: "Pull"}
	return n
}
func (f *forgeInboxFixture) serveNotifications(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/v1/notifications" {
		w.Header().Set("Content-Type", "application/json")
		rows := []nativeForgeNotification{}
		if !f.foreign {
			rows = append(rows, f.row())
		}
		w.Header().Set("X-Total-Count", "0")
		if len(rows) > 0 {
			w.Header().Set("X-Total-Count", "1")
		}
		_ = json.NewEncoder(w).Encode(rows)
		return
	}
	if r.URL.Path == "/api/v1/notifications/threads/901" {
		f.notificationWrites++
		if f.notificationFault != "ignored" {
			f.unread = false
		}
		if f.notificationFault == "lost" {
			c, _, _ := w.(http.Hijacker).Hijack()
			_ = c.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(205)
		_ = json.NewEncoder(w).Encode(f.row())
		return
	}
	f.serveEngagement(w, r)
}
func TestOwnForgeNotificationJournalPostgres(t *testing.T) {
	for _, fault := range []string{"", "lost", "ignored"} {
		t.Run(fault, func(t *testing.T) {
			f := newForgeInboxFixture(t)
			session := f.session(t, "pat")
			reads := f.engagementClient(t, session)
			writes := f.client(t, session)
			rows, e := reads.ListOwnForgeNotifications(t.Context(), connect.NewRequest(&golfv1.ListOwnForgeNotificationsRequest{}))
			if e != nil || len(rows.Msg.Notifications) != 1 {
				t.Fatal("own inbox", rows, e)
			}
			row := rows.Msg.Notifications[0]
			if strings.Contains(row.Title, "stale") {
				t.Fatal("native stale title adopted")
			}
			m := &golfv1.SubmitDiscussionResourceOperationRequest{Repository: row.Target.Repository, RepositoryId: row.Target.RepositoryId, IssueId: row.Target.IssueId, Number: row.Target.Number, PullRequest: row.Target.PullRequest, ResourceId: row.Id, ExpectedRevision: row.Revision, Kind: 13, OperationId: randomUUID()}
			f.notificationFault = fault
			want := golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED
			if fault != "" {
				want = golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_DISPATCH_UNKNOWN
			}
			for range 2 {
				r, e := writes.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
				if e != nil || r.Msg.Operation.Phase != want || f.notificationWrites != 1 {
					t.Fatalf("mark/replay %v %v %d", r, e, f.notificationWrites)
				}
			}
		})
	}
}
func TestOwnForgeNotificationForeignThreadRefusedPostgres(t *testing.T) {
	f := newForgeInboxFixture(t)
	session := f.session(t, "pat")
	writes := f.client(t, session)
	f.foreign = true
	m := &golfv1.SubmitDiscussionResourceOperationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", IssueId: "77", Number: 7, PullRequest: true, ResourceId: "901", ExpectedRevision: strings.Repeat("a", 64), Kind: 13, OperationId: randomUUID()}
	if _, e := writes.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m)); connect.CodeOf(e) != connect.CodeNotFound || f.notificationWrites != 0 {
		t.Fatal("foreign native admin-readable thread adopted", e, f.notificationWrites)
	}
}
func TestFillOwnNotificationsReadsPastFilteredPages(t *testing.T) {
	// Native pages 1 and 2 hold only threads the caller can no longer open; page 3 holds one it can.
	pages := map[uint32][]int64{1: {1, 2}, 2: {3}, 3: {4, 5}, 4: {6}}
	read := func(reads *[]uint32) func(uint32) ([]nativeForgeNotification, uint32, error) {
		return func(page uint32) ([]nativeForgeNotification, uint32, error) {
			*reads = append(*reads, page)
			rows := []nativeForgeNotification{}
			for _, id := range pages[page] {
				rows = append(rows, nativeForgeNotification{ID: id})
			}
			if page == 4 {
				return rows, 0, nil
			}
			return rows, page + 1, nil
		}
	}
	authorize := func(n nativeForgeNotification) (*golfv1.OwnForgeNotification, error) {
		switch n.ID {
		case 1:
			return nil, errResourceNotFound
		case 2, 3:
			return nil, forgeError{status: 403}
		}
		return &golfv1.OwnForgeNotification{Id: strconv.FormatInt(n.ID, 10)}, nil
	}
	var reads []uint32
	rows, next, e := fillOwnNotifications(1, 3, read(&reads), authorize)
	if e != nil || len(rows) != 2 || rows[0].Id != "4" || rows[1].Id != "5" || next != 4 || len(reads) != 3 {
		t.Fatal("filtered pages ended the inbox", rows, next, reads, e)
	}
	// A short page is returned as it is; the next read continues where it stopped.
	reads = nil
	if rows, next, e = fillOwnNotifications(4, 3, read(&reads), authorize); e != nil || len(rows) != 1 || next != 0 || len(reads) != 1 {
		t.Fatal("last page", rows, next, reads, e)
	}
	// The bound holds: denied threads alone return an empty page whose cursor is the next unread native page.
	reads = nil
	if rows, next, e = fillOwnNotifications(1, 2, read(&reads), authorize); e != nil || len(rows) != 0 || next != 3 || len(reads) != 2 {
		t.Fatal("bounded reads", rows, next, reads, e)
	}
	// Other failures still fail the page.
	if _, _, e = fillOwnNotifications(1, 3, read(&reads), func(nativeForgeNotification) (*golfv1.OwnForgeNotification, error) {
		return nil, errInvalidForgeResponse
	}); e == nil {
		t.Fatal("authorization failure ignored")
	}
}
func TestMarkdownIssueTemplateBoundaries(t *testing.T) {
	entry := sourceEntry{Name: "bug.md", Path: ".github/ISSUE_TEMPLATE/bug.md", SHA: strings.Repeat("a", 40)}
	good, e := markdownIssueTemplate(entry, "---\nname: Bug report\nabout: Reproduce a bug\ntitle: '[Bug] '\n---\n## Steps\n")
	if e == nil {
		t.Fatal("untrimmed title accepted")
	}
	good, e = markdownIssueTemplate(entry, "---\nname: Bug report\nabout: Reproduce a bug\ntitle: '[Bug]'\n---\n## Steps\n")
	if e != nil || good.Name != "Bug report" || good.Title != "[Bug]" || good.Body != "## Steps\n" {
		t.Fatal(good, e)
	}
	for _, text := range []string{"---\nname: [bad]\n---\nbody", strings.Repeat("x", 6001), "---\nunterminated", "bad\x00text"} {
		if _, e := markdownIssueTemplate(entry, text); e == nil {
			t.Fatal("bad template accepted")
		}
	}
}

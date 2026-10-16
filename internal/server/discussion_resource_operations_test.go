package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
)

type resourceFixture struct {
	*pullMetadataFixture
	lock       sync.Mutex
	writes     atomic.Int32
	labels     map[int64]forgeDiscussionLabel
	milestones map[int64]forgeDiscussionMilestone
	comments   map[int64]forgeIssueComment
	failure    string
	admin      bool
}

func newResourceFixture(t *testing.T) *resourceFixture {
	t.Helper()
	f := &resourceFixture{pullMetadataFixture: newPullMetadataFixture(t), admin: true, labels: map[int64]forgeDiscussionLabel{17: {ID: 17, Name: "bug", Color: "abcdef", Description: "Old label", Archived: true}}, milestones: map[int64]forgeDiscussionMilestone{23: {ID: 23, Title: "Release", State: "open", Description: "Old milestone", OpenIssues: proto.Int64(0), ClosedIssues: proto.Int64(0), DueOn: proto.String("2026-10-05T23:59:59Z")}}, comments: map[int64]forgeIssueComment{31: {ID: 31, User: &User{ID: 42, Login: "alice"}, Body: "Private old comment", CreatedAt: "2026-10-01T00:00:00Z", UpdatedAt: "2026-10-01T00:00:00Z", HTMLURL: "https://forge.invalid/alice/private/pulls/7#issuecomment-31", IssueURL: "https://forge.invalid/alice/private/issues/7", PullRequestURL: "https://forge.invalid/alice/private/pulls/7"}}}
	provider := httptest.NewServer(http.HandlerFunc(f.serveResources))
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
func (f *resourceFixture) serveResources(w http.ResponseWriter, r *http.Request) {
	const base = "/api/v1/repos/alice/private"
	w.Header().Set("Content-Type", "application/json")
	write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	if r.URL.Path == base && r.Method == "GET" {
		id := int64(11)
		if f.failure == "repo-rebound" && f.writes.Load() > 0 {
			id++
		}
		if f.failure == "denied-after" && f.writes.Load() > 0 {
			w.WriteHeader(404)
			return
		}
		write(map[string]any{"id": id, "name": "private", "full_name": "alice/private", "html_url": "https://forge.invalid/alice/private", "private": true, "permissions": map[string]bool{"admin": f.admin}, "archived": false, "has_issues": true, "has_pull_requests": true})
		return
	}
	collection := strings.TrimPrefix(r.URL.Path, base)
	target := int64(0)
	var kind string
	switch {
	case strings.HasPrefix(collection, "/labels"):
		kind = "label"
		target, _ = strconv.ParseInt(strings.TrimPrefix(collection, "/labels/"), 10, 64)
	case strings.HasPrefix(collection, "/milestones"):
		kind = "milestone"
		target, _ = strconv.ParseInt(strings.TrimPrefix(collection, "/milestones/"), 10, 64)
	case strings.HasPrefix(collection, "/issues/comments/"):
		kind = "comment"
		target, _ = strconv.ParseInt(strings.TrimPrefix(collection, "/issues/comments/"), 10, 64)
	default:
		f.serveMetadata(w, r)
		return
	}
	f.lock.Lock()
	defer f.lock.Unlock()
	if r.Method == "GET" {
		if target == 0 {
			if kind == "label" {
				rows := []forgeDiscussionLabel{}
				for _, v := range f.labels {
					rows = append(rows, v)
				}
				write(rows)
			} else {
				rows := []forgeDiscussionMilestone{}
				for _, v := range f.milestones {
					rows = append(rows, v)
				}
				write(rows)
			}
			return
		}
		switch kind {
		case "label":
			if v, ok := f.labels[target]; ok {
				write(v)
				return
			}
		case "milestone":
			if v, ok := f.milestones[target]; ok {
				write(v)
				return
			}
		case "comment":
			if v, ok := f.comments[target]; ok {
				write(v)
				return
			}
		}
		w.WriteHeader(404)
		return
	}
	f.writes.Add(1)
	var count int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_discussion_resource_operations o JOIN golf_discussion_resource_events e ON e.operation_id=o.id WHERE o.phase='DISPATCH_UNKNOWN' AND e.phase='DISPATCH_UNKNOWN'`).Scan(&count); e != nil || count < 1 {
		panic("resource dispatch lacked durable uncertain journal phase")
	}
	if r.Method == "DELETE" {
		if f.failure != "ignored" {
			switch kind {
			case "label":
				delete(f.labels, target)
			case "milestone":
				delete(f.milestones, target)
			case "comment":
				delete(f.comments, target)
			}
		}
		if f.failure == "lost" {
			conn, _, _ := w.(http.Hijacker).Hijack()
			_ = conn.Close()
			return
		}
		w.WriteHeader(204)
		return
	}
	var body map[string]json.RawMessage
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		w.WriteHeader(400)
		return
	}
	if r.Method == "POST" {
		target = 100 + int64(f.writes.Load())
	}
	readString := func(key string) string { var s string; _ = json.Unmarshal(body[key], &s); return s }
	readBool := func(key string) bool { var b bool; _ = json.Unmarshal(body[key], &b); return b }
	var result any
	switch kind {
	case "label":
		if len(body) != 5 || body["is_archived"] == nil || body["exclusive"] == nil {
			panic("label update omitted explicit booleans")
		}
		v := forgeDiscussionLabel{ID: target, Name: readString("name"), Color: readString("color"), Description: readString("description"), Exclusive: readBool("exclusive"), Archived: readBool("is_archived")}
		if f.failure != "ignored" {
			f.labels[target] = v
		}
		if f.failure == "wrong-receipt" {
			v.ID++
		}
		result = v
	case "milestone":
		if len(body) != 4 || body["due_on"] == nil {
			panic("milestone update omitted explicit deadline")
		}
		var date *string
		_ = json.Unmarshal(body["due_on"], &date)
		if date != nil {
			parsed, err := time.Parse(time.RFC3339, *date)
			if err != nil {
				panic("invalid native fixture deadline")
			}
			*date = parsed.UTC().Format("2006-01-02") + "T23:59:59Z"
		}
		v := forgeDiscussionMilestone{ID: target, Title: readString("title"), Description: readString("description"), State: readString("state"), OpenIssues: proto.Int64(0), ClosedIssues: proto.Int64(0), DueOn: date}
		if f.failure != "ignored" {
			f.milestones[target] = v
		}
		if f.failure == "wrong-receipt" {
			v.ID++
		}
		result = v
	case "comment":
		if len(body) != 1 {
			panic("comment patch was mixed")
		}
		v := f.comments[target]
		v.Body = readString("body")
		v.UpdatedAt = "2026-10-05T00:00:00Z"
		if f.failure != "ignored" {
			f.comments[target] = v
		}
		if f.failure == "wrong-receipt" {
			v.ID++
		}
		result = v
	}
	if f.failure == "lost" {
		conn, _, _ := w.(http.Hijacker).Hijack()
		_ = conn.Close()
		return
	}
	if r.Method == "POST" {
		w.WriteHeader(201)
	}
	write(result)
}
func (f *resourceFixture) request(kind golfv1.DiscussionResourceOperationKind) *golfv1.SubmitDiscussionResourceOperationRequest {
	m := &golfv1.SubmitDiscussionResourceOperationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", OperationId: randomUUID(), Kind: kind}
	k := resourceKind(kind)
	switch {
	case strings.HasSuffix(k, "_LABEL"):
		if !strings.HasPrefix(k, "CREATE") {
			raw, _ := json.Marshal(f.labels[17])
			v, _ := nativeLabel(raw)
			m.ResourceId = "17"
			m.ExpectedRevision = v.Revision
		}
		if !strings.HasPrefix(k, "DELETE") {
			m.Change = &golfv1.SubmitDiscussionResourceOperationRequest_Label{Label: &golfv1.DiscussionLabelDraft{Name: "security", Color: "123456", Description: "Private label details", Exclusive: true, Archived: true}}
		}
	case strings.HasSuffix(k, "_MILESTONE"):
		if !strings.HasPrefix(k, "CREATE") {
			raw, _ := json.Marshal(f.milestones[23])
			v, _ := nativeMilestone(raw)
			m.ResourceId = "23"
			m.ExpectedRevision = v.Revision
		}
		if !strings.HasPrefix(k, "DELETE") {
			m.Change = &golfv1.SubmitDiscussionResourceOperationRequest_Milestone{Milestone: &golfv1.DiscussionMilestoneDraft{Title: "Next release", Description: "Private milestone details", State: golfv1.IssueState_ISSUE_STATE_CLOSED, DueDate: ""}}
		}
	default:
		m.ResourceId = "31"
		m.ExpectedRevision = commentRevision(f.comments[31])
		m.IssueId = "77"
		m.Number = 7
		m.PullRequest = true
		if kind == golfv1.DiscussionResourceOperationKind_DISCUSSION_RESOURCE_OPERATION_KIND_UPDATE_COMMENT {
			m.Change = &golfv1.SubmitDiscussionResourceOperationRequest_CommentBody{CommentBody: "Private updated comment"}
		}
	}
	return m
}
func randomUUID() string {
	return "10000000-0000-4000-8000-" + strconv.FormatInt(uuidCounter.Add(1)+100000000000, 10)
}

var uuidCounter atomic.Int64

func TestDiscussionResourceValidation(t *testing.T) {
	good := &golfv1.SubmitDiscussionResourceOperationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", OperationId: randomUUID(), Kind: golfv1.DiscussionResourceOperationKind_DISCUSSION_RESOURCE_OPERATION_KIND_CREATE_LABEL, Change: &golfv1.SubmitDiscussionResourceOperationRequest_Label{Label: &golfv1.DiscussionLabelDraft{Name: "bug", Color: "abcdef"}}}
	if e := validateResourceRequest(good); e != nil {
		t.Fatal(e)
	}
	for name, change := range map[string]func(*golfv1.SubmitDiscussionResourceOperationRequest){"invalid-kind": func(m *golfv1.SubmitDiscussionResourceOperationRequest) { m.Kind = 0 }, "mixed": func(m *golfv1.SubmitDiscussionResourceOperationRequest) {
		m.Change = &golfv1.SubmitDiscussionResourceOperationRequest_CommentBody{CommentBody: "secret"}
	}, "adopt-create": func(m *golfv1.SubmitDiscussionResourceOperationRequest) { m.ResourceId = "17" }, "comment-target": func(m *golfv1.SubmitDiscussionResourceOperationRequest) { m.IssueId = "77" }, "oversized-name": func(m *golfv1.SubmitDiscussionResourceOperationRequest) { m.GetLabel().Name = strings.Repeat("x", 256) }, "spaced-name": func(m *golfv1.SubmitDiscussionResourceOperationRequest) { m.GetLabel().Name = " spaced " }, "bad-color": func(m *golfv1.SubmitDiscussionResourceOperationRequest) { m.GetLabel().Color = "ABCDEF" }, "oversized": func(m *golfv1.SubmitDiscussionResourceOperationRequest) {
		m.GetLabel().Description = strings.Repeat("x", 4097)
	}} {
		t.Run(name, func(t *testing.T) {
			m := proto.Clone(good).(*golfv1.SubmitDiscussionResourceOperationRequest)
			change(m)
			if e := validateResourceRequest(m); e == nil {
				t.Fatal("invalid request accepted")
			}
		})
	}
}
func TestDiscussionResourceLifecyclePostgres(t *testing.T) {
	for _, kind := range []golfv1.DiscussionResourceOperationKind{1, 2, 3, 4, 5, 6, 7, 8} {
		t.Run(resourceKind(kind), func(t *testing.T) {
			f := newResourceFixture(t)
			client := f.client(t, f.session(t, "pat"))
			m := f.request(kind)
			r, e := client.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
			if e != nil || r.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
				t.Fatalf("submit: %v %v", r, e)
			}
			again, e := client.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
			if e != nil || again.Msg.Operation.Phase != r.Msg.Operation.Phase || f.writes.Load() != 1 || again.Msg.Comment != nil || again.Msg.Label != nil || again.Msg.Milestone != nil {
				t.Fatalf("replay: %v %v writes%d", again, e, f.writes.Load())
			}
			_, e = client.GetDiscussionResourceOperation(t.Context(), connect.NewRequest(&golfv1.GetDiscussionResourceOperationRequest{OperationId: m.OperationId}))
			if e != nil {
				t.Fatal(e)
			}
			var events int
			if e = f.db.QueryRow(`SELECT count(*) FROM golf_discussion_resource_events`).Scan(&events); e != nil || events != 3 {
				t.Fatal("phase events", events, e)
			}
			var stored string
			if e = f.db.QueryRow(`SELECT row_to_json(o)::text FROM golf_discussion_resource_operations o`).Scan(&stored); e != nil || strings.Contains(stored, "Private") || strings.Contains(stored, "security") {
				t.Fatal("private draft retained", e)
			}
		})
	}
}
func TestDiscussionResourceUnknownPostgres(t *testing.T) {
	for _, kind := range []golfv1.DiscussionResourceOperationKind{2, 3, 5, 6, 7, 8} {
		for _, mode := range []string{"lost", "ignored", "wrong-receipt", "repo-rebound", "denied-after"} {
			if strings.HasPrefix(resourceKind(kind), "DELETE") && mode == "wrong-receipt" {
				continue
			}
			t.Run(resourceKind(kind)+"/"+mode, func(t *testing.T) {
				f := newResourceFixture(t)
				f.failure = mode
				client := f.client(t, f.session(t, "pat"))
				m := f.request(kind)
				r, e := client.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
				if e == nil && r.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_DISPATCH_UNKNOWN {
					t.Fatal("uncertain effect claimed terminal", r.Msg)
				}
				if f.writes.Load() != 1 {
					t.Fatalf("writes%d %v", f.writes.Load(), e)
				}
				_, _ = client.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
				if f.writes.Load() != 1 {
					t.Fatal("unknown original key replayed")
				}
				var phase string
				_ = f.db.QueryRow(`SELECT phase FROM golf_discussion_resource_operations`).Scan(&phase)
				if phase != "DISPATCH_UNKNOWN" {
					t.Fatal(phase)
				}
			})
		}
	}
}
func TestDiscussionResourceStaleAndAuthorPostgres(t *testing.T) {
	t.Run("stale", func(t *testing.T) {
		f := newResourceFixture(t)
		client := f.client(t, f.session(t, "pat"))
		m := f.request(2)
		m.ExpectedRevision = strings.Repeat("0", 64)
		r, e := client.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
		if e != nil || r.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED || f.writes.Load() != 0 {
			t.Fatalf("stale %v %v", r, e)
		}
	})
	for _, own := range []bool{false, true} {
		t.Run(strconv.FormatBool(own), func(t *testing.T) {
			f := newResourceFixture(t)
			f.admin = false
			if !own {
				v := f.comments[31]
				v.User = &User{ID: 43, Login: "bob"}
				f.comments[31] = v
			}
			client := f.client(t, f.session(t, "pat"))
			m := f.request(7)
			r, e := client.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
			if own {
				if e != nil || r.Msg.Operation.Phase != 3 {
					t.Fatalf("native author denied %v %v", r, e)
				}
			} else if connect.CodeOf(e) != connect.CodePermissionDenied || f.writes.Load() != 0 {
				t.Fatalf("nonwriter/non-author allowed %v %v", r, e)
			}
		})
	}
}

var _ golfv1connect.RepositoryServiceClient

func TestDiscussionResourceMilestoneDraftBoundaries(t *testing.T) {
	m := &golfv1.SubmitDiscussionResourceOperationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", OperationId: randomUUID(), Kind: golfv1.DiscussionResourceOperationKind_DISCUSSION_RESOURCE_OPERATION_KIND_CREATE_MILESTONE, Change: &golfv1.SubmitDiscussionResourceOperationRequest_Milestone{Milestone: &golfv1.DiscussionMilestoneDraft{Title: strings.Repeat("x", 255), State: golfv1.IssueState_ISSUE_STATE_OPEN, DueDate: "1970-01-01"}}}
	if e := validateResourceRequest(m); e != nil {
		t.Fatal(e)
	}
	_, _, payload := resourceNative(m)
	due, err := time.Parse(time.RFC3339, payload.(map[string]any)["due_on"].(string))
	if err != nil || due.Unix() == 0 || due.UTC().Format("2006-01-02") != "1970-01-01" {
		t.Fatal("earliest native calendar date became the unset deadline sentinel")
	}

	for name, change := range map[string]func(*golfv1.DiscussionMilestoneDraft){"spaces": func(d *golfv1.DiscussionMilestoneDraft) { d.Title = " milestone " }, "long": func(d *golfv1.DiscussionMilestoneDraft) { d.Title = strings.Repeat("x", 256) }, "impossible-day": func(d *golfv1.DiscussionMilestoneDraft) { d.DueDate = "2026-02-30" }, "before-native-epoch": func(d *golfv1.DiscussionMilestoneDraft) { d.DueDate = "1969-12-31" }, "unknown-state": func(d *golfv1.DiscussionMilestoneDraft) { d.State = golfv1.IssueState_ISSUE_STATE_UNSPECIFIED }} {
		t.Run(name, func(t *testing.T) {
			c := proto.Clone(m).(*golfv1.SubmitDiscussionResourceOperationRequest)
			change(c.GetMilestone())
			if validateResourceRequest(c) == nil {
				t.Fatal("native-normalized or invalid milestone draft accepted")
			}
		})
	}
}

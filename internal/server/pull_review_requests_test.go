package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type reviewRequestFixture struct {
	*releasePublicationFixture
	mu            sync.Mutex
	requested     bool
	teamRequested bool
	requests      atomic.Int32
	requestMode   atomic.Value
}

func newReviewRequestFixture(t *testing.T) *reviewRequestFixture {
	f := &reviewRequestFixture{releasePublicationFixture: newReleasePublicationFixture(t)}
	f.requestMode.Store("")
	target, _ := url.Parse(f.s.config.GiteaURL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := "/api/v1/repos/alice/private"
		mode := f.requestMode.Load().(string)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/teams/100" {
			json.NewEncoder(w).Encode(reviewFixtureTeam())
			return
		}
		if r.URL.Path == base+"/teams" {
			json.NewEncoder(w).Encode([]forgeOrganizationTeam{reviewFixtureTeam()})
			return
		}
		if r.URL.Path == "/api/v1/users/bob" {
			json.NewEncoder(w).Encode(User{ID: 43, Login: "bob"})
			return
		}
		if r.URL.Path == base+"/pulls/7" {
			row := standardMergeFixturePull(false)
			row.ID = 101
			b, _ := json.Marshal(row)
			var raw map[string]any
			json.Unmarshal(b, &raw)
			f.mu.Lock()
			present := f.requested
			teamPresent := f.teamRequested
			f.mu.Unlock()
			users := []User{}
			if present {
				users = append(users, User{ID: 43, Login: "bob"})
			}
			raw["requested_reviewers"] = users
			teams := []forgeOrganizationTeam{}
			if teamPresent {
				teams = append(teams, reviewFixtureTeam())
			}
			raw["requested_reviewers_teams"] = teams
			if mode == "unknown-inventory" {
				delete(raw, "requested_reviewers")
			}
			if mode == "closed" {
				raw["state"] = "closed"
			}
			json.NewEncoder(w).Encode(raw)
			return
		}
		if r.URL.Path == base+"/pulls/7/requested_reviewers" {
			f.requests.Add(1)
			var input map[string][]string
			json.NewDecoder(r.Body).Decode(&input)
			if len(input["team_reviewers"]) == 1 {
				if input["team_reviewers"][0] != "reviewers" {
					t.Error("wrong native team")
				}
				f.mu.Lock()
				f.teamRequested = r.Method == "POST"
				f.mu.Unlock()
			} else if len(input["reviewers"]) != 1 || input["reviewers"][0] != "bob" {
				t.Error("wrong native reviewer")
			}
			f.mu.Lock()
			if len(input["reviewers"]) > 0 {
				f.requested = r.Method == "POST"
			}
			f.mu.Unlock()
			if mode == "lost" {
				w.WriteHeader(500)
				return
			}
			if r.Method == "POST" {
				w.WriteHeader(201)
				json.NewEncoder(w).Encode([]any{})
			} else {
				w.WriteHeader(204)
			}
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(provider.Close)
	config := f.s.config
	config.GiteaURL, config.GiteaPublicURL = provider.URL, provider.URL
	var e error
	f.s, e = New(config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *reviewRequestFixture) submitRequest(t *testing.T, session loginResult, m *golfv1.SubmitPullReviewRequestRequest) (*golfv1.PullReviewRequestOperation, error) {
	ctx, _, h := f.scope(session)
	req := connect.NewRequest(m)
	req.Header().Set("Cookie", h.Get("Cookie"))
	req.Header().Set("Origin", h.Get("Origin"))
	r, e := f.s.SubmitPullReviewRequest(ctx, req)
	if e != nil {
		return nil, e
	}
	return r.Msg.Operation, nil
}
func (f *reviewRequestFixture) requestInput(t *testing.T, session loginResult, add bool) *golfv1.SubmitPullReviewRequestRequest {
	ctx, token, _ := f.scope(session)
	snap, e := f.s.reviewRequestSnapshot(ctx, session.Value, token, pullKeyFromFixture(), "11", "101", 7)
	if e != nil {
		t.Fatal(e)
	}
	return &golfv1.SubmitPullReviewRequestRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", PullRequestId: "101", Number: 7, ExpectedPullRevision: snap.PullRevision, ExpectedRequestsRevision: snap.RequestsRevision, ReviewerId: "43", ReviewerLogin: "bob", RequestReview: add, OperationId: uuid.NewString()}
}
func pullKeyFromFixture() repositoryKey { return repositoryKey{"alice", "private"} }
func TestReviewRequestOriginalPostgres(t *testing.T) {
	f := newReviewRequestFixture(t)
	session := f.session(t, "pat")
	add := f.requestInput(t, session, true)
	r, e := f.submitRequest(t, session, add)
	if e != nil || r.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
		t.Fatal("request", e, r)
	}
	replay, e := f.submitRequest(t, session, add)
	if e != nil || !proto.Equal(r, replay) || f.requests.Load() != 1 {
		t.Fatal("request replay", e, replay)
	}
	changed := proto.Clone(add).(*golfv1.SubmitPullReviewRequestRequest)
	changed.RequestReview = false
	if _, e = f.submitRequest(t, session, changed); e == nil || f.requests.Load() != 1 {
		t.Fatal("changed original admitted")
	}
	remove := f.requestInput(t, session, false)
	removed, e := f.submitRequest(t, session, remove)
	if e != nil || removed.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED || f.requests.Load() != 2 {
		t.Fatal("cancel", e, removed)
	}
	f.mode.Store("denied")
	if _, e = f.submitRequest(t, session, remove); e == nil {
		t.Fatal("private original disclosed after revocation")
	}
	if _, e = f.db.Exec(`UPDATE golf_pull_review_request_operations SET original='changed' WHERE operation_id=$1`, add.OperationId); e == nil {
		t.Fatal("original journal editable")
	}
}
func TestReviewRequestUnknownAndRefusalPostgres(t *testing.T) {
	for _, mode := range []string{"lost", "stale", "unknown-inventory", "closed"} {
		t.Run(mode, func(t *testing.T) {
			f := newReviewRequestFixture(t)
			session := f.session(t, "pat")
			m := f.requestInput(t, session, true)
			if mode == "stale" {
				m.ExpectedRequestsRevision = strings.Repeat("f", 64)
			} else {
				f.requestMode.Store(mode)
			}
			r, e := f.submitRequest(t, session, m)
			if mode == "unknown-inventory" || mode == "closed" {
				if e == nil || f.requests.Load() != 0 {
					t.Fatal("unavailable target admitted", e, r)
				}
				return
			}
			want := golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED
			if mode == "lost" {
				want = golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_DISPATCH_UNKNOWN
			}
			if e != nil || r.Phase != want {
				t.Fatal("original state", e, r)
			}
			replay, e := f.submitRequest(t, session, m)
			if e != nil || !proto.Equal(r, replay) || f.requests.Load() > 1 {
				t.Fatal("uncertain resend", e, replay)
			}
			if mode == "lost" {
				ctx, token, _ := f.scope(session)
				base, _ := repositoryPath(pullKeyFromFixture())
				if _, e = f.s.forge(ctx, http.MethodPatch, base, token, map[string]bool{"private": false}, nil); e == nil {
					t.Fatal("unknown request permitted foreign repository write")
				}
			}
		})
	}
}
func TestReviewRequestValidation(t *testing.T) {
	m := &golfv1.SubmitPullReviewRequestRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", PullRequestId: "101", Number: 7, ExpectedPullRevision: strings.Repeat("a", 64), ExpectedRequestsRevision: strings.Repeat("b", 64), ReviewerId: "43", ReviewerLogin: "bob", OperationId: uuid.NewString()}
	if e := validateReviewRequest(m); e != nil {
		t.Fatal(e)
	}
	for _, edit := range []func(*golfv1.SubmitPullReviewRequestRequest){func(m *golfv1.SubmitPullReviewRequestRequest) { m.ReviewerLogin = "bob@example.invalid" }, func(m *golfv1.SubmitPullReviewRequestRequest) { m.ReviewerId = "0" }, func(m *golfv1.SubmitPullReviewRequestRequest) { m.ExpectedRequestsRevision = "" }, func(m *golfv1.SubmitPullReviewRequestRequest) { m.Number = 0 }} {
		bad := proto.Clone(m).(*golfv1.SubmitPullReviewRequestRequest)
		edit(bad)
		if validateReviewRequest(bad) == nil {
			t.Fatal("invalid target admitted")
		}
	}
}

func reviewFixtureTeam() forgeOrganizationTeam {
	return forgeOrganizationTeam{ID: 100, Name: "reviewers", Permission: "read", Visibility: "public", Organization: &forgeOrganization{ID: 50, Name: "alice", Visibility: "public"}, UnitPermissions: map[string]string{"repo.pulls": "read"}}
}
func TestReviewRequestTeamOriginalPostgres(t *testing.T) {
	f := newReviewRequestFixture(t)
	session := f.session(t, "pat")
	m := f.requestInput(t, session, true)
	m.ReviewerTeam = true
	m.ReviewerId = "100"
	m.ReviewerLogin = "reviewers"
	r, e := f.submitRequest(t, session, m)
	if e != nil || r.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
		t.Fatal("team request", e, r)
	}
	replay, e := f.submitRequest(t, session, m)
	if e != nil || !proto.Equal(r, replay) || f.requests.Load() != 1 {
		t.Fatal("team replay", e)
	}
	remove := f.requestInput(t, session, false)
	remove.ReviewerTeam = true
	remove.ReviewerId = "100"
	remove.ReviewerLogin = "reviewers"
	r, e = f.submitRequest(t, session, remove)
	if e != nil || r.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED || f.requests.Load() != 2 {
		t.Fatal("team removal", e, r)
	}
	changed := proto.Clone(m).(*golfv1.SubmitPullReviewRequestRequest)
	changed.ReviewerTeam = false
	if _, e = f.submitRequest(t, session, changed); e == nil {
		t.Fatal("same key changed identity kind")
	}
}

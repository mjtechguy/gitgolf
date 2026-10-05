package server

import (
	"bytes"
	"connectrpc.com/connect"
	"encoding/hex"
	"encoding/json"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestStandardMergeLegacyGolden(t *testing.T) {
	if got := hex.EncodeToString(standardMergeFingerprint(standardMergeFixtureRequest())); got != "c50d24e4a77eb4bce79052dc5939bc1c076565a7eb94bde430394ce16eb869d8" {
		t.Fatal("Legacy fingerprint changed", got)
	}
}
func forkMergeRequest() *golfv1.SubmitStandardPullMergeRequest {
	m := standardMergeFixtureRequest()
	m.SourceRepository = &golfv1.RepositoryKey{Owner: "author", Name: "fork"}
	m.SourceRepositoryId = "23"
	m.SourceOwnerId = "43"
	p := standardMergeFixturePull(false)
	bindForkPull(&p)
	m.ExpectedPullRevision = pullRevision(p)
	return m
}
func bindForkPull(p *forgePull) {
	p.Head.RepositoryID = 23
	p.Head.Repository = &Repository{ID: 23, Name: "fork", FullName: "author/fork", HTMLURL: "https://forge.invalid/author/fork"}
}
func TestStandardMergeForkInputAndReceipt(t *testing.T) {
	m := forkMergeRequest()
	if e := validateStandardMerge(m); e != nil {
		t.Fatal(e)
	}
	legacy := standardMergeFixtureRequest()
	if bytes.Equal(standardMergeFingerprint(legacy), standardMergeFingerprint(m)) {
		t.Fatal("Explicit source not in intent")
	}
	for _, field := range []string{"key", "repo", "owner"} {
		bad := proto.Clone(m).(*golfv1.SubmitStandardPullMergeRequest)
		switch field {
		case "key":
			bad.SourceRepository = nil
		case "repo":
			bad.SourceRepositoryId = ""
		case "owner":
			bad.SourceOwnerId = ""
		}
		if validateStandardMerge(bad) == nil {
			t.Fatal("Partial source admitted", field)
		}
	}
	r := standardMergeRecord{SourceRepositoryID: 23, SourceOwnerID: 43, SourceOwner: "author", SourceName: "fork"}
	v := standardMergeWire(r)
	if v.Contract != standardMergeForkContract || v.SourceRepository.GetOwner() != "author" || v.SourceRepositoryId != "23" || v.SourceOwnerId != "43" {
		t.Fatal("Bound source receipt lost")
	}
	old := standardMergeWire(standardMergeRecord{})
	if old.Contract != standardMergeContract || old.SourceRepository != nil || old.SourceRepositoryId != "" || old.SourceOwnerId != "" {
		t.Fatal("Legacy receipt changed")
	}
}

type forkMergeTransport func(*http.Request) (*http.Response, error)

func (f forkMergeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func newForkMergeFixture(t *testing.T) (*standardMergeFixture, *atomic.Value) {
	f := newStandardMergeFixture(t)
	mode := &atomic.Value{}
	mode.Store("")
	original := f.s.client.Transport
	if original == nil {
		original = http.DefaultTransport
	}
	f.s.client.Transport = forkMergeTransport(func(req *http.Request) (*http.Response, error) {
		path := req.URL.Path
		state := mode.Load().(string)
		respond := func(status int, value any) (*http.Response, error) {
			data, _ := json.Marshal(value)
			return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(data)), Request: req}, nil
		}
		if path == "/api/v1/repos/author/fork" {
			if state == "source-denied" {
				return respond(404, map[string]string{"message": "unavailable"})
			}
			id := int64(23)
			if state == "source-replacement" {
				id = 24
			}
			return respond(200, map[string]any{"id": id, "name": "fork", "full_name": "author/fork", "html_url": "https://forge.invalid/author/fork", "private": true, "owner": map[string]any{"id": 43, "login": "author"}, "permissions": map[string]bool{"pull": true, "push": false, "admin": false}, "archived": false, "mirror": false, "has_actions": false})
		}
		if path == "/api/v1/repos/author/fork/git/refs/heads/feature/slash" {
			h := strings.Repeat("a", 40)
			if state == "source-drift" {
				h = strings.Repeat("d", 40)
			}
			return respond(200, []any{map[string]any{"ref": "refs/heads/feature/slash", "object": map[string]string{"type": "commit", "sha": h}}})
		}
		response, e := original.RoundTrip(req)
		if path == "/api/v1/repos/alice/private/pulls/7/merge" && req.Method == http.MethodPost && state == "late-source-denied" {
			mode.Store("source-denied")
		}
		if e != nil {
			return nil, e
		}
		if path == "/api/v1/repos/alice/private/pulls/7" && req.Method == http.MethodGet {
			defer response.Body.Close()
			var p forgePull
			if e = json.NewDecoder(response.Body).Decode(&p); e != nil {
				return nil, e
			}
			bindForkPull(&p)
			return respond(response.StatusCode, p)
		}
		return response, nil
	})
	return f, mode
}
func TestStandardMergeForkSuccessPostgres(t *testing.T) {
	f, mode := newForkMergeFixture(t)
	session := f.session(t, "pat")
	m := forkMergeRequest()
	r, e := f.submit(t, session, m)
	if e != nil {
		t.Fatal(e)
	}
	if r.Phase != golfv1.StandardPullMergePhase_STANDARD_PULL_MERGE_PHASE_SUCCEEDED || r.Contract != standardMergeForkContract || r.SourceRepositoryId != "23" || r.SourceOwnerId != "43" || f.calls.Load() != 1 {
		t.Fatal("Exact fork merge failed")
	}
	replay, e := f.submit(t, session, m)
	if e != nil || !proto.Equal(r, replay) || f.calls.Load() != 1 {
		t.Fatal("Fork original resent", e)
	}
	// Historical original is not a new merge permit: later branch movement does not rewrite it.
	mode.Store("source-drift")
	status, e := f.status(t, session, standardMergeStatusRequest(m))
	if e != nil || !proto.Equal(r, status) {
		t.Fatal("Original historical source receipt changed", e)
	}
	mode.Store("source-denied")
	if _, e = f.status(t, session, standardMergeStatusRequest(m)); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("Private source revoked receipt exposed", e)
	}
}
func TestStandardMergeForkRefusalAndUnknownPostgres(t *testing.T) {
	for _, state := range []string{"source-denied", "source-replacement", "source-drift", "protected", "lost-response", "late-source-denied"} {
		t.Run(state, func(t *testing.T) {
			f, mode := newForkMergeFixture(t)
			session := f.session(t, "pat")
			m := forkMergeRequest()
			if strings.HasPrefix(state, "source-") || state == "late-source-denied" {
				mode.Store(state)
			} else {
				f.mode.Store(state)
			}
			r, e := f.submit(t, session, m)
			if state == "source-denied" || state == "source-replacement" || state == "late-source-denied" {
				if e == nil {
					t.Fatal("Denied source revealed receipt")
				}
				mode.Store("")
				r, e = f.status(t, session, standardMergeStatusRequest(m))
			}
			if e != nil {
				t.Fatal(e)
			}
			phase := golfv1.StandardPullMergePhase_STANDARD_PULL_MERGE_PHASE_REJECTED
			calls := int32(0)
			if state == "lost-response" || state == "late-source-denied" {
				phase = golfv1.StandardPullMergePhase_STANDARD_PULL_MERGE_PHASE_DISPATCH_UNKNOWN
				calls = 1
			}
			if r.Phase != phase || f.calls.Load() != calls {
				t.Fatal("Fork effect classification", r.Phase, f.calls.Load())
			}
			if state == "lost-response" || state == "late-source-denied" {
				var active int
				if e = f.db.QueryRow(`SELECT golf_repository_lifecycle_active($1,23)`, f.s.config.GiteaURL).Scan(&active); e != nil || active != 1 {
					t.Fatal("Unresolved source archive not fenced", e, active)
				}
				again, e := f.submit(t, session, m)
				if e != nil || again.Phase != phase || f.calls.Load() != 1 {
					t.Fatal("Unknown fork resent", e)
				}
			}
		})
	}
}

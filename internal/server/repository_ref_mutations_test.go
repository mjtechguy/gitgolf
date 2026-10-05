package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
)

func refFixtureRequest(k golfv1.RepositoryRefMutationKind) *golfv1.SubmitRepositoryRefMutationRequest {
	m := &golfv1.SubmitRepositoryRefMutationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", OwnerId: "42", AccessRevision: strings.Repeat("a", 64), OperationId: uuid.NewString(), Kind: k, Name: "topic/雪", CommitId: strings.Repeat("c", 40)}
	if refMutationKind(k) == "DELETE_TAG" {
		m.TagObjectId = m.CommitId
	}
	return m
}
func TestRefMutationInputAndFingerprint(t *testing.T) {
	m := refFixtureRequest(golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_CREATE_BRANCH)
	if e := validateRefMutation(m); e != nil {
		t.Fatal(e)
	}
	h := refMutationFingerprint(m)
	m.OperationId = uuid.NewString()
	if !bytes.Equal(h, refMutationFingerprint(m)) {
		t.Fatal("key bound as payload")
	}
	for _, field := range []string{"name", "kind", "commit", "repository", "owner", "revision", "object"} {
		c := proto.Clone(m).(*golfv1.SubmitRepositoryRefMutationRequest)
		switch field {
		case "name":
			c.Name = "other"
		case "kind":
			c.Kind = golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_CREATE_TAG
		case "commit":
			c.CommitId = strings.Repeat("d", 40)
		case "repository":
			c.RepositoryId = "12"
		case "owner":
			c.OwnerId = "43"
		case "revision":
			c.AccessRevision = strings.Repeat("d", 64)
		case "object":
			c.TagObjectId = strings.Repeat("d", 40)
		}
		if bytes.Equal(h, refMutationFingerprint(c)) {
			t.Fatal("unbound field", field)
		}
	}
	for _, name := range []string{"", "../evil", "refs/heads/topic", "topic\x00", "bad@{name", strings.Repeat("s", 1025)} {
		c := proto.Clone(m).(*golfv1.SubmitRepositoryRefMutationRequest)
		c.Name = name
		if validateRefMutation(c) == nil {
			t.Fatal("invalid name", name)
		}
	}
	for _, k := range []golfv1.RepositoryRefMutationKind{golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_CREATE_BRANCH, golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_DELETE_BRANCH, golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_CREATE_TAG, golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_DELETE_TAG} {
		if e := validateRefMutation(refFixtureRequest(k)); e != nil {
			t.Fatal(k, e)
		}
	}
}

type refMutationFixture struct {
	*releasePublicationFixture
	refs    sync.Mutex
	present bool
	writes  atomic.Int32
	modeRef atomic.Value
}

func newRefMutationFixture(t *testing.T, k golfv1.RepositoryRefMutationKind) *refMutationFixture {
	f := &refMutationFixture{releasePublicationFixture: newReleasePublicationFixture(t), present: !refMutationCreate(refMutationKind(k))}
	f.modeRef.Store("")
	target, _ := url.Parse(f.s.config.GiteaURL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := "/api/v1/repos/alice/private"
		mode := f.modeRef.Load().(string)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == base+"/branch_protections" || r.URL.Path == base+"/tag_protections" {
			if mode == "protected" {
				json.NewEncoder(w).Encode([]any{map[string]string{"rule_name": "*"}})
			} else {
				json.NewEncoder(w).Encode([]any{})
			}
			return
		}
		if r.URL.Path == base+"/git/commits/"+strings.Repeat("c", 40) {
			json.NewEncoder(w).Encode(map[string]any{"sha": strings.Repeat("c", 40), "commit": map[string]any{"tree": map[string]string{"sha": strings.Repeat("c", 40)}}})
			return
		}
		if strings.HasPrefix(r.URL.Path, base+"/git/refs/heads/") {
			name := strings.TrimPrefix(r.URL.Path, base+"/git/refs/heads/")
			if name == strings.Repeat("c", 40) {
				if mode == "sha-name" {
					json.NewEncoder(w).Encode([]any{map[string]any{"ref": "refs/heads/" + name, "object": map[string]string{"type": "commit", "sha": strings.Repeat("d", 40)}}})
				} else {
					w.WriteHeader(404)
				}
				return
			}
			if name == "topic/雪" {
				f.refs.Lock()
				present := f.present
				f.refs.Unlock()
				if !present {
					w.WriteHeader(404)
					return
				}
				sha := strings.Repeat("c", 40)
				if mode == "drift" || mode == "bad-readback" && f.writes.Load() > 0 {
					sha = strings.Repeat("d", 40)
				}
				json.NewEncoder(w).Encode([]any{map[string]any{"ref": "refs/heads/" + name, "object": map[string]string{"type": "commit", "sha": sha}}})
				return
			}
		}
		if r.Method == http.MethodGet && r.URL.Path == base+"/releases" {
			rows := []forgeRepositoryRelease{}
			if mode == "published" {
				row := releaseFixtureRow()
				row.TagName = "topic/雪"
				rows = append(rows, row)
			}
			w.Header().Set("X-Total-Count", strconv.Itoa(len(rows)))
			json.NewEncoder(w).Encode(rows)
			return
		}
		if strings.HasPrefix(r.URL.Path, base+"/releases/tags/") {
			if mode == "published" {
				json.NewEncoder(w).Encode(map[string]string{"tag_name": "topic/雪"})
			} else {
				w.WriteHeader(404)
			}
			return
		}
		if r.URL.Path == base+"/tags/"+strings.Repeat("c", 40) {
			w.WriteHeader(404)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == base+"/tags/topic/雪" {
			f.refs.Lock()
			present := f.present
			f.refs.Unlock()
			if !present {
				w.WriteHeader(404)
				return
			}
			tag := suffixTag("topic/雪", strings.Repeat("c", 40))
			tag.ID = strings.Repeat("c", 40)
			if mode == "drift" {
				tag.ID = strings.Repeat("d", 40)
			}
			json.NewEncoder(w).Encode(tag)
			return
		}
		if r.Method == http.MethodPost && (r.URL.Path == base+"/branches" || r.URL.Path == base+"/tags") || r.Method == http.MethodDelete && (r.URL.Path == base+"/branches/topic/雪" || r.URL.Path == base+"/tags/topic/雪") {
			f.writes.Add(1)
			f.refs.Lock()
			if mode != "ignored" {
				f.present = r.Method == http.MethodPost
			}
			f.refs.Unlock()
			if mode == "lost-response" {
				w.WriteHeader(500)
				return
			}
			if mode == "late-denied" {
				f.mode.Store("denied")
			}
			if r.Method == http.MethodDelete {
				w.WriteHeader(204)
				return
			}
			w.WriteHeader(201)
			if strings.HasSuffix(r.URL.Path, "branches") {
				json.NewEncoder(w).Encode(map[string]any{"name": "topic/雪", "commit": map[string]string{"id": strings.Repeat("c", 40)}})
			} else {
				tag := suffixTag("topic/雪", strings.Repeat("c", 40))
				tag.ID = strings.Repeat("c", 40)
				json.NewEncoder(w).Encode(tag)
			}
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(provider.Close)
	config := f.s.config
	config.GiteaURL = provider.URL
	config.GiteaPublicURL = provider.URL
	var e error
	f.s, e = New(config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *refMutationFixture) submitRef(t *testing.T, session loginResult, m *golfv1.SubmitRepositoryRefMutationRequest) (*golfv1.RepositoryRefMutationOperation, error) {
	t.Helper()
	ctx, _, header := f.scope(session)
	req := connect.NewRequest(m)
	req.Header().Set("Cookie", header.Get("Cookie"))
	req.Header().Set("Origin", header.Get("Origin"))
	r, e := f.s.SubmitRepositoryRefMutation(ctx, req)
	if e != nil {
		return nil, e
	}
	return r.Msg.Operation, nil
}
func (f *refMutationFixture) requestRef(t *testing.T, session loginResult, k golfv1.RepositoryRefMutationKind) *golfv1.SubmitRepositoryRefMutationRequest {
	m := refFixtureRequest(k)
	m.AccessRevision = f.request(t, session).AccessRevision
	return m
}
func TestRefMutationOnceAndLifecyclePostgres(t *testing.T) {
	for _, k := range []golfv1.RepositoryRefMutationKind{golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_CREATE_BRANCH, golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_DELETE_BRANCH, golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_CREATE_TAG, golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_DELETE_TAG} {
		t.Run(k.String(), func(t *testing.T) {
			f := newRefMutationFixture(t, k)
			session := f.session(t, "pat")
			m := f.requestRef(t, session, k)
			first, e := f.submitRef(t, session, m)
			if e != nil || first.Phase != golfv1.RepositoryRefMutationPhase_REPOSITORY_REF_MUTATION_PHASE_SUCCEEDED {
				t.Fatal("native success", e, first)
			}
			replay, e := f.submitRef(t, session, m)
			if e != nil || !proto.Equal(first, replay) || f.writes.Load() != 1 {
				t.Fatal("replayed mutation", e)
			}
			m.Name = "other"
			if _, e = f.submitRef(t, session, m); connect.CodeOf(e) != connect.CodeFailedPrecondition {
				t.Fatal("changed intent", e)
			}
			var events int
			f.db.QueryRow(`SELECT count(*) FROM golf_repository_ref_mutation_events`).Scan(&events)
			if events != 3 {
				t.Fatal("events", events)
			}
			if _, e = f.db.Exec(`UPDATE golf_repository_ref_mutations SET ref_name='changed'`); e == nil {
				t.Fatal("mutable journal")
			}
		})
	}
}
func TestRefMutationRefusalUnknownPostgres(t *testing.T) {
	for _, mode := range []string{"protected", "sha-name", "lost-response", "ignored", "bad-readback", "late-denied", "reader", "replacement", "archived", "mirror"} {
		t.Run(mode, func(t *testing.T) {
			k := golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_CREATE_BRANCH
			f := newRefMutationFixture(t, k)
			session := f.session(t, "pat")
			m := f.requestRef(t, session, k)
			if mode == "reader" || mode == "replacement" || mode == "archived" || mode == "mirror" {
				f.mode.Store(mode)
			} else {
				f.modeRef.Store(mode)
			}
			r, e := f.submitRef(t, session, m)
			if mode == "reader" || mode == "replacement" || mode == "archived" || mode == "mirror" {
				if f.writes.Load() != 0 || ((mode == "reader" || mode == "replacement") && e == nil) || ((mode == "archived" || mode == "mirror") && (e != nil || r.Phase != golfv1.RepositoryRefMutationPhase_REPOSITORY_REF_MUTATION_PHASE_REJECTED)) {
					t.Fatal("authority loss", e, r)
				}
				return
			}
			if mode == "late-denied" {
				if e == nil {
					t.Fatal("late authority accepted")
				}
				f.mode.Store("")
			} else if e != nil {
				t.Fatal(e)
			}
			want := golfv1.RepositoryRefMutationPhase_REPOSITORY_REF_MUTATION_PHASE_DISPATCH_UNKNOWN
			if mode == "protected" || mode == "sha-name" {
				want = golfv1.RepositoryRefMutationPhase_REPOSITORY_REF_MUTATION_PHASE_REJECTED
				if f.writes.Load() != 0 {
					t.Fatal("preflight wrote")
				}
			}
			replay, e := f.submitRef(t, session, m)
			if e != nil || replay.Phase != want || f.writes.Load() > 1 {
				t.Fatal("unknown replay", e, replay)
			}
			if want == golfv1.RepositoryRefMutationPhase_REPOSITORY_REF_MUTATION_PHASE_DISPATCH_UNKNOWN {
				ctx, token, _ := f.scope(session)
				base, _ := repositoryPath(keyFrom(m.Repository))
				if _, e = f.s.forge(ctx, http.MethodPatch, base, token, map[string]bool{"private": false}, nil); !errors.Is(e, errLifecycleBlocked) {
					t.Fatal("unknown did not exclude unrelated write", e)
				}
			}
		})
	}
	for _, mode := range []string{"published", "drift", "disabled"} {
		t.Run("delete-tag-"+mode, func(t *testing.T) {
			k := golfv1.RepositoryRefMutationKind_REPOSITORY_REF_MUTATION_KIND_DELETE_TAG
			f := newRefMutationFixture(t, k)
			session := f.session(t, "pat")
			m := f.requestRef(t, session, k)
			if mode == "disabled" {
				f.mode.Store("disabled")
			} else {
				f.modeRef.Store(mode)
			}
			r, e := f.submitRef(t, session, m)
			if e != nil || r.Phase != golfv1.RepositoryRefMutationPhase_REPOSITORY_REF_MUTATION_PHASE_REJECTED || f.writes.Load() != 0 {
				t.Fatal("destructive tag delete", e, r)
			}
		})
	}
}
func TestRefMutationManagedBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, procedure := range []string{golfv1connect.RepositoryRefMutationServiceSubmitRepositoryRefMutationProcedure, golfv1connect.RepositoryRefMutationServiceGetRepositoryRefMutationOperationProcedure} {
		for _, mode := range []string{"anonymous", "origin", "bearer"} {
			r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/rpc"+procedure, strings.NewReader(`{}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", s.config.PublicURL)
			want := 401
			if mode == "origin" {
				r.Header.Set("Origin", "https://foreign.invalid")
				want = 403
			}
			if mode == "bearer" {
				r.Header.Set("Authorization", "Bearer golf_ro_"+strings.Repeat("A", 43))
				want = 403
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("managed boundary", mode, w.Code)
			}
		}
	}
}

package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

const suffixTestCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const suffixOtherCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

type sourceSuffixFixture struct {
	s           *Server
	branches    map[string]string
	tags        map[string]forgeTag
	mode        atomic.Value
	lookups     atomic.Int32
	commits     atomic.Int32
	repoReads   atomic.Int32
	active      atomic.Int32
	maxActive   atomic.Int32
	mu          sync.Mutex
	branchReads map[string]int
	onLookup    func(context.Context)
}

func suffixTag(name, commit string) forgeTag {
	row := forgeTag{Name: name, ID: suffixOtherCommit}
	row.Commit.SHA = commit
	return row
}

func newSourceSuffixFixture(t *testing.T, db *sql.DB) *sourceSuffixFixture {
	t.Helper()
	f := &sourceSuffixFixture{branches: map[string]string{}, tags: map[string]forgeTag{}, branchReads: map[string]int{}}
	f.mode.Store("")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet {
			t.Error("suffix resolution issued a native write")
			w.WriteHeader(500)
			return
		}
		base := "/api/v1/repos/alice/private"
		mode := f.mode.Load().(string)
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
			return
		case "/api/v1/user":
			id := int64(42)
			if mode == "wrong-user" && f.lookups.Load() > 0 {
				id = 84
			}
			json.NewEncoder(w).Encode(User{ID: id, Login: "alice"})
			return
		case base:
			reads := f.repoReads.Add(1)
			if mode == "private-denied" && f.lookups.Load() > 0 {
				w.WriteHeader(404)
				return
			}
			id := int64(11)
			if mode == "rebound" && reads > 1 {
				id = 12
			}
			json.NewEncoder(w).Encode(Repository{ID: id, Name: "private", FullName: "alice/private", HTMLURL: "https://forge.invalid/alice/private", DefaultBranch: "main"})
			return
		}
		isBranch := strings.HasPrefix(r.URL.Path, base+"/git/refs/heads/")
		isTag := strings.HasPrefix(r.URL.Path, base+"/tags/")
		if isBranch || isTag {
			f.lookups.Add(1)
			active := f.active.Add(1)
			defer f.active.Add(-1)
			for old := f.maxActive.Load(); active > old && !f.maxActive.CompareAndSwap(old, active); old = f.maxActive.Load() {
			}
			if f.onLookup != nil {
				f.onLookup(r.Context())
			}
			if mode == "private-denied" || mode == "native-miss" {
				w.WriteHeader(404)
				return
			}
			if mode == "denied" && isTag {
				w.WriteHeader(403)
				return
			}
			if mode == "malformed" && isTag {
				w.Write([]byte(`{"name":"wrong","id":"invalid"}`))
				return
			}
			if mode == "oversize" && isTag {
				w.Write([]byte(strings.Repeat("x", maxForgeResponse+1)))
				return
			}
			if isBranch {
				name := strings.TrimPrefix(r.URL.Path, base+"/git/refs/heads/")
				f.mu.Lock()
				f.branchReads[name]++
				reads := f.branchReads[name]
				f.mu.Unlock()
				if mode == "vanished" && name == "main" && reads > 1 {
					w.WriteHeader(404)
					return
				}
				rows := []forgeSourceRef{}
				for branch, sha := range f.branches {
					if strings.HasPrefix(branch, name) {
						row := forgeSourceRef{Ref: "refs/heads/" + branch}
						row.Object.Type, row.Object.SHA = "commit", sha
						if mode == "moved" && reads > 1 {
							row.Object.SHA = suffixOtherCommit
						}
						rows = append(rows, row)
					}
				}
				if mode == "native-cap" {
					for i := range 2001 {
						row := forgeSourceRef{Ref: "refs/heads/" + name + "-" + strconv.Itoa(i)}
						row.Object.Type, row.Object.SHA = "commit", suffixTestCommit
						rows = append(rows, row)
					}
				}
				sort.Slice(rows, func(i, j int) bool { return rows[i].Ref < rows[j].Ref })
				json.NewEncoder(w).Encode(rows)
			} else {
				name := strings.TrimPrefix(r.URL.Path, base+"/tags/")
				row, exists := f.tags[name]
				if !exists {
					w.WriteHeader(404)
					return
				}
				json.NewEncoder(w).Encode(row)
			}
			return
		}
		if strings.HasPrefix(r.URL.Path, base+"/git/commits/") {
			f.commits.Add(1)
			if mode == "commit-missing" {
				w.WriteHeader(404)
				return
			}
			sha := strings.TrimPrefix(r.URL.Path, base+"/git/commits/")
			json.NewEncoder(w).Encode(map[string]any{"sha": sha, "commit": map[string]any{"tree": map[string]string{"sha": sha}}})
			return
		}
		t.Error("suffix resolution probed contents/tree/blob/inventory or unexpected endpoint", r.URL.Path)
		w.WriteHeader(500)
	}))
	t.Cleanup(provider.Close)
	var err error
	f.s, err = New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *sourceSuffixFixture) resolve(t *testing.T, suffix string) ([]*golfv1.RepositorySourceCandidate, error) {
	t.Helper()
	boundaries, err := sourceSuffixBoundaries(suffix)
	if err != nil {
		return nil, err
	}
	return f.s.resolveSourceSuffix(t.Context(), "/repos/alice/private", Repository{ID: 11}, forgeCredential{Kind: "pat", Token: "suffix-fixture"}, boundaries)
}

func TestSourceSuffixBoundaries(t *testing.T) {
	for _, suffix := range []string{"", "/main", "main/", "main//file", "main/../file", "main\\file", "main/\x00file", strings.Repeat("x", 4097), "bad?"} {
		if _, err := sourceSuffixBoundaries(suffix); connect.CodeOf(rpcError(err)) != connect.CodeInvalidArgument {
			t.Fatal("invalid suffix admitted", suffix, err)
		}
	}
	parts := make([]string, 32)
	for i := range parts {
		parts[i] = "seg" + strconv.Itoa(i)
	}
	boundaries, err := sourceSuffixBoundaries(strings.Join(parts, "/"))
	if err != nil || len(boundaries) != 32 || boundaries[31].path != "" {
		t.Fatal("whole suffix/boundary limit", err)
	}
	if _, err := sourceSuffixBoundaries(strings.Join(append(parts, "extra"), "/")); connect.CodeOf(rpcError(err)) != connect.CodeResourceExhausted {
		t.Fatal("33 boundaries not refused", err)
	}
	boundaries, err = sourceSuffixBoundaries("release/雪/docs/literal %2F #?.txt")
	if err != nil || len(boundaries) != 3 || boundaries[0].path != "雪/docs/literal %2F #?.txt" || boundaries[2].name != "release/雪/docs" {
		t.Fatal("literal suffix changed", err)
	}
}

func TestSourceSuffixInvalidInputBeforeNative(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(500)
	}))
	defer provider.Close()
	s, _ := New(testConfig(provider.URL), nil)
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "fixture"})
	for _, input := range []*golfv1.ResolveRepositorySourceRequest{
		{Repository: pullKey, RepositoryId: "11", Suffix: "main/file", Selector: &golfv1.RepositorySourceSelector{Kind: golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH, Name: "main"}},
		{Repository: pullKey, RepositoryId: "11", Suffix: "main/file", Path: "other"},
		{Repository: pullKey, RepositoryId: "11", Suffix: "main//file"},
		{Repository: pullKey, RepositoryId: "11", Suffix: "main/\xff"},
		{Repository: pullKey, RepositoryId: "11", Suffix: "bad?"},
		{Repository: pullKey, RepositoryId: "11", Suffix: strings.Repeat("x", 4097)},
		{Repository: pullKey, RepositoryId: "01", Suffix: "main"},
	} {
		if _, err := s.ResolveRepositorySource(ctx, connect.NewRequest(input)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid suffix input reached native authority", err)
		}
	}
	if _, err := s.ResolveRepositorySource(ctx, connect.NewRequest(&golfv1.ResolveRepositorySourceRequest{Repository: pullKey, RepositoryId: "11", Suffix: strings.Repeat("s/", 32) + "s"})); connect.CodeOf(err) != connect.CodeResourceExhausted {
		t.Fatal("split exhaustion not refused before dispatch", err)
	}
	if calls.Load() != 0 {
		t.Fatal("invalid suffix input contacted native provider")
	}
}

func TestSourceSuffixExactNamespaceCandidates(t *testing.T) {
	for _, mode := range []string{"unique", "same-sha", "different-sha", "slash-boundary", "prefix-neighbor", "literal", "whole-tag", "sha-no-guess"} {
		t.Run(mode, func(t *testing.T) {
			f := newSourceSuffixFixture(t, nil)
			suffix := "main/README.md"
			f.branches["main"] = suffixTestCommit
			want := 1
			switch mode {
			case "same-sha":
				f.tags["main"] = suffixTag("main", suffixTestCommit)
				want = 2
			case "different-sha":
				f.tags["main"] = suffixTag("main", suffixOtherCommit)
				want = 2
			case "slash-boundary":
				delete(f.branches, "main")
				f.branches["feature"] = suffixTestCommit
				f.tags["feature/topic"] = suffixTag("feature/topic", suffixOtherCommit)
				suffix = "feature/topic/nonexistent.txt"
				want = 2
			case "prefix-neighbor":
				delete(f.branches, "main")
				f.branches["main-neighbor"] = suffixTestCommit
				want = 0
			case "literal":
				delete(f.branches, "main")
				f.branches["release/雪%2F"] = suffixTestCommit
				suffix = "release/雪%2F/literal %25 #?.txt"
			case "whole-tag":
				delete(f.branches, "main")
				f.tags["release/v1"] = suffixTag("release/v1", suffixTestCommit)
				suffix = "release/v1"
			case "sha-no-guess":
				delete(f.branches, "main")
				suffix = suffixTestCommit
				want = 0
			}
			candidates, err := f.resolve(t, suffix)
			if err != nil || len(candidates) != want {
				t.Fatal("exact namespace candidates", len(candidates), err)
			}
			for _, candidate := range candidates {
				value := candidate.Selection.Name
				if candidate.Path != "" {
					value += "/" + candidate.Path
				}
				if value != suffix {
					t.Fatal("candidate cannot reconstruct literal suffix")
				}
			}
			if mode == "same-sha" && (candidates[0].Selection.Kind == candidates[1].Selection.Kind || candidates[0].Selection.CommitId != candidates[1].Selection.CommitId) {
				t.Fatal("same-SHA namespace ambiguity lost")
			}
			if mode == "slash-boundary" && (candidates[0].Path != "topic/nonexistent.txt" || candidates[1].Path != "nonexistent.txt") {
				t.Fatal("longest-prefix/path existence used to choose")
			}
			if mode == "whole-tag" && candidates[0].Path != "" {
				t.Fatal("whole-suffix ref omitted")
			}
			if mode == "sha-no-guess" && f.commits.Load() != 0 {
				t.Fatal("suffix guessed commit namespace")
			}
		})
	}
}

func TestSourceSuffixIncompleteChecks(t *testing.T) {
	for _, mode := range []string{"denied", "malformed", "oversize", "native-cap", "moved", "vanished", "commit-missing"} {
		t.Run(mode, func(t *testing.T) {
			f := newSourceSuffixFixture(t, nil)
			f.mode.Store(mode)
			f.branches["main"] = suffixTestCommit
			candidates, err := f.resolve(t, "main/file")
			if err == nil || candidates != nil {
				t.Fatal("unresolved namespace yielded partial candidates", mode)
			}
			if (mode == "vanished" || mode == "commit-missing") && connect.CodeOf(rpcError(err)) != connect.CodeFailedPrecondition {
				t.Fatal("present selection vanished into apparent absence", err)
			}
		})
	}
}

func TestSourceSuffixConcurrencyAndCancellation(t *testing.T) {
	f := newSourceSuffixFixture(t, nil)
	started, release := make(chan struct{}, 4), make(chan struct{})
	f.onLookup = func(ctx context.Context) {
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-ctx.Done():
		}
	}
	parts := make([]string, 32)
	for i := range parts {
		parts[i] = "s" + strconv.Itoa(i)
	}
	suffix := strings.Join(parts, "/")
	terminal := make(chan error, 1)
	go func() { _, err := f.resolve(t, suffix); terminal <- err }()
	for range 4 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("four bounded workers did not start")
		}
	}
	close(release)
	if err := <-terminal; err != nil || f.lookups.Load() != 64 || f.maxActive.Load() != 4 {
		t.Fatal("namespace job concurrency/completeness", f.lookups.Load(), f.maxActive.Load(), err)
	}
	for _, deadline := range []bool{false, true} {
		f := newSourceSuffixFixture(t, nil)
		f.onLookup = func(ctx context.Context) { <-ctx.Done() }
		boundaries, _ := sourceSuffixBoundaries("main/file")
		ctx, cancel := context.WithCancel(t.Context())
		if deadline {
			ctx, cancel = context.WithTimeout(t.Context(), 20*time.Millisecond)
		} else {
			cancel()
		}
		candidates, err := f.s.resolveSourceSuffix(ctx, "/repos/alice/private", Repository{ID: 11}, forgeCredential{Kind: "pat", Token: "fixture"}, boundaries)
		cancel()
		if candidates != nil || err == nil || (!errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded)) {
			t.Fatal("cancel/deadline fabricated resolution", err)
		}
	}
}

func TestSourceSuffixRPCBindingPostgres(t *testing.T) {
	for _, mode := range []string{"unique", "same-sha", "different-sha", "missing", "native-miss", "private-denied", "denied", "wrong-id", "wrong-user", "rebound", "local-revoked", "commit-missing", "vanished"} {
		t.Run(mode, func(t *testing.T) {
			f := newSourceSuffixFixture(t, testDatabase(t))
			f.mode.Store(mode)
			if mode != "missing" && mode != "native-miss" {
				f.branches["main"] = suffixTestCommit
			}
			if mode == "same-sha" {
				f.tags["main"] = suffixTag("main", suffixTestCommit)
			}
			if mode == "different-sha" {
				f.tags["main"] = suffixTag("main", suffixOtherCommit)
			}
			session, err := f.s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "suffix-fixture", "")
			if err != nil {
				t.Fatal(err)
			}
			if mode == "local-revoked" {
				var once sync.Once
				f.onLookup = func(context.Context) {
					once.Do(func() {
						if err := f.s.logoutSession(t.Context(), session.Value); err != nil {
							t.Error(err)
						}
					})
				}
			}
			ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "suffix-fixture"})
			id := "11"
			if mode == "wrong-id" {
				id = "12"
			}
			req := connect.NewRequest(&golfv1.ResolveRepositorySourceRequest{Repository: pullKey, RepositoryId: id, Suffix: "main/README.md"})
			req.Header().Set("Cookie", f.s.sessionCookie(session.Value, session.Expires, 3600).String())
			res, err := f.s.ResolveRepositorySource(ctx, req)
			if mode == "unique" {
				if err != nil || res.Msg.Resolution != golfv1.RepositorySourceResolution_REPOSITORY_SOURCE_RESOLUTION_RESOLVED || len(res.Msg.Candidates) != 1 || res.Msg.Selection.CommitId != suffixTestCommit || res.Msg.Suffix != req.Msg.Suffix || res.Msg.Path != "README.md" || res.Msg.RepositoryId != "11" {
					t.Fatal("exact unique suffix receipt", err)
				}
				// Additive typed callers remain explicit RESOLVED with no suffix candidates.
				req.Msg.Suffix = ""
				req.Msg.Selector = &golfv1.RepositorySourceSelector{Kind: golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH, Name: "main"}
				req.Msg.Path = "README.md"
				res, err = f.s.ResolveRepositorySource(ctx, req)
				if err != nil || res.Msg.Resolution != golfv1.RepositorySourceResolution_REPOSITORY_SOURCE_RESOLUTION_RESOLVED || len(res.Msg.Candidates) != 0 || res.Msg.Suffix != "" {
					t.Fatal("typed response compatibility lost", err)
				}
				grant := connect.NewRequest(&golfv1.CreateApiCredentialRequest{Label: "suffix"})
				grant.Header().Set("Cookie", req.Header().Get("Cookie"))
				issued, err := f.s.CreateApiCredential(ctx, grant)
				if err != nil {
					t.Fatal(err)
				}
				req.Msg.Selector = nil
				req.Msg.Path = ""
				req.Msg.Suffix = "main/README.md"
				body, _ := protojson.Marshal(req.Msg)
				if response := apiRequest(f.s, issued.Msg.Token, golfv1connect.RepositoryServiceResolveRepositorySourceProcedure, string(body)); response.Code != 200 {
					t.Fatal("suffix read-only delegation denied", response.Code)
				}
			} else if mode == "same-sha" || mode == "different-sha" {
				if err != nil || res.Msg.Resolution != golfv1.RepositorySourceResolution_REPOSITORY_SOURCE_RESOLUTION_AMBIGUOUS || len(res.Msg.Candidates) != 2 || res.Msg.Selection != nil || res.Msg.Path != "" {
					t.Fatal("namespace collision guessed", err)
				}
			} else {
				if err == nil || res != nil {
					t.Fatal("wrong/incomplete authority returned resolution", mode)
				}
				if (mode == "missing" || mode == "native-miss") && connect.CodeOf(err) != connect.CodeNotFound {
					t.Fatal("complete zero-match not found lost", err)
				}
				if (mode == "vanished" || mode == "commit-missing") && connect.CodeOf(err) != connect.CodeFailedPrecondition {
					t.Fatal("positive selection presented as zero-match absence", err)
				}
			}
		})
	}
}

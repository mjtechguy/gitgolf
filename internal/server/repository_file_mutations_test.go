package server

import (
	"bytes"
	"connectrpc.com/connect"
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func fileFixtureRequest(k golfv1.RepositoryFileMutationKind) *golfv1.SubmitRepositoryFileMutationRequest {
	m := &golfv1.SubmitRepositoryFileMutationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", OwnerId: "42", AccessRevision: strings.Repeat("a", 64), OperationId: uuid.NewString(), Kind: k, Branch: "main", ExpectedCommitId: strings.Repeat("c", 40), Path: "雪-%25.txt", Content: []byte("new\x00bytes"), CommitMessage: "Create an exact file"}
	if k != golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE {
		m.ExpectedBlobId = sourceBlobHash([]byte("old"), 40)
	}
	if k == golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_DELETE {
		m.Content = nil
	}
	return m
}
func TestFileMutationInputNativeContract(t *testing.T) {
	m := fileFixtureRequest(golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE)
	if e := validateFileMutation(m); e != nil {
		t.Fatal(e)
	}
	h := fileMutationFingerprint(m)
	m.OperationId = uuid.NewString()
	if !bytes.Equal(h, fileMutationFingerprint(m)) {
		t.Fatal("operation key fingerprint")
	}
	for _, f := range []string{"content", "message", "head", "path", "branch", "sha", "kind"} {
		c := proto.Clone(m).(*golfv1.SubmitRepositoryFileMutationRequest)
		switch f {
		case "content":
			c.Content = []byte("different")
		case "message":
			c.CommitMessage = "different"
		case "head":
			c.ExpectedCommitId = strings.Repeat("d", 40)
		case "path":
			c.Path = "other"
		case "branch":
			c.Branch = "topic"
		case "sha":
			c.ExpectedBlobId = strings.Repeat("d", 40)
		case "kind":
			c.Kind = golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_UPDATE
		}
		if bytes.Equal(h, fileMutationFingerprint(c)) {
			t.Fatal("unbound", f)
		}
	}
	for _, path := range []string{"", "../evil", "x//y", "a/.GiT/config", strings.Repeat("雪", 167)} {
		c := proto.Clone(m).(*golfv1.SubmitRepositoryFileMutationRequest)
		c.Path = path
		if validateFileMutation(c) == nil {
			t.Fatal("accepted path", path)
		}
	}
	c := proto.Clone(m).(*golfv1.SubmitRepositoryFileMutationRequest)
	c.Content = make([]byte, maxPreviewBytes+1)
	if validateFileMutation(c) == nil {
		t.Fatal("oversized content")
	}
	for _, k := range []golfv1.RepositoryFileMutationKind{golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE, golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_UPDATE, golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_DELETE} {
		m = fileFixtureRequest(k)
		if e := validateFileMutation(m); e != nil {
			t.Fatal(e)
		}
		r := fileMutationRecord{Kind: fileMutationKind(k), Branch: m.Branch, Path: m.Path, ExpectedBlob: m.ExpectedBlobId}
		method, path, payload := fileMutationNative(r, m.Content, m.CommitMessage)
		data, _ := json.Marshal(payload)
		var body map[string]any
		json.Unmarshal(data, &body)
		if strings.Contains(string(data), "last_commit") || strings.Contains(string(data), "author") || path != "/contents/%E9%9B%AA-%2525.txt" || method == "" || body["branch"] != "main" {
			t.Fatal("invented native API", method, path, string(data))
		}
		if k != golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE && body["sha"] != m.ExpectedBlobId {
			t.Fatal("missing native SHA")
		}
	}
}

type fileMutationFixture struct {
	*releasePublicationFixture
	mu       sync.Mutex
	kind     string
	head     string
	data     []byte
	present  bool
	writes   atomic.Int32
	fileMode atomic.Value
}

func newFileMutationFixture(t *testing.T, k golfv1.RepositoryFileMutationKind) *fileMutationFixture {
	f := &fileMutationFixture{releasePublicationFixture: newReleasePublicationFixture(t), kind: fileMutationKind(k), head: strings.Repeat("c", 40), data: []byte("old"), present: fileMutationKind(k) != "CREATE"}
	f.fileMode.Store("")
	target, _ := url.Parse(f.s.config.ForgeURL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := "/api/v1/repos/alice/private"
		mode := f.fileMode.Load().(string)
		w.Header().Set("Content-Type", "application/json")
		if mode == "renamed" && (r.URL.Path == "/api/v1/repositories/11" || r.URL.Path == "/api/v1/repos/alice/renamed") {
			row := settingsFixtureRow()
			row.ID = 11
			row.Name = "renamed"
			row.FullName = "alice/renamed"
			row.HTMLURL = "https://forge.invalid/alice/renamed"
			cfg := rulesRepositoryFixture()
			cfg.forgeRepositorySettings = row
			data, _ := json.Marshal(cfg)
			var observed map[string]any
			json.Unmarshal(data, &observed)
			observed["permissions"] = map[string]bool{"admin": true, "push": true, "pull": true}
			observed["has_actions"] = false
			json.NewEncoder(w).Encode(observed)
			return
		}
		if mode == "writer" && r.URL.Path == base {
			row := settingsFixtureRow()
			row.ID = 11
			row.Name = "private"
			row.FullName = "alice/private"
			row.HTMLURL = "https://forge.invalid/alice/private"
			cfg := rulesRepositoryFixture()
			cfg.forgeRepositorySettings = row
			data, _ := json.Marshal(cfg)
			var observed map[string]any
			json.Unmarshal(data, &observed)
			observed["permissions"] = map[string]bool{"admin": false, "push": true, "pull": true}
			observed["has_actions"] = false
			json.NewEncoder(w).Encode(observed)
			return
		}
		if mode == "writer" && r.URL.Path == base+"/collaborators/bob/permission" {
			json.NewEncoder(w).Encode(map[string]any{"permission": "write", "user": User{ID: 43, Login: "bob"}})
			return
		}

		if mode == "renamed" && strings.HasPrefix(r.URL.Path, "/api/v1/repos/alice/renamed/") {
			r.URL.Path = strings.Replace(r.URL.Path, "/api/v1/repos/alice/renamed/", base+"/", 1)
			proxy.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/api/v1/repositories/11" {
			r.URL.Path = base
			proxy.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == base+"/branch_protections" {
			if mode == "writer" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			rows := []any{}
			if mode == "protected" {
				rows = append(rows, map[string]string{"rule_name": "*"})
			}
			json.NewEncoder(w).Encode(rows)
			return
		}
		if r.URL.Path == base+"/branches/main" {
			row := map[string]any{"name": "main", "commit": map[string]string{"id": f.currentHead()}, "protected": mode == "protected", "user_can_merge": true}
			if mode == "unknown-protection" {
				delete(row, "protected")
			}
			if mode == "foreign-branch" {
				row["name"] = "foreign"
			}
			if mode == "projection-drift" {
				row["commit"] = map[string]string{"id": strings.Repeat("f", 40)}
			}
			if mode == "head-drift" {
				row["commit"] = map[string]string{"id": strings.Repeat("e", 40)}
			}
			json.NewEncoder(w).Encode(row)
			return
		}

		if strings.HasPrefix(r.URL.Path, base+"/git/refs/heads/") {
			sha := f.currentHead()
			if mode == "head-drift" {
				sha = strings.Repeat("e", 40)
			}
			json.NewEncoder(w).Encode([]any{map[string]any{"ref": "refs/heads/main", "object": map[string]string{"type": "commit", "sha": sha}}})
			return
		}
		if strings.HasPrefix(r.URL.Path, base+"/git/commits/") {
			sha := strings.TrimPrefix(r.URL.Path, base+"/git/commits/")
			json.NewEncoder(w).Encode(map[string]any{"sha": sha, "commit": map[string]any{"tree": map[string]string{"sha": sha}}})
			return
		}
		if strings.HasPrefix(r.URL.Path, base+"/git/trees/") {
			f.mu.Lock()
			present := f.present
			data := append([]byte(nil), f.data...)
			f.mu.Unlock()
			rows := []sourceTreeEntry{}
			if present {
				typ, modeBits := "blob", "100644"
				if mode == "symlink" {
					modeBits = "120000"
				}
				sha := sourceBlobHash(data, 40)
				if mode == "blob-drift" {
					sha = strings.Repeat("f", 40)
				}
				rows = append(rows, sourceTreeEntry{Path: "雪-%25.txt", Mode: modeBits, Type: typ, SHA: sha, Size: int64(len(data))})
			}
			sha := strings.TrimPrefix(r.URL.Path, base+"/git/trees/")
			json.NewEncoder(w).Encode(sourceTree{SHA: sha, Entries: rows, Page: 1, Total: len(rows)})
			return
		}
		if strings.HasPrefix(r.URL.Path, base+"/git/blobs/") {
			f.mu.Lock()
			data := append([]byte(nil), f.data...)
			f.mu.Unlock()
			if mode == "lfs" {
				data = []byte("version https://git-lfs.github.com/spec/v1\n")
			}
			json.NewEncoder(w).Encode(map[string]any{"sha": sourceBlobHash(data, 40), "size": len(data), "encoding": "base64", "content": base64.StdEncoding.EncodeToString(data)})
			return
		}
		if r.URL.Path == base+"/contents/雪-%25.txt" && r.Method != http.MethodGet {
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			f.writes.Add(1)
			data, _ := base64.StdEncoding.DecodeString(body["content"])
			f.mu.Lock()
			if mode != "ignored" {
				f.head = strings.Repeat("d", 40)
				f.data = data
				f.present = r.Method != http.MethodDelete
			}
			f.mu.Unlock()
			if mode == "lost" {
				w.WriteHeader(500)
				return
			}
			if mode == "late-denied" {
				f.mode.Store("denied")
			}
			status := 200
			if r.Method == http.MethodPost {
				status = 201
			}
			w.WriteHeader(status)
			var content any
			if r.Method != http.MethodDelete {
				content = map[string]any{"path": "雪-%25.txt", "sha": sourceBlobHash(data, 40), "type": "file", "size": len(data)}
			}
			parent := strings.Repeat("c", 40)
			if mode == "wrong-parent" {
				parent = strings.Repeat("e", 40)
			}
			json.NewEncoder(w).Encode(map[string]any{"content": content, "commit": map[string]any{"sha": strings.Repeat("d", 40), "parents": []any{map[string]string{"sha": parent}}, "message": strings.TrimSpace(body["message"]) + "\n"}})
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(provider.Close)
	config := f.s.config
	config.ForgeURL = provider.URL
	config.ForgePublicURL = provider.URL
	var e error
	f.s, e = New(config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *fileMutationFixture) currentHead() string { f.mu.Lock(); defer f.mu.Unlock(); return f.head }
func (f *fileMutationFixture) submitFile(t *testing.T, session loginResult, m *golfv1.SubmitRepositoryFileMutationRequest) (*golfv1.RepositoryFileMutationOperation, error) {
	ctx, _, h := f.scope(session)
	if session.User.ID == 43 {
		ctx = context.WithValue(ctx, sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "other-pat"})
	}
	req := connect.NewRequest(m)
	req.Header().Set("Cookie", h.Get("Cookie"))
	req.Header().Set("Origin", h.Get("Origin"))
	r, e := f.s.SubmitRepositoryFileMutation(ctx, req)
	if e != nil {
		return nil, e
	}
	return r.Msg.Operation, nil
}
func TestFileMutationOnceAndUnknownPostgres(t *testing.T) {
	for _, k := range []golfv1.RepositoryFileMutationKind{golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE, golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_UPDATE, golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_DELETE} {
		t.Run(k.String(), func(t *testing.T) {
			f := newFileMutationFixture(t, k)
			session := f.session(t, "pat")
			m := fileFixtureRequest(k)
			m.AccessRevision = f.request(t, session).AccessRevision
			first, e := f.submitFile(t, session, m)
			if e != nil || first.Phase != golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_SUCCEEDED {
				t.Fatal("first", e, first)
			}
			second, e := f.submitFile(t, session, m)
			if e != nil || !proto.Equal(first, second) || f.writes.Load() != 1 {
				t.Fatal("replay", e, second)
			}
			if k == golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_DELETE {
				m.CommitMessage += "changed"
			} else {
				m.Content = []byte("changed")
			}
			if _, e = f.submitFile(t, session, m); connect.CodeOf(e) != connect.CodeFailedPrecondition {
				t.Fatal("changed intent", e)
			}
			var events int
			f.db.QueryRow(`SELECT count(*) FROM golf_repository_file_mutation_events`).Scan(&events)
			if events != 3 {
				t.Fatal("events", events)
			}
			if _, e = f.db.Exec(`UPDATE golf_repository_file_mutations SET file_path='changed'`); e == nil {
				t.Fatal("mutable original")
			}
		})
	}
	for _, mode := range []string{"protected", "unknown-protection", "foreign-branch", "projection-drift", "head-drift", "lost", "ignored", "wrong-parent", "late-denied", "reader", "replacement", "archived", "mirror"} {
		t.Run(mode, func(t *testing.T) {
			k := golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE
			f := newFileMutationFixture(t, k)
			session := f.session(t, "pat")
			m := fileFixtureRequest(k)
			m.AccessRevision = f.request(t, session).AccessRevision
			if mode == "reader" || mode == "replacement" || mode == "archived" || mode == "mirror" {
				f.mode.Store(mode)
			} else {
				f.fileMode.Store(mode)
			}
			r, e := f.submitFile(t, session, m)
			if mode == "reader" || mode == "replacement" || mode == "archived" || mode == "mirror" {
				if e == nil || f.writes.Load() != 0 {
					t.Fatal("authority", e)
				}
				return
			}
			if mode == "late-denied" {
				if e == nil {
					t.Fatal("late private response")
				}
				f.mode.Store("")
			} else if e != nil {
				t.Fatal(e)
			}
			want := golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_DISPATCH_UNKNOWN
			if mode == "protected" || mode == "unknown-protection" || mode == "foreign-branch" || mode == "projection-drift" || mode == "head-drift" {
				want = golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_REJECTED
				if f.writes.Load() != 0 {
					t.Fatal("refused wrote")
				}
			}
			r, e = f.submitFile(t, session, m)
			if e != nil || r.Phase != want || f.writes.Load() > 1 {
				t.Fatal("unknown replay", e, r)
			}
			if want == golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_DISPATCH_UNKNOWN {
				ctx, token, _ := f.scope(session)
				base, _ := repositoryPath(keyFrom(m.Repository))
				if _, e = f.s.forge(ctx, http.MethodPatch, base, token, map[string]bool{"private": false}, nil); e == nil {
					t.Fatal("unresolved allowed foreignwrite")
				}
			}
		})
	}
}

func TestFileMutationBlobAndOriginalAuthorityPostgres(t *testing.T) {
	for _, mode := range []string{"blob-drift", "symlink", "lfs", "ancestor-symlink"} {
		t.Run(mode, func(t *testing.T) {
			k := golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_UPDATE
			if mode == "ancestor-symlink" {
				k = golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE
			}
			f := newFileMutationFixture(t, k)
			session := f.session(t, "pat")
			m := fileFixtureRequest(k)
			m.AccessRevision = f.request(t, session).AccessRevision
			if mode == "lfs" {
				f.mu.Lock()
				f.data = []byte("version https://git-lfs.github.com/spec/v1\n")
				f.mu.Unlock()
				m.ExpectedBlobId = sourceBlobHash(f.data, 40)
			}
			if mode == "ancestor-symlink" {
				f.mu.Lock()
				f.present = true
				f.mu.Unlock()
				f.fileMode.Store("symlink")
				m.Path += "/child.txt"
			} else {
				f.fileMode.Store(mode)
			}
			o, e := f.submitFile(t, session, m)
			if e != nil || o.Phase != golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_REJECTED || f.writes.Load() != 0 {
				t.Fatal("special/stale file wrote", e, o)
			}
		})
	}
	t.Run("original-selected-ID-rename-and-denial", func(t *testing.T) {
		f := newFileMutationFixture(t, golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE)
		session := f.session(t, "pat")
		m := fileFixtureRequest(golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE)
		m.AccessRevision = f.request(t, session).AccessRevision
		first, e := f.submitFile(t, session, m)
		if e != nil {
			t.Fatal(e)
		}
		ctx, _, h := f.scope(session)
		req := connect.NewRequest(&golfv1.GetRepositoryFileMutationOperationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, OperationId: m.OperationId})
		req.Header().Set("Cookie", h.Get("Cookie"))
		req.Header().Set("Origin", h.Get("Origin"))
		f.fileMode.Store("renamed")
		status, e := f.s.GetRepositoryFileMutationOperation(ctx, req)
		if e != nil || !proto.Equal(first, status.Msg.Operation) || f.writes.Load() != 1 {
			t.Fatal("authorized original-ID rename", e, status)
		}
		f.fileMode.Store("")
		for _, mode := range []string{"reader", "replacement", "denied"} {
			f.mode.Store(mode)
			status, e = f.s.GetRepositoryFileMutationOperation(ctx, req)
			if connect.CodeOf(e) != connect.CodeNotFound || status != nil {
				t.Fatal("private original authority leaked", mode, e, status)
			}
		}
	})
}

func TestFileMutationOrdinaryWriterPostgres(t *testing.T) {
	f := newFileMutationFixture(t, golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE)
	owner := f.session(t, "pat")
	m := fileFixtureRequest(golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE)
	m.AccessRevision = f.request(t, owner).AccessRevision
	writer, e := f.s.createSession(t.Context(), User{ID: 43, Login: "bob"}, "pat", "other-pat", "")
	if e != nil {
		t.Fatal(e)
	}
	f.fileMode.Store("writer")
	req := connect.NewRequest(&golfv1.GetRepositoryFileMutationAccessRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, AccessRevision: m.AccessRevision, Branch: m.Branch})
	_, _, headers := f.scope(writer)
	req.Header().Set("Cookie", headers.Get("Cookie"))
	req.Header().Set("Origin", headers.Get("Origin"))
	ctx, _, _ := f.scope(writer)
	ctx = context.WithValue(ctx, sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "other-pat"})
	access, e := f.s.GetRepositoryFileMutationAccess(ctx, req)
	if e != nil || !access.Msg.CanWrite || access.Msg.Protected || access.Msg.CommitId != m.ExpectedCommitId {
		t.Fatal("writer projection", e, access)
	}
	first, e := f.submitFile(t, writer, m)
	if e != nil || first.Phase != golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_SUCCEEDED || first.ActorId != "43" || f.writes.Load() != 1 {
		t.Fatal("ordinary writer", e, first)
	}
	replay, e := f.submitFile(t, writer, m)
	if e != nil || !proto.Equal(first, replay) || f.writes.Load() != 1 {
		t.Fatal("writer replay", e, replay)
	}
	f.fileMode.Store("")
	f.mode.Store("reader")
	if _, e = f.submitFile(t, writer, m); e == nil {
		t.Fatal("revoked writer disclosed original")
	}
}

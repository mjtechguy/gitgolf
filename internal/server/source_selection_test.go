package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path"
	"sort"
	"strconv"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

type sourceObjectFixture struct {
	commit string
	root   []sourceTreeEntry
	trees  map[string][]sourceTreeEntry
	blobs  map[string][]byte
}

func newSourceObjectFixture(commit string, files map[string]string, kinds map[string]string) *sourceObjectFixture {
	f := &sourceObjectFixture{commit: commit, trees: map[string][]sourceTreeEntry{}, blobs: map[string][]byte{}}
	dirs := map[string][]sourceTreeEntry{}
	for name, text := range files {
		data := []byte(text)
		id := sourceBlobHash(data, len(commit))
		f.blobs[id] = data
		mode, kind := "100644", "blob"
		switch kinds[name] {
		case "symlink":
			mode = "120000"
		case "submodule":
			mode, kind = "160000", "commit"
		}
		dirs[path.Dir(name)] = append(dirs[path.Dir(name)], sourceTreeEntry{Path: path.Base(name), Mode: mode, Type: kind, SHA: id, Size: int64(len(data))})
	}
	for dir := range dirs {
		for parent := path.Dir(dir); parent != "."; parent = path.Dir(parent) {
			if _, ok := dirs[parent]; !ok {
				dirs[parent] = nil
			}
		}
	}
	names := make([]string, 0, len(dirs))
	for dir := range dirs {
		if dir != "." {
			names = append(names, dir)
		}
	}
	sort.Slice(names, func(i, j int) bool { return strings.Count(names[i], "/") > strings.Count(names[j], "/") })
	for _, dir := range names {
		rows := dirs[dir]
		id := sourceTreeHash(rows, len(commit))
		f.trees[id] = rows
		parent := path.Dir(dir)
		dirs[parent] = append(dirs[parent], sourceTreeEntry{Path: path.Base(dir), Mode: "040000", Type: "tree", SHA: id})
	}
	f.root = dirs["."]
	return f
}
func (f *sourceObjectFixture) serve(w http.ResponseWriter, r *http.Request, base string) bool {
	switch {
	case strings.HasPrefix(r.URL.Path, base+"/git/commits/"):
		id := strings.TrimPrefix(r.URL.Path, base+"/git/commits/")
		if id != f.commit {
			w.WriteHeader(404)
		} else {
			json.NewEncoder(w).Encode(map[string]any{"sha": id, "commit": map[string]any{"tree": map[string]string{"sha": id}}})
		}
		return true
	case strings.HasPrefix(r.URL.Path, base+"/git/trees/"):
		id := strings.TrimPrefix(r.URL.Path, base+"/git/trees/")
		rows, ok := f.trees[id]
		if id == f.commit {
			rows, ok = f.root, true
		}
		if !ok {
			w.WriteHeader(404)
			return true
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		size := min(2, len(rows))
		start := min((page-1)*size, len(rows))
		end := min(start+size, len(rows))
		json.NewEncoder(w).Encode(sourceTree{SHA: id, Entries: rows[start:end], Page: page, Total: len(rows), Truncated: end < len(rows)})
		return true
	case strings.HasPrefix(r.URL.Path, base+"/git/blobs/"):
		id := strings.TrimPrefix(r.URL.Path, base+"/git/blobs/")
		data, ok := f.blobs[id]
		if !ok {
			w.WriteHeader(404)
		} else {
			json.NewEncoder(w).Encode(map[string]any{"sha": id, "size": len(data), "encoding": "base64", "content": base64.StdEncoding.EncodeToString(data)})
		}
		return true
	}
	return false
}
func TestSourceObjectExactRead(t *testing.T) {
	const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	f := newSourceObjectFixture(sha, map[string]string{"plain.txt": "hello\n", "nested/雪 %.txt": "unchanged bytes\t\n"}, nil)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !f.serve(w, r, "/api/v1/repos/a/r") {
			t.Error("unexpected non-object read")
			w.WriteHeader(500)
		}
	}))
	defer provider.Close()
	s, _ := New(testConfig(provider.URL), nil)
	token := forgeCredential{Kind: "pat", Token: "fixture"}
	for _, name := range []string{"", "nested", "nested/雪 %.txt", "plain.txt"} {
		result, err := s.readContentsAtCommit(t.Context(), "/repos/a/r", token, sha, name)
		if err != nil || result.CommitID != sha || result.Path != name {
			t.Fatalf("exact source %q: %v", name, err)
		}
		if name == "nested/雪 %.txt" && (result.File.Content == nil || *result.File.Content != "unchanged bytes\t\n") {
			t.Fatal("literal bytes changed")
		}
	}
	if sourceBlobHash(nil, 40) != "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" || sourceTreeHash(nil, 40) != "4b825dc642cb6eb9a060e54bf8d69288fbee4904" {
		t.Fatal("independent Git empty object constants differ")
	}
}
func TestSourceObjectFalseNativeReceipts(t *testing.T) {
	for _, mode := range []string{"wrong-commit", "wrong-tree", "duplicate-entry", "invalid-mode", "truncated-lie", "empty-progress", "wrong-subtree-entries", "wrong-blob", "wrong-bytes", "missing-encoding"} {
		t.Run(mode, func(t *testing.T) {
			const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			f := newSourceObjectFixture(sha, map[string]string{"a": "a", "b": "b", "nested/x": "x"}, nil)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/git/commits/") && mode == "wrong-commit" {
					json.NewEncoder(w).Encode(map[string]string{"sha": strings.Repeat("b", 40)})
					return
				}
				if strings.Contains(r.URL.Path, "/git/trees/") {
					id := path.Base(r.URL.Path)
					rows := f.root
					if id != sha {
						rows = f.trees[id]
					}
					page, _ := strconv.Atoi(r.URL.Query().Get("page"))
					size := min(2, len(rows))
					start := min((page-1)*size, len(rows))
					end := min(start+size, len(rows))
					reply := sourceTree{SHA: id, Entries: append([]sourceTreeEntry(nil), rows[start:end]...), Page: page, Total: len(rows), Truncated: end < len(rows)}
					switch mode {
					case "wrong-tree":
						reply.SHA = strings.Repeat("b", 40)
					case "duplicate-entry":
						reply.Entries = []sourceTreeEntry{rows[0], rows[0]}
					case "invalid-mode":
						reply.Entries[0].Mode = "100777"
					case "truncated-lie":
						reply.Truncated = !reply.Truncated
					case "empty-progress":
						reply.Entries = nil
					case "wrong-subtree-entries":
						if id != sha {
							reply.Entries[0].Path = "other"
						}
					}
					json.NewEncoder(w).Encode(reply)
					return
				}
				if strings.Contains(r.URL.Path, "/git/blobs/") {
					id := path.Base(r.URL.Path)
					data := f.blobs[id]
					encoding := "base64"
					switch mode {
					case "wrong-blob":
						id = strings.Repeat("b", 40)
					case "wrong-bytes":
						data = []byte("z")
					case "missing-encoding":
						encoding = ""
					}
					json.NewEncoder(w).Encode(map[string]any{"sha": id, "size": len(data), "encoding": encoding, "content": base64.StdEncoding.EncodeToString(data)})
					return
				}
				f.serve(w, r, "/api/v1/repos/a/r")
			}))
			defer provider.Close()
			s, _ := New(testConfig(provider.URL), nil)
			_, err := s.readContentsAtCommit(t.Context(), "/repos/a/r", forgeCredential{Kind: "pat", Token: "fixture"}, sha, "nested/x")
			if err == nil {
				t.Fatal("false receipt exposed source")
			}
		})
	}
}
func TestSourceSelectionTypedPostgres(t *testing.T) {
	for _, mode := range []string{"ok", "branch-moves", "tag-moves", "wrong-id", "access-removed", "wrong-identity", "repository-rebound"} {
		t.Run(mode, func(t *testing.T) {
			f := &pullFixture{db: testDatabase(t)}
			f.mode.Store(mode)
			sha := strings.Repeat("a", 40)
			other := strings.Repeat("b", 40)
			objects := newSourceObjectFixture(sha, map[string]string{"README.md": "saved source"}, nil)
			branches, tags := 0, 0
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				base := "/api/v1/repos/alice/private"
				if objects.serve(w, r, base) {
					return
				}
				if strings.HasPrefix(r.URL.Path, base+"/git/refs/heads/") {
					branches++
					name := strings.TrimPrefix(r.URL.Path, base+"/git/refs/heads/")
					id := sha
					if mode == "branch-moves" && branches > 1 {
						id = other
					}
					json.NewEncoder(w).Encode([]map[string]any{{"ref": "refs/heads/" + name, "object": map[string]string{"type": "commit", "sha": id}}, {"ref": "refs/heads/" + name + "-neighbor", "object": map[string]string{"type": "commit", "sha": other}}})
					return
				}
				if strings.HasPrefix(r.URL.Path, base+"/tags/") {
					tags++
					name := strings.TrimPrefix(r.URL.Path, base+"/tags/")
					id := other
					if mode == "tag-moves" && tags > 1 {
						id = sha
					}
					json.NewEncoder(w).Encode(map[string]any{"name": name, "id": id, "commit": map[string]string{"sha": sha}})
					return
				}
				f.serveProvider(w, r)
			}))
			defer provider.Close()
			config := testConfig(provider.URL)
			config.ForgePublicURL = provider.URL
			config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = "fixture-client", "fixture-secret"
			var err error
			f.s, err = New(config, f.db)
			if err != nil {
				t.Fatal(err)
			}
			session := f.session(t, "pat")
			c := f.client(t, session)
			id := "11"
			if mode == "wrong-id" {
				id = "12"
			}
			kind := golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH
			if mode == "tag-moves" {
				kind = golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_TAG
			}
			response, err := c.ResolveRepositorySource(context.Background(), connect.NewRequest(&golfv1.ResolveRepositorySourceRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: id, Selector: &golfv1.RepositorySourceSelector{Kind: kind, Name: "release/雪"}, Path: "literal %.txt"}))
			if mode == "ok" {
				if err != nil || response.Msg.RepositoryId != "11" || response.Msg.Selection.CommitId != sha || response.Msg.Path != "literal %.txt" {
					t.Fatalf("typed selection: %v", err)
				}
				for _, kind := range []golfv1.RepositorySourceRefKind{golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_TAG, golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_COMMIT} {
					name := "release/雪"
					if kind == golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_COMMIT {
						name = sha
					}
					result, e := c.ResolveRepositorySource(t.Context(), connect.NewRequest(&golfv1.ResolveRepositorySourceRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: id, Selector: &golfv1.RepositorySourceSelector{Kind: kind, Name: name}}))
					if e != nil || result.Msg.Selection.CommitId != sha {
						t.Fatal("typed namespace selection failed", e)
					}
				}
			} else if err == nil {
				t.Fatal("changed authority/ref returned selection")
			}
		})
	}
}

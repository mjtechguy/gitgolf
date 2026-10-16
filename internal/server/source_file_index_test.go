package server

import (
	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestSourceFileIndexExactObjectsAndBounds(t *testing.T) {
	const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	for _, oversized := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete", true: "bounded"}[oversized], func(t *testing.T) {
			files := map[string]string{"root.txt": "hello", "a/same.txt": "shared", "b/same.txt": "shared", "link": "outside", "module": "ignored"}
			if oversized {
				for i := 0; i < 513; i++ {
					files[strings.Repeat("x", i%20)+string(rune(0x400+i))+"/file"] = "same"
				}
			}
			fixture := newSourceObjectFixture(commit, files, map[string]string{"link": "symlink", "module": "submodule"})
			blobs := 0
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/blobs/") {
					blobs++
				}
				if !fixture.serve(w, r, "/api/v1/repos/a/r") {
					t.Errorf("Unexpected read %s", r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			defer provider.Close()
			server, _ := New(testConfig(provider.URL), nil)
			paths, err := server.sourceFileIndex(t.Context(), "/repos/a/r", forgeCredential{Kind: "pat", Token: "fixture"}, commit)
			if oversized {
				if err == nil || paths != nil {
					t.Fatal("oversized index returned a partial inventory")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(paths, []string{"a/same.txt", "b/same.txt", "link", "root.txt"}) {
				t.Fatalf("wrong paths: %v", paths)
			}
			if blobs != 0 {
				t.Fatal("file finder downloaded file contents")
			}
			if _, err = server.sourceFileIndex(t.Context(), "/repos/a/r", forgeCredential{Kind: "pat", Token: "fixture"}, "main"); err == nil {
				t.Fatal("mutable branch accepted")
			}
		})
	}
}

func TestSourceFileIndexAuthorityPostgres(t *testing.T) {
	for _, mode := range []string{"ok", "wrong-id", "wrong-identity", "access-removed", "repository-rebound"} {
		t.Run(mode, func(t *testing.T) {
			f := &pullFixture{db: testDatabase(t)}
			f.mode.Store(mode)
			commit := strings.Repeat("a", 40)
			objects := newSourceObjectFixture(commit, map[string]string{"src/private.txt": "private"}, nil)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !objects.serve(w, r, "/api/v1/repos/alice/private") {
					f.serveProvider(w, r)
				}
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
			client := f.client(t, f.session(t, "pat"))
			id := "11"
			if mode == "wrong-id" {
				id = "12"
			}
			response, err := client.GetRepositoryFileIndex(t.Context(), connect.NewRequest(&golfv1.GetRepositoryFileIndexRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: id, CommitId: commit}))
			if mode != "ok" {
				if err == nil || response != nil {
					t.Fatal("inventory survived lost or mismatched authority")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if response.Msg.RepositoryId != id || response.Msg.CommitId != commit || !reflect.DeepEqual(response.Msg.Paths, []string{"src/private.txt"}) {
				t.Fatal("incorrect snapshot inventory")
			}
		})
	}
}

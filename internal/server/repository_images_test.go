package server

import (
	"connectrpc.com/connect"
	"context"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRepositoryImageBoundaries(t *testing.T) {
	for _, reference := range []string{"https://localhost/x", "https://127.0.0.1/x", "https://raw.githubusercontent.com:443/x", "https://user:pass@raw.githubusercontent.com/x", "https://raw.githubusercontent.com.evil.test/x", "http://raw.githubusercontent.com/x", "data:image/svg+xml,x"} {
		if _, e := externalImageURL(reference); e == nil {
			t.Errorf("accepted %q", reference)
		}
	}
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "192.168.1.2", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "0.0.0.1", "198.18.0.1", "2001:db8::1"} {
		if publicImageIP(net.ParseIP(ip)) {
			t.Errorf("accepted private %s", ip)
		}
	}
	for _, reference := range []string{"../../x", "https://evil.test/x", "//evil.test/x", "../%2e%2e/x", "a\\b"} {
		if _, e := repositoryImagePath("docs/README.md", reference); e == nil {
			t.Errorf("accepted path %q", reference)
		}
	}
	if got, e := repositoryImagePath("docs/README.md", "../images/logo.svg"); e != nil || got != "images/logo.svg" {
		t.Fatalf("relative image: %q %v", got, e)
	}
	if _, e := repositoryImageType([]byte("<html><script>alert(1)</script></html>")); e == nil {
		t.Fatal("accepted HTML image")
	}
	if _, e := repositoryImageType([]byte(strings.Repeat("x", maxPreviewBytes+1))); e == nil {
		t.Fatal("accepted oversized image")
	}
	if got, e := repositoryImageType([]byte(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>`)); e != nil || got != "image/svg+xml" {
		t.Fatalf("SVG: %s %v", got, e)
	}
}

func TestRepositoryImagePrivateRPCPostgres(t *testing.T) {
	for _, mode := range []string{"ok", "repository-denied", "access-removed", "repository-rebound", "wrong-identity", "unreferenced", "symlink", "oversized", "mismatched-size"} {
		t.Run(mode, func(t *testing.T) {
			f := &pullFixture{db: testDatabase(t)}
			f.mode.Store(mode)
			sha := strings.Repeat("a", 40)
			document := "![Logo](logo.svg)"
			svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0h20v20z"/></svg>`
			if mode == "unreferenced" {
				document = "No image here."
			}
			objects := newSourceObjectFixture(sha, map[string]string{"README.md": document, "logo.svg": svg}, nil)
			for i := range objects.root {
				if objects.root[i].Path == "logo.svg" {
					switch mode {
					case "symlink":
						objects.root[i].Mode = "120000"
					case "oversized":
						objects.root[i].Size = maxPreviewBytes + 1
					case "mismatched-size":
						objects.root[i].Size++
					}
				}
			}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if objects.serve(w, r, "/api/v1/repos/alice/private") {
					return
				}
				f.serveProvider(w, r)
			}))
			t.Cleanup(provider.Close)
			config := testConfig(provider.URL)
			config.GiteaPublicURL, config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
			var err error
			f.s, err = New(config, f.db)
			if err != nil {
				t.Fatal(err)
			}
			session := f.session(t, "pat")
			response, err := f.client(t, session).GetRepositoryImage(context.Background(), connect.NewRequest(&golfv1.GetRepositoryImageRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, CommitId: sha, DocumentPath: "README.md", ImageUrl: "logo.svg"}))
			if mode == "ok" {
				if err != nil || response.Msg.MediaType != "image/svg+xml" || string(response.Msg.Content) != svg {
					t.Fatalf("image response: %v", err)
				}
			} else if err == nil {
				t.Fatal("unsafe or inaccessible image returned")
			}
		})
	}
}

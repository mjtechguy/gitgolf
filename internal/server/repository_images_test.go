package server

import (
	"connectrpc.com/connect"
	"context"
	"encoding/base64"
	"encoding/json"
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
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/repos/alice/private/commits" {
					json.NewEncoder(w).Encode([]map[string]string{{"sha": sha}})
					return
				}
				if strings.HasPrefix(r.URL.Path, "/api/v1/repos/alice/private/contents-ext/") {
					requested := strings.TrimPrefix(r.URL.Path, "/api/v1/repos/alice/private/contents-ext/")
					text := document
					if requested == "logo.svg" {
						text = svg
					}
					kind := "file"
					size := len(text)
					if requested == "logo.svg" {
						if mode == "symlink" {
							kind = "symlink"
						}
						if mode == "oversized" {
							size = maxPreviewBytes + 1
						}
						if mode == "mismatched-size" {
							size++
						}
					}
					json.NewEncoder(w).Encode(contentsEnvelope{File: &forgeContents{sourceEntry: sourceEntry{Name: requested, Path: requested, Type: kind, SHA: sha, Size: int64(size)}, Encoding: "base64", Content: base64.StdEncoding.EncodeToString([]byte(text))}})
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

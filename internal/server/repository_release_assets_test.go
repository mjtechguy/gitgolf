package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func releaseDownloadFixture() forgeReleaseDownloadAsset {
	size, count := int64(3), int64(0)
	return forgeReleaseDownloadAsset{forgeReleaseAsset: forgeReleaseAsset{ID: 9, Name: "literal%.bin", Size: &size, DownloadCount: &count, CreatedAt: "2026-10-04T10:00:00Z"}, UUID: "b1c8ac31-ec99-430a-8ba8-7e5a817e2e5c"}
}

func TestRepositoryReleaseAssetMetadata(t *testing.T) {
	row := releaseDownloadFixture()
	if !validReleaseDownloadAsset(row, 9) {
		t.Fatal("valid asset")
	}
	for _, mutate := range []func(*forgeReleaseDownloadAsset){
		func(r *forgeReleaseDownloadAsset) { r.ID++ }, func(r *forgeReleaseDownloadAsset) { r.UUID = "../private" }, func(r *forgeReleaseDownloadAsset) { r.Name = "bad\rname" }, func(r *forgeReleaseDownloadAsset) { r.Size = nil }, func(r *forgeReleaseDownloadAsset) { v := int64(-1); r.Size = &v }, func(r *forgeReleaseDownloadAsset) { r.CreatedAt = "invalid" },
	} {
		altered := releaseDownloadFixture()
		mutate(&altered)
		if validReleaseDownloadAsset(altered, 9) {
			t.Fatal("malformed accepted")
		}
	}
	changed := releaseDownloadFixture()
	count := int64(1)
	changed.DownloadCount = &count
	if !sameReleaseDownloadAsset(row, changed) {
		t.Fatal("native count changes identity")
	}
	for _, mutate := range []func(*forgeReleaseDownloadAsset){func(r *forgeReleaseDownloadAsset) { r.UUID = "b1c8ac31-ec99-430a-8ba8-7e5a817e2e5d" }, func(r *forgeReleaseDownloadAsset) { r.Name = "other" }, func(r *forgeReleaseDownloadAsset) { v := int64(4); r.Size = &v }, func(r *forgeReleaseDownloadAsset) { r.CreatedAt = "2026-10-04T10:00:01Z" }} {
		changed = releaseDownloadFixture()
		mutate(&changed)
		if sameReleaseDownloadAsset(row, changed) {
			t.Fatal("identity drift accepted")
		}
	}
}

func TestRepositoryReleaseAssetBytes(t *testing.T) {
	mode := ""
	calls := 0
	redirected := 0
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected++; w.Write([]byte("secret")) }))
	defer sink.Close()
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "GET" || r.URL.Path != "/alice/private/releases/attachments/"+releaseDownloadFixture().UUID || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "Bearer fixture" || r.Header.Get("Cookie") != "" {
			t.Error("native route/auth violated")
		}
		switch mode {
		case "redirect":
			http.Redirect(w, r, sink.URL, 302)
		case "empty":
			return
		case "limit":
			w.Write(bytes.Repeat([]byte("x"), repositoryReleaseAssetMaxBytes))
		case "forbidden":
			w.WriteHeader(403)
		case "wrongsize":
			w.Write([]byte("ab"))
		case "oversize":
			io.Copy(w, io.LimitReader(strings.NewReader(strings.Repeat("x", repositoryReleaseAssetMaxBytes+1)), repositoryReleaseAssetMaxBytes+1))
		default:
			w.Write([]byte("abc"))
		}
	}))
	defer native.Close()
	s, err := New(testConfig(native.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"pat", "oauth"} {
		data, err := s.releaseAssetBytes(t.Context(), forgeCredential{Kind: kind, Token: "fixture"}, repositoryKey{"alice", "private"}, releaseDownloadFixture())
		if err != nil || string(data) != "abc" {
			t.Fatal("bearer supported", err)
		}
	}
	for _, v := range []string{"redirect", "forbidden", "wrongsize", "oversize"} {
		mode = v
		data, err := s.releaseAssetBytes(t.Context(), forgeCredential{Kind: "pat", Token: "fixture"}, repositoryKey{"alice", "private"}, releaseDownloadFixture())
		if err == nil || data != nil {
			t.Fatal("unsafe bytes released", v)
		}
	}
	if redirected != 0 {
		t.Fatal("redirect followed")
	}
	before := calls
	row := releaseDownloadFixture()
	size := int64(repositoryReleaseAssetMaxBytes + 1)
	row.Size = &size
	if _, err := s.releaseAssetBytes(t.Context(), forgeCredential{Kind: "pat", Token: "fixture"}, repositoryKey{"alice", "private"}, row); err == nil || calls != before {
		t.Fatal("oversize reached transport")
	}
	for _, accepted := range []struct {
		mode string
		size int64
	}{{"empty", 0}, {"limit", repositoryReleaseAssetMaxBytes}} {
		mode = accepted.mode
		row.Size = &accepted.size
		data, err := s.releaseAssetBytes(t.Context(), forgeCredential{Kind: "pat", Token: "fixture"}, repositoryKey{"alice", "private"}, row)
		if err != nil || int64(len(data)) != accepted.size {
			t.Fatal("exact supported byte boundary", err)
		}
	}
	mode = "wrongsize"
	size = 0
	row.Size = &size
	if _, err := s.releaseAssetBytes(t.Context(), forgeCredential{Kind: "pat", Token: "fixture"}, repositoryKey{"alice", "private"}, row); err == nil {
		t.Fatal("zero metadata adopted nonempty body")
	}
}

func TestRepositoryReleaseAssetOuterBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	route := "/api/repositories/alice/private/11/releases/8/assets/9/download"
	for _, tc := range []struct {
		suffix, header, value string
		status                int
	}{{"", "", "", 401}, {"?token=private", "", "", 403}, {"", "Authorization", "Bearer private", 403}, {"", "Origin", "https://other.invalid", 403}, {"", "Sec-Fetch-Site", "cross-site", 403}} {
		req := httptest.NewRequest("GET", route+tc.suffix, nil)
		if tc.header != "" {
			req.Header.Set(tc.header, tc.value)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "sandbox") || strings.Contains(w.Body.String(), "private") {
			t.Fatal("outer boundary", w.Code)
		}
	}
	for _, id := range []string{"0", "01", "9223372036854775808"} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("GET", strings.Replace(route, "/11/", "/"+id+"/", 1), nil))
		if w.Code != 400 {
			t.Fatal("invalid target", w.Code)
		}
	}
}

// Authored PG test. Supported HTTP fixture only; actual native/storage proof is separate.
func TestRepositoryReleaseAssetAuthorityPostgres(t *testing.T) {
	db := testDatabase(t)
	mode := ""
	downloaded := false
	webReads := 0
	assetReads := 0
	var onDownload func()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Error("download wrote native API")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/user":
			id := int64(42)
			if downloaded && mode == "actor" {
				id++
			}
			json.NewEncoder(w).Encode(User{ID: id, Login: "alice"})
		case "/api/v1/repos/alice/private":
			if downloaded && mode == "denied" {
				w.WriteHeader(404)
				return
			}
			id := int64(11)
			owner := int64(42)
			if downloaded && mode == "replacement" {
				id++
			}
			if downloaded && mode == "owner" {
				owner++
			}
			json.NewEncoder(w).Encode(forgeStarRepository{Repository: Repository{ID: id, Name: "private", FullName: "alice/private", HTMLURL: "https://forge.invalid/alice/private"}, Owner: &User{ID: owner, Login: "alice"}})
		case "/api/v1/repos/alice/private/releases/8/assets/9":
			assetReads++
			if mode == "association" {
				w.WriteHeader(404)
				return
			}
			row := releaseDownloadFixture()
			if downloaded {
				count := int64(1)
				row.DownloadCount = &count
				if mode == "uuid" {
					row.UUID = "b1c8ac31-ec99-430a-8ba8-7e5a817e2e5d"
				}
				if mode == "name" {
					row.Name = "other.bin"
				}
				if mode == "size" {
					size := int64(4)
					row.Size = &size
				}
				if mode == "draft-denied" {
					w.WriteHeader(404)
					return
				}
			}
			if mode == "oversize" {
				size := int64(repositoryReleaseAssetMaxBytes + 1)
				row.Size = &size
			}
			if mode == "empty" {
				size := int64(0)
				row.Size = &size
			}
			json.NewEncoder(w).Encode(row)
		case "/alice/private/releases/attachments/" + releaseDownloadFixture().UUID:
			webReads++
			if r.Header.Get("Authorization") != "Bearer fixture" || r.Header.Get("Cookie") != "" {
				t.Error("web bearer boundary")
			}
			downloaded = true
			if onDownload != nil {
				onDownload()
			}
			if mode == "redirect" {
				http.Redirect(w, r, "https://private.invalid/body", 302)
				return
			}
			if mode == "empty" {
				return
			}
			w.Write([]byte("abc"))
		default:
			t.Error("unexpected native path")
			w.WriteHeader(500)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{"", "empty", "association", "oversize", "denied", "replacement", "owner", "actor", "uuid", "name", "size", "draft-denied", "logout", "redirect"} {
		t.Run(m, func(t *testing.T) {
			mode = m
			downloaded = false
			onDownload = nil
			webReads = 0
			assetReads = 0
			session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "fixture", "")
			if err != nil {
				t.Fatal(err)
			}
			cookie := s.sessionCookie(session.Value, session.Expires, 3600).String()
			if mode == "logout" {
				onDownload = func() {
					req := connect.NewRequest(&golfv1.LogoutRequest{})
					req.Header().Set("Cookie", cookie)
					ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "fixture"})
					if _, err := s.Logout(ctx, req); err != nil {
						t.Fatal(err)
					}
				}
			}
			if mode == "" {
				denied := httptest.NewRequest("GET", "/api/repositories/alice/private/12/releases/8/assets/9/download", nil)
				denied.Header.Set("Cookie", cookie)
				response := httptest.NewRecorder()
				s.ServeHTTP(response, denied)
				if response.Code != 404 || assetReads != 0 || webReads != 0 {
					t.Fatal("wrong original repository reached asset", response.Code)
				}
			}
			req := httptest.NewRequest("GET", "/api/repositories/alice/private/11/releases/8/assets/9/download", nil)
			req.Header.Set("Cookie", cookie)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			if mode == "" || mode == "empty" {
				expected := []byte("abc")
				if mode == "empty" {
					expected = nil
				}
				if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), expected) || w.Header().Get("Content-Type") != "application/octet-stream" || w.Header().Get("Content-Disposition") != "attachment; filename=literal%.bin" || w.Header().Get("Content-Length") != strconv.Itoa(len(expected)) || assetReads != 2 || webReads != 1 {
					t.Fatal("verified delivery", w.Code, w.Header())
				}
			} else {
				if w.Code == 200 || bytes.Contains(w.Body.Bytes(), []byte("abc")) {
					t.Fatal("private bytes escaped", mode, w.Code)
				}
				if (mode == "association" || mode == "oversize") && webReads != 0 {
					t.Fatal("unadmitted asset fetched")
				}
			}
		})
	}
}

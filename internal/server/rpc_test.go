package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestRPCErrorMapping(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code connect.Code
	}{
		{invalid("Invalid name."), connect.CodeInvalidArgument}, {errUnauthenticated, connect.CodeUnauthenticated},
		{errResourceNotFound, connect.CodeNotFound}, {errEmptyRepository, connect.CodeFailedPrecondition},
		{errForgeResponseTooLarge, connect.CodeResourceExhausted}, {errStorageUnavailable, connect.CodeUnavailable},
		{errCredentialUnavailable, connect.CodeUnavailable}, {errInvalidForgeResponse, connect.CodeUnavailable},
		{forgeError{401}, connect.CodeUnauthenticated}, {forgeError{403}, connect.CodePermissionDenied}, {forgeError{404}, connect.CodeNotFound},
		{forgeError{409}, connect.CodeAlreadyExists}, {forgeError{422}, connect.CodeAlreadyExists}, {forgeError{429}, connect.CodeResourceExhausted},
		{forgeError{500}, connect.CodeUnavailable}, {context.Canceled, connect.CodeCanceled}, {context.DeadlineExceeded, connect.CodeDeadlineExceeded},
		{errors.New("secret-token-and-SQL-dsn"), connect.CodeInternal},
		{fmt.Errorf("secret-token-and-SQL-dsn: %w", errWebhookDestination), connect.CodeInvalidArgument},
		{fmt.Errorf("secret-token-and-SQL-dsn: %w", errWebhookNetwork), connect.CodeUnavailable},
		{fmt.Errorf("secret-token-and-SQL-dsn: %w", errLifecycleBlocked), connect.CodeFailedPrecondition},
	} {
		err := rpcError(tc.err)
		if connect.CodeOf(err) != tc.code || strings.Contains(err.Error(), "secret-token-and-SQL-dsn") {
			t.Fatalf("mapping %T: %v", tc.err, err)
		}
	}
}

func TestRPCWireAndSPABoundary(t *testing.T) {
	config := testConfig("http://gitea.invalid")
	config.WebDir = t.TempDir()
	if err := os.WriteFile(filepath.Join(config.WebDir, "index.html"), []byte("PRIVATE-SPA-SENTINEL"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := New(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path, origin string
		status               int
	}{
		{"GET", "/api/session", "", 404}, {"POST", "/api/session", config.PublicURL, 404},
		{"GET", "/rpc" + golfv1connect.SessionServiceGetSessionProcedure, config.PublicURL, 400},
		{"POST", "/rpc/unknown", config.PublicURL, 404},
		{"POST", "/rpc" + golfv1connect.SessionServiceLogoutProcedure, "", 403},
		{"POST", "/rpc" + golfv1connect.CapabilityServiceListCapabilitiesProcedure, "https://attacker.example", 403},
		{"POST", "/rpc" + golfv1connect.SessionServiceLogoutProcedure + "?unexpected=1", config.PublicURL, 400},
	} {
		request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`))
		request.Header.Set("Origin", tc.origin)
		request.Header.Set("Accept", "text/html")
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Connect-Protocol-Version", "1")
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		if response.Code != tc.status || strings.Contains(response.Body.String(), "PRIVATE-SPA-SENTINEL") {
			t.Errorf("%s %s: %d %s", tc.method, tc.path, response.Code, response.Body.String())
		}
	}
	// Authenticated/public RPC decoding is bounded after decompression as well.
	var zipped bytes.Buffer
	compressor := gzip.NewWriter(&zipped)
	fmt.Fprintf(compressor, `{"token":%q}`, strings.Repeat("x", 32<<10))
	compressor.Close()
	request := httptest.NewRequest("POST", "/rpc"+golfv1connect.SessionServiceLoginWithGiteaTokenProcedure, &zipped)
	request.Header.Set("Origin", config.PublicURL)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Content-Encoding", "gzip")
	request.Header.Set("Connect-Protocol-Version", "1")
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != 429 || !strings.Contains(response.Body.String(), `"code":"resource_exhausted"`) {
		t.Fatalf("unbounded decompression: %d %s", response.Code, response.Body.String())
	}
}

func TestCapabilityReadinessWithPostgres(t *testing.T) {
	db := testDatabase(t)
	var mode atomic.Int32
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/version" {
			t.Error("unexpected health request")
			w.WriteHeader(404)
			return
		}
		if r.Header.Get("Authorization") != "" {
			t.Error("health leaked user credential")
		}
		switch mode.Load() {
		case 0:
			fmt.Fprint(w, `{"version":"1.27.3"}`)
		case 1:
			fmt.Fprint(w, `{"version":"1.26.0"}`)
		default:
			w.WriteHeader(500)
		}
	}))
	defer forge.Close()
	s, err := New(testConfig(forge.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	_, _, capabilities, _, _ := testRPCClients(t, s)
	for _, test := range []struct {
		mode  int32
		state golfv1.CapabilityState
	}{{0, golfv1.CapabilityState_CAPABILITY_STATE_READY}, {1, golfv1.CapabilityState_CAPABILITY_STATE_DEGRADED}, {2, golfv1.CapabilityState_CAPABILITY_STATE_DEGRADED}} {
		mode.Store(test.mode)
		response, err := capabilities.ListCapabilities(context.Background(), connect.NewRequest(&golfv1.ListCapabilitiesRequest{}))
		if err != nil {
			t.Fatal(err)
		}
		if response.Msg.Capabilities[0].State != test.state || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("untruthful readiness/cache state")
		}
		for _, capability := range response.Msg.Capabilities[1:] {
			if capability.State != golfv1.CapabilityState_CAPABILITY_STATE_DISABLED {
				t.Fatal("unimplemented feature reported available")
			}
		}
	}
	mode.Store(0)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	response, err := capabilities.ListCapabilities(context.Background(), connect.NewRequest(&golfv1.ListCapabilitiesRequest{}))
	if err != nil || response.Msg.Capabilities[0].State != golfv1.CapabilityState_CAPABILITY_STATE_DEGRADED {
		t.Fatal("unavailable DB reported ready", err)
	}
}

func TestWebCacheSeparatesHashedAssetsFromDocumentsAndRPC(t *testing.T) {
	config := testConfig("http://gitea.invalid")
	config.WebDir = t.TempDir()
	if err := os.Mkdir(filepath.Join(config.WebDir, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"index.html", "assets/app-A1b2c3d4.js", "assets/fonts-A1b2c3d4.woff2", "assets/app.js"} {
		if err := os.WriteFile(filepath.Join(config.WebDir, name), []byte("STATIC-BUILD"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	s, err := New(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path, cache string
		status      int
	}{
		{"/assets/app-A1b2c3d4.js", "public, max-age=31536000, immutable", 200},
		{"/assets/fonts-A1b2c3d4.woff2", "public, max-age=31536000, immutable", 200},
		{"/assets/app.js", "no-cache", 200}, {"/index.html", "no-cache", 301},
		{"/owner/private/tree/commit", "no-cache", 200}, {"/assets/missing-A1b2c3d4.js", "no-cache", 200},
		{"/rpc/unknown", "no-store", 400}, {"/api/private", "no-store", 404},
	} {
		request := httptest.NewRequest(http.MethodGet, tc.path, nil)
		request.Header.Set("Accept", "text/html")
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		if response.Code != tc.status || response.Header().Get("Cache-Control") != tc.cache {
			t.Errorf("%s: status=%d cache=%q", tc.path, response.Code, response.Header().Get("Cache-Control"))
		}
	}
}

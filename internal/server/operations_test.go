package server

import (
	"connectrpc.com/connect"
	"context"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/telemetry"
	"github.com/rs/zerolog"
	"google.golang.org/protobuf/encoding/protojson"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOperationsRejectsAnonymousAndNativeCredentials(t *testing.T) {
	s := &Server{}
	for _, local := range []bool{false, true} {
		ctx := context.Background()
		if local {
			ctx = context.WithValue(ctx, sessionTokenKey{}, forgeCredential{Token: "native-token"})
		}
		response, err := s.GetOperationsDashboard(ctx, connect.NewRequest(&golfv1.GetOperationsDashboardRequest{}))
		if response != nil || err == nil {
			t.Fatal("private metrics returned without current administrator")
		}
		expected := connect.CodeUnauthenticated
		if local {
			expected = connect.CodePermissionDenied
		}
		if connect.CodeOf(err) != expected {
			t.Fatal(err)
		}
	}
}

func operationsRequest(s *Server, session loginResult) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/rpc"+golfv1connect.OperationsServiceGetOperationsDashboardProcedure, strings.NewReader("{}"))
	req.Header.Set("Origin", s.config.PublicURL)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	if session.Value != "" {
		req.AddCookie(s.sessionCookie(session.Value, session.Expires, 3600))
	}
	response := httptest.NewRecorder()
	s.ServeHTTP(response, req)
	return response
}

func TestOperationsDashboardPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	ordinary := localLogin(t, f, "bob")
	runtime, err := telemetry.New(t.Context(), telemetry.Config{Logger: zerolog.Nop(), ServiceVersion: "operations-test"})
	if err != nil {
		t.Fatal(err)
	}
	f.s.config.Telemetry = runtime
	for _, session := range []loginResult{ordinary, f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")} {
		response := operationsRequest(f.s, session)
		if response.Code != 403 || strings.Contains(response.Body.String(), "metrics") {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	response := operationsRequest(f.s, admin)
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(response.Code, response.Body.String())
	}
	var data golfv1.GetOperationsDashboardResponse
	if err := protojson.Unmarshal(response.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if data.Scope != "instance" || data.Release != "operations-test" || len(data.Services) < 4 || len(data.Metrics) < 10 {
		t.Fatal(&data)
	}
	for _, service := range data.Services {
		if service.Id == "forgejo" && service.State != "available" {
			t.Fatal(service)
		}
	}
	if strings.Contains(response.Body.String(), "alice") || strings.Contains(response.Body.String(), "management-token") {
		t.Fatal("private label exposed")
	}
}

func TestOperationsWithholdsRevokedAdminAfterWaitPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	admin := localLogin(t, f, "alice")
	entered, resume := make(chan struct{}), make(chan struct{})
	f.s.client.Transport = creationRoundTripper(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/api/v1/version" {
			close(entered)
			select {
			case <-resume:
			case <-req.Context().Done():
				return nil, req.Context().Err()
			}
		}
		return http.DefaultTransport.RoundTrip(req)
	})
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- operationsRequest(f.s, admin) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		close(resume)
		t.Fatal("dependency wait not reached")
	}
	f.mode.Store(2)
	close(resume)
	response := <-result
	if response.Code != 401 || strings.Contains(response.Body.String(), "metrics") {
		t.Fatal("revoked admin received snapshot", response.Code, response.Body.String())
	}
}

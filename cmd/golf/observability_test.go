package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func TestObservabilityConfigAndPrivateMetrics(t *testing.T) {
	for _, name := range []string{"GOLF_METRICS_ADDR", "GOLF_METRICS_TOKEN", "GOLF_OTLP_HTTP_ENDPOINT", "GOLF_OTLP_INSECURE", "GOLF_TRACE_SAMPLE_RATIO"} {
		t.Setenv(name, "")
	}
	logger := zerolog.New(io.Discard)
	config, address, _, err := observabilityConfig(logger)
	if err != nil || address != "" || config.SampleRatio != 0.1 {
		t.Fatal("invalid disabled defaults")
	}
	for _, value := range []string{"NaN", "+Inf", "-1", "1.1", "private-canary"} {
		t.Setenv("GOLF_TRACE_SAMPLE_RATIO", value)
		if _, _, _, err := observabilityConfig(logger); err == nil || strings.Contains(err.Error(), value) {
			t.Fatal("invalid ratio must fail without echo")
		}
	}
	t.Setenv("GOLF_TRACE_SAMPLE_RATIO", "1")
	t.Setenv("GOLF_METRICS_ADDR", ":9090")
	if _, _, _, err := observabilityConfig(logger); err == nil {
		t.Fatal("metrics missing secret accepted")
	}
	token := strings.Repeat("x", 32)
	t.Setenv("GOLF_METRICS_TOKEN", token)
	if _, _, _, err := observabilityConfig(logger); err != nil {
		t.Fatal(err)
	}
	calls := 0
	handler := privateMetrics(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++; w.Write([]byte("safe metrics")) }), token)
	for _, tc := range []struct {
		method, path, auth string
		status             int
	}{
		{"GET", "/metrics", "", 401}, {"GET", "/metrics?token=" + token, "", 401}, {"GET", "/metrics", "Bearer wrong", 401},
		{"POST", "/metrics", "Bearer " + token, 405}, {"GET", "/", "Bearer " + token, 404}, {"GET", "/metrics", "Bearer " + token, 200},
	} {
		request := httptest.NewRequest(tc.method, tc.path, nil)
		request.Header.Set("Authorization", tc.auth)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != tc.status || strings.Contains(response.Body.String(), token) || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("metrics boundary failed")
		}
	}
	request := httptest.NewRequest("GET", "/metrics", nil)
	request.Header.Add("Authorization", "Bearer "+token)
	request.Header.Add("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 401 || calls != 1 {
		t.Fatal("duplicate credentials accepted")
	}
	var output bytes.Buffer
	writer := safeHTTPLog{zerolog.New(&output)}
	writer.Write([]byte("panic and private-canary"))
	if strings.Contains(output.String(), "private-canary") || !strings.Contains(output.String(), "HTTP transport error") {
		t.Fatal("raw diagnostic leaked")
	}
}

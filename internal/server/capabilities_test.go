package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestCapabilityProviderSeparation(t *testing.T) {
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		respond(w, http.StatusOK, map[string]string{"version": "1.27.3"})
	}))
	defer forge.Close()
	config := testConfig(forge.URL)
	config.RepositoryEventConnectionsJSON = `[{"id":"54b7908f-dd76-4503-b33a-22c39b07625d","repositoryId":"42","ownerId":"7","repository":"alex/private-project","secret":"` + strings.Repeat("s", 32) + `"}]`
	s, err := New(config, nil)
	if err != nil {
		t.Fatal("configuration prevalidation failed")
	}
	response, err := s.ListCapabilities(context.Background(), connect.NewRequest(&golfv1.ListCapabilitiesRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	agents, providers, eventSeen := 0, 0, false
	for _, capability := range response.Msg.Capabilities {
		if strings.Contains(capability.Reason, "private-project") || strings.Contains(capability.Reason, strings.Repeat("s", 32)) {
			t.Fatal("capability metadata exposed connection details")
		}
		if capability.Id == "events.native" {
			eventSeen = capability.State == golfv1.CapabilityState_CAPABILITY_STATE_DEGRADED
		}
		if strings.HasPrefix(capability.Id, "agents.") || strings.HasPrefix(capability.Id, "cloudflare.") || capability.Id == "pipelines.automatic" || capability.Id == "webhooks.outbound" {
			if capability.State != golfv1.CapabilityState_CAPABILITY_STATE_DISABLED {
				t.Fatal("configured intake implied another qualified capability")
			}
		}
		if strings.HasPrefix(capability.Id, "agents.") {
			agents++
		}
		if strings.HasPrefix(capability.Id, "cloudflare.") {
			providers++
		}
	}
	if !eventSeen || agents != 5 || providers == 0 {
		t.Fatal("missing explicit independent capability states")
	}
}

func TestRuntimeCapabilityManifest(t *testing.T) {
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		respond(w, http.StatusOK, map[string]string{"version": "1.27.3"})
	}))
	defer forge.Close()
	for _, profile := range []string{"", "local", "docker", "kubernetes", "cloudflare-bridge"} {
		config := testConfig(forge.URL)
		config.RuntimeProfile = profile
		s, err := New(config, nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := s.ListCapabilities(context.Background(), connect.NewRequest(&golfv1.ListCapabilitiesRequest{}))
		if err != nil {
			t.Fatal(err)
		}
		expected := profile
		if expected == "" {
			expected = "portable"
		}
		if response.Msg.RuntimeProfile != expected {
			t.Fatal("runtime profile not reported")
		}
		settings := 0
		for _, c := range response.Msg.Capabilities {
			if strings.HasPrefix(c.Id, "settings.") {
				settings++
				if c.State != golfv1.CapabilityState_CAPABILITY_STATE_READY {
					t.Fatal("implemented portable editor not reported")
				}
			}
		}
		if settings != 5 {
			t.Fatal("missing portable settings capabilities")
		}
	}
	for _, profile := range []string{"cloudflare-native", "k8s", "unknown"} {
		config := testConfig(forge.URL)
		config.RuntimeProfile = profile
		if _, err := New(config, nil); err == nil {
			t.Fatal("unrecognized runtime accepted")
		}
	}
}

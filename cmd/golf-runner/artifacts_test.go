package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestArtifactConsumerVerifiedTLSAndOnceUpload(t *testing.T) {
	var uploads int
	loseAck := false
	data := []byte("owned artifact fixture")
	a := assignment{AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("b", 43), ArtifactPaths: []string{"dist"}, JobResources: testResourceBinding(), TimeoutSeconds: 900, Steps: []struct{ Name, Run, Shell string }{{Run: "true", Shell: "sh"}}}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/poll") {
			w.WriteHeader(204)
			return
		}
		uploads++
		body, _ := io.ReadAll(r.Body)
		if !bytes.Equal(body, data) || r.Header.Get("Golf-Attempt-Token") != a.AttemptToken || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("k", 43) || r.Header.Get("Cookie") != "" {
			t.Error("upload body or scoped headers changed")
		}
		if loseAck {
			w.WriteHeader(503)
		} else {
			w.WriteHeader(204)
		}
	}))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	server.StartTLS()
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "ca.crt")
	if os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600) != nil {
		t.Fatal("CA fixture")
	}
	config, err := runnerTLSConfig(server.URL, ca)
	if err != nil {
		t.Fatal(err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = config
	defer transport.CloseIdleConnections()
	c := coordinator{origin: server.URL, id: "owned", key: strings.Repeat("k", 43), client: &http.Client{Transport: transport}}
	hasCapability := func() bool {
		encoded, _ := json.Marshal(c.pollCapabilities())
		var wire struct{ Capabilities []string }
		json.Unmarshal(encoded, &wire)
		return slices.Contains(wire.Capabilities, runner.ArtifactCapability)
	}
	if hasCapability() || c.validAssignment(a) || c.uploadArtifact(t.Context(), a, data) == nil || uploads != 0 {
		t.Fatal("configuration claimed TLS readiness")
	}
	if _, err := c.poll(t.Context()); err != nil || !hasCapability() || !c.validAssignment(a) {
		t.Fatal("verified TLS consumer unavailable", err)
	}
	if err := c.uploadArtifact(t.Context(), a, data); err != nil || uploads != 1 {
		t.Fatal("once upload failed", err)
	}
	loseAck = true
	if err := c.uploadArtifact(t.Context(), a, data); err == nil || uploads != 2 {
		t.Fatal("uncertain upload was retried or treated as success")
	}
	a.ExecutionEnvironment = &runner.ExecutionEnvironment{}
	if c.validAssignment(a) {
		t.Fatal("artifact assignment adopted secret environment")
	}
	c.origin = "http://127.0.0.1:8080"
	c.verifiedTLS.Store(true)
	if hasCapability() || c.validAssignment(a) || c.uploadArtifact(t.Context(), a, data) == nil || uploads != 2 {
		t.Fatal("HTTP inherited TLS capability")
	}
}

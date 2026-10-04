package main

import (
	"crypto/tls"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestRepositoryEnvironmentRequiresVerifiedHTTPS(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	server.StartTLS()
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "ca.crt")
	if e := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); e != nil {
		t.Fatal(e)
	}
	config, e := runnerTLSConfig(server.URL, ca)
	if e != nil {
		t.Fatal(e)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = config
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	response, e := client.Get(server.URL)
	if e != nil {
		t.Fatal("trusted endpoint TLS failed")
	}
	response.Body.Close()
	wrong := strings.Replace(server.URL, "127.0.0.1", "localhost", 1)
	if response, e = client.Get(wrong); e == nil {
		response.Body.Close()
		t.Fatal("wrong endpoint identity admitted")
	}
	if _, e = runnerTLSConfig("http://127.0.0.1:8080", ca); e == nil {
		t.Fatal("CA configuration represented HTTP as encrypted")
	}
	if _, e = runnerTLSConfig(server.URL, "relative.pem"); e == nil {
		t.Fatal("relative operator CA path accepted")
	}
	untrusted, e := runnerTLSConfig(server.URL, "")
	if e != nil {
		t.Fatal(e)
	}
	transport2 := http.DefaultTransport.(*http.Transport).Clone()
	transport2.Proxy = nil
	transport2.TLSClientConfig = untrusted
	defer transport2.CloseIdleConnections()
	if response, e = (&http.Client{Transport: transport2}).Get(server.URL); e == nil {
		response.Body.Close()
		t.Fatal("untrusted server certificate accepted")
	}
	env := &runner.ExecutionEnvironment{Secrets: map[string]string{"BUILD_CREDENTIAL": "private-test"}}
	c := coordinator{origin: "http://127.0.0.1:8080", actions: &runner.ActionsExecutor{}}
	a := assignment{EngineCatalog: runner.ActionsCatalog, ExecutionEnvironment: env, ActionsPlan: &runner.ActionPlan{Catalog: runner.ActionsCatalog, ArchiveSHA256: strings.Repeat("a", 64), Jobs: []runner.ActionJob{{InstanceID: strings.Repeat("a", 32)}}}, SourceSHA256: strings.Repeat("a", 64), EventJSON: []byte("{}")}
	if c.validAssignment(a) {
		t.Fatal("repository credential assignment accepted over HTTP")
	}
	c.origin = server.URL
	if !c.validAssignment(a) {
		t.Fatal("valid HTTPS repository environment rejected")
	}
	env.Secrets["GOLF_RUNNER_KEY"] = "private-test"
	if c.validAssignment(a) {
		t.Fatal("controller credential namespace accepted")
	}
}

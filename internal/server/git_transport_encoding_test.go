package server

import (
	"bytes"
	"compress/gzip"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Exercise Go's real automatic decompression, which removes Content-Encoding.
// Both managed human Git and runner/job Git use this same forwarding boundary.
func TestForwardGitRefusesNativeResponseEncoding(t *testing.T) {
	for _, service := range []string{"git-upload-pack", "git-receive-pack"} {
		for _, advertisement := range []bool{true, false} {
			for _, encoding := range []string{"plain", "automatic-gzip", "visible-gzip"} {
				t.Run(service+"/"+map[bool]string{true: "advertisement", false: "result"}[advertisement]+"/"+encoding, func(t *testing.T) {
					payload := []byte("bounded native Git bytes")
					var compressed bytes.Buffer
					writer := gzip.NewWriter(&compressed)
					if _, err := writer.Write(payload); err != nil {
						t.Fatal(err)
					}
					if err := writer.Close(); err != nil {
						t.Fatal(err)
					}
					method, suffix, mime := http.MethodPost, service, "result"
					if advertisement {
						method, suffix, mime = http.MethodGet, "info/refs?service="+service, "advertisement"
					}
					native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.Method != method || r.URL.RequestURI() != "/alice/example.git/"+suffix {
							t.Error("unexpected native route")
							w.WriteHeader(http.StatusBadRequest)
							return
						}
						w.Header().Set("Content-Type", "application/x-"+service+"-"+mime)
						if encoding == "plain" {
							_, _ = w.Write(payload)
							return
						}
						w.Header().Set("Content-Encoding", "gzip")
						_, _ = w.Write(compressed.Bytes())
					}))
					defer native.Close()
					transport := http.DefaultTransport.(*http.Transport).Clone()
					transport.DisableCompression = encoding == "visible-gzip"
					defer transport.CloseIdleConnections()
					var uncompressed bool
					var responseEncoding string
					client := &http.Client{Transport: creationRoundTripper(func(r *http.Request) (*http.Response, error) {
						response, err := transport.RoundTrip(r)
						if err == nil {
							uncompressed = response.Uncompressed
							responseEncoding = response.Header.Get("Content-Encoding")
						}
						return response, err
					})}
					s := &Server{config: Config{GiteaURL: native.URL}, client: client}
					incoming := httptest.NewRequest(method, "https://golf.invalid/git/alice/example.git/"+suffix, nil)
					route := gitTransportRoute{Key: repositoryKey{"alice", "example"}, Service: service, Advertisement: advertisement}
					data, err := s.forwardGit(t.Context(), incoming, forgeCredential{Token: "owned-fixture-token"}, User{Login: "alice"}, route, nil, 1024)
					if encoding == "plain" {
						if err != nil || !bytes.Equal(data, payload) || uncompressed || responseEncoding != "" {
							t.Fatal("unencoded native response changed")
						}
						return
					}
					if encoding == "automatic-gzip" && (!uncompressed || responseEncoding != "") {
						t.Fatal("fixture did not exercise Go's transparent gzip decoding")
					}
					if encoding == "visible-gzip" && (uncompressed || responseEncoding != "gzip") {
						t.Fatal("fixture did not preserve the encoded native response")
					}
					if !errors.Is(err, errGitProtocol) || data != nil {
						t.Fatal("encoded native Git bytes escaped forwarding boundary")
					}
				})
			}
		}
	}
}

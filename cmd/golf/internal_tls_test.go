package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestInternalTLSIsOptionalAndIncompleteConfigurationFailsClosed(t *testing.T) {
	for _, name := range []string{"GOLF_INTERNAL_TLS_LISTEN_ADDR", "GOLF_INTERNAL_TLS_CERT_FILE", "GOLF_INTERNAL_TLS_KEY_FILE"} {
		t.Setenv(name, "")
	}
	if settings, err := loadInternalTLSSettings(); settings != nil || err != nil {
		t.Fatal("default enabled TLS", err)
	}
	t.Setenv("GOLF_INTERNAL_TLS_LISTEN_ADDR", ":8443")
	if _, err := loadInternalTLSSettings(); err == nil || err.Error() != "internal TLS configuration is invalid" {
		t.Fatal("incomplete settings accepted or exposed", err)
	}
	t.Setenv("GOLF_INTERNAL_TLS_CERT_FILE", "private-certificate-path")
	t.Setenv("GOLF_INTERNAL_TLS_KEY_FILE", "private-key-path")
	if _, err := loadInternalTLSSettings(); err == nil || err.Error() != "internal TLS configuration is invalid" {
		t.Fatal("unavailable key accepted or exposed", err)
	}
}

func TestInternalTLSProvidesVerifiedRequestTransportAndRejectsOldTLS(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	certificate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyBytes, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	certificatePath := filepath.Join(directory, "certificate.pem")
	keyPath := filepath.Join(directory, "key.pem")
	certificatePEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(certificatePath, certificatePEM, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyBytes}), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOLF_INTERNAL_TLS_LISTEN_ADDR", ":8443")
	t.Setenv("GOLF_INTERNAL_TLS_CERT_FILE", certificatePath)
	t.Setenv("GOLF_INTERNAL_TLS_KEY_FILE", keyPath)
	settings, err := loadInternalTLSSettings()
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := newHTTPServer(listener.Addr().String(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || r.TLS.Version != tls.VersionTLS13 {
			http.Error(w, "transport unavailable", 403)
			return
		}
		w.WriteHeader(204)
	}), zerolog.New(io.Discard))
	server.TLSConfig = settings.config
	done := make(chan error, 1)
	go func() { done <- server.Serve(tls.NewListener(listener, settings.config)) }()
	defer func() { server.Close(); <-done }()
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certificatePEM) {
		t.Fatal("owned trust root invalid")
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	response, err := client.Get("https://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal("request TLS state missing")
	}
	legacy, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp", listener.Addr().String(), &tls.Config{RootCAs: roots, MaxVersion: tls.VersionTLS12})
	if err == nil {
		legacy.Close()
		t.Fatal("TLS1.2 accepted")
	}
	wrong, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp", listener.Addr().String(), &tls.Config{RootCAs: roots, ServerName: "wrong.invalid", MinVersion: tls.VersionTLS13})
	if err == nil {
		wrong.Close()
		t.Fatal("wrong endpoint identity accepted")
	}
}

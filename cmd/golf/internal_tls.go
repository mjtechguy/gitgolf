package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"os"
	"strconv"
	"time"
)

type internalTLSSettings struct {
	address string
	config  *tls.Config
}

// This optional listener supplies actual request TLS state to machine APIs.
// Browser proxy headers never establish this transport property.
func loadInternalTLSSettings() (*internalTLSSettings, error) {
	address := os.Getenv("GOLF_INTERNAL_TLS_LISTEN_ADDR")
	certificateFile := os.Getenv("GOLF_INTERNAL_TLS_CERT_FILE")
	keyFile := os.Getenv("GOLF_INTERNAL_TLS_KEY_FILE")
	if address == "" && certificateFile == "" && keyFile == "" {
		return nil, nil
	}
	invalid := errors.New("internal TLS configuration is invalid")
	if address == "" || certificateFile == "" || keyFile == "" {
		return nil, invalid
	}
	host, portText, err := net.SplitHostPort(address)
	port, portErr := strconv.Atoi(portText)
	if err != nil || portErr != nil || port < 1 || port > 65535 || strconv.Itoa(port) != portText || host != "" && net.ParseIP(host) == nil {
		return nil, invalid
	}
	for _, path := range []string{certificateFile, keyFile} {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > 1<<20 {
			return nil, invalid
		}
	}
	certificate, err := tls.LoadX509KeyPair(certificateFile, keyFile)
	if err != nil || len(certificate.Certificate) == 0 {
		return nil, invalid
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil || time.Now().Before(leaf.NotBefore) || !time.Now().Before(leaf.NotAfter) {
		return nil, invalid
	}
	return &internalTLSSettings{address: address, config: &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{certificate},
		NextProtos:   []string{"h2", "http/1.1"},
	}}, nil
}

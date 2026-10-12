package actionsengine

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"io"
	"net"
	"os/exec"
)

func validJobCA(data []byte) bool {
	count := 0
	for len(data) > 0 {
		block, rest := pem.Decode(data)
		if block == nil || block.Type != "CERTIFICATE" {
			return false
		}
		certificate, err := x509.ParseCertificate(block.Bytes)
		if err != nil || !certificate.IsCA || !certificate.BasicConstraintsValid || certificate.KeyUsage&x509.KeyUsageCertSign == 0 {
			return false
		}
		count++
		data = rest
	}
	return count > 0
}

func engineDependencyFirewall(ctx context.Context, access *protocol.ActionDependencyAccess) bool {
	if access == nil || access.Validate() != nil {
		return false
	}
	cmd := exec.CommandContext(ctx, "/bin/sh", "-ec", protocol.DependencyFirewallReadback)
	var output limitedOutput
	cmd.Stdout = &output
	cmd.Stderr = io.Discard
	if cmd.Run() != nil {
		return false
	}
	host, port, _ := net.SplitHostPort(access.Address)
	return protocol.ValidDependencyFirewall(output.String(), host, port)
}

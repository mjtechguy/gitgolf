package runner

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestDependencyProxyChallengesBeforeDestinationAccess(t *testing.T) {
	p := &dependencyProxy{ctx: t.Context(), password: strings.Repeat("1", 64), slots: make(chan struct{}, 1), resolve: func(context.Context, string) ([]netip.Addr, error) {
		t.Fatal("unauthenticated or denied destination resolved")
		return nil, nil
	}, dial: func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("unauthenticated or denied destination dialed")
		return nil, nil
	}}
	for _, credential := range []string{"", "Basic wrong", "Basic " + base64.StdEncoding.EncodeToString([]byte("golf-job:"+p.password))} {
		r := httptest.NewRequest(http.MethodConnect, "https://example.com:443", nil)
		r.Header.Set("Proxy-Authorization", credential)
		w := httptest.NewRecorder()
		p.ServeHTTP(w, r)
		want := http.StatusProxyAuthRequired
		if strings.HasSuffix(credential, base64.StdEncoding.EncodeToString([]byte("golf-job:"+p.password))) {
			want = http.StatusForbidden
		}
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" || want == http.StatusProxyAuthRequired && w.Header().Get("Proxy-Authenticate") != `Basic realm="Golf job dependencies"` {
			t.Fatal("proxy challenge or authenticated destination boundary differs", w.Code)
		}
	}
}

func TestDependencyDestinationPinsDNSAndDeniesPrivateNetworks(t *testing.T) {
	public := netip.MustParseAddr("93.184.216.34")
	p := &dependencyProxy{gitHost: "golf.example:8443", gitAddress: "10.0.0.5:8443", resolve: func(context.Context, string) ([]netip.Addr, error) { return []netip.Addr{public}, nil }}
	for _, address := range []string{"github.com:443", "golf.example:8443", "metadata.google.internal:443", "169.254.169.254:443", "github.com:80", "github.com.:443", "GITHUB.COM:443", "evil.example:443", "api.github.com:443@evil"} {
		got, err := p.destination(t.Context(), address)
		allowed := address == "github.com:443" || address == "golf.example:8443"
		if (err == nil) != allowed {
			t.Fatal("destination policy differs", address)
		}
		if address == "github.com:443" && got != "93.184.216.34:443" {
			t.Fatal("DNS result was not pinned")
		}
	}
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "198.18.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "64:ff9b::a00:1"} {
		t.Run(address, func(t *testing.T) {
			private := netip.MustParseAddr(address)
			if publicDependencyAddress(private) {
				t.Fatal("nonpublic address allowed")
			}
			p.resolve = func(context.Context, string) ([]netip.Addr, error) { return []netip.Addr{public, private}, nil }
			if _, err := p.destination(t.Context(), "pypi.org:443"); err == nil {
				t.Fatal("mixed public/private DNS accepted")
			}
		})
	}
}

func TestDependencyFirewallRejectsBypassAndChangedProxy(t *testing.T) {
	good := strings.Join([]string{
		"-N GOLF-JOB-EGRESS", "-A GOLF-JOB-EGRESS -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
		"-A GOLF-JOB-EGRESS -d 172.18.0.4/32 -p tcp -m tcp --dport 19000 -j ACCEPT", "-A GOLF-JOB-EGRESS -j DROP",
		"-P FORWARD DROP", "-A FORWARD -j GOLF-JOB-EGRESS", "-A FORWARD -j DROP",
		"-A DOCKER-USER -j GOLF-JOB-EGRESS", "-A DOCKER-USER -j RETURN",
		"-A OUTPUT -o lo -j ACCEPT", "-A OUTPUT -j GOLF-JOB-EGRESS", "-A OUTPUT -j DROP",
		"-A INPUT -i lo -j ACCEPT", "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT", "-A INPUT -j DROP",
		"GOLF-IPV6", "-P FORWARD ACCEPT", "-A FORWARD -j DROP", "-A FORWARD -j DOCKER-USER", "-A FORWARD -j DOCKER-FORWARD", "-P OUTPUT ACCEPT", "-A OUTPUT -j DROP", "-P INPUT ACCEPT", "-A INPUT -j DROP",
	}, "\n")
	if !ValidDependencyFirewall(good, "172.18.0.4", "19000") {
		t.Fatal("correct firewall refused")
	}
	for _, bad := range []string{strings.Replace(good, "-A FORWARD -j GOLF-JOB-EGRESS", "-A FORWARD -j ACCEPT\n-A FORWARD -j GOLF-JOB-EGRESS", 1), strings.Replace(good, "-A DOCKER-USER -j GOLF-JOB-EGRESS", "-A DOCKER-USER -j RETURN", 1), strings.Replace(good, "19000", "19001", 1), strings.Replace(good, "-A GOLF-JOB-EGRESS -j DROP", "-A GOLF-JOB-EGRESS -j ACCEPT", 1), strings.Replace(good, "GOLF-IPV6\n", "GOLF-IPV6\n-A OUTPUT -j ACCEPT\n", 1)} {
		if ValidDependencyFirewall(bad, "172.18.0.4", "19000") {
			t.Fatal("packet bypass allowed")
		}
	}
}

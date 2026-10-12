package runner

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// This is trusted, attempt-local runtime configuration, never YAML authority.
// The parent daemon firewall permits only this proxy's literal TCP address.
type ActionDependencyAccess struct {
	Network  string `json:"network"`
	Address  string `json:"address"`
	Password string `json:"password"`
}

func (a *ActionDependencyAccess) Validate() error {
	if a == nil {
		return nil
	}
	host, port, err := net.SplitHostPort(a.Address)
	ip, e := netip.ParseAddr(host)
	n, pe := strconv.Atoi(port)
	secret, se := hex.DecodeString(a.Password)
	if err != nil || e != nil || !ip.Is4() || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() || ip.String() != host || pe != nil || n < 1024 || n > 65535 || strconv.Itoa(n) != port || se != nil || len(secret) != 32 || hex.EncodeToString(secret) != a.Password || !workerPattern.MatchString(a.Network) || a.Network == "host" || a.Network == "none" {
		return ErrInvalidJob
	}
	return nil
}
func (a ActionDependencyAccess) ProxyURL() string {
	return "http://" + url.UserPassword("golf-job", a.Password).String() + "@" + a.Address
}

// Destination names are a closed ecosystem profile. CONNECT never forwards
// controller credentials, cookies or client headers. DNS is resolved once and
// every returned address must be public before a pinned literal address is used.
var actionsDependencyHosts = map[string]bool{
	"github.com": true, "api.github.com": true, "raw.githubusercontent.com": true,
	"objects.githubusercontent.com": true, "release-assets.githubusercontent.com": true,
	"pypi.org": true, "files.pythonhosted.org": true,
}

func publicDependencyAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, p := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "2001::/23", "64:ff9b::/96", "64:ff9b:1::/48"} {
		if netip.MustParsePrefix(p).Contains(ip) {
			return false
		}
	}
	return true
}

type dependencyProxy struct {
	ctx                           context.Context
	password, gitHost, gitAddress string
	mu                            sync.Mutex
	connections                   map[net.Conn]bool
	slots                         chan struct{}
	resolve                       func(context.Context, string) ([]netip.Addr, error)
	dial                          func(context.Context, string, string) (net.Conn, error)
}

func (p *dependencyProxy) destination(ctx context.Context, address string) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || host == "" || strings.ToLower(host) != host || strings.ContainsAny(host, "%\\@/ ") {
		return "", ErrInvalidJob
	}
	if address == p.gitHost {
		return p.gitAddress, nil
	}
	if port != "443" || !actionsDependencyHosts[host] {
		return "", ErrInvalidJob
	}
	ips, err := p.resolve(ctx, host)
	if err != nil || len(ips) == 0 || len(ips) > 32 {
		return "", ErrInfrastructure
	}
	for _, ip := range ips {
		if !publicDependencyAddress(ip) {
			return "", ErrInvalidJob
		}
	}
	return net.JoinHostPort(ips[0].String(), port), nil
}

func (p *dependencyProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	deny := func() { http.Error(w, "Dependency destination denied or unavailable.", http.StatusForbidden) }
	w.Header().Set("Cache-Control", "no-store")
	expected := "Basic " + base64.StdEncoding.EncodeToString([]byte("golf-job:"+p.password))
	// Git/libcurl's default anyauth waits for the standard proxy challenge.
	// No destination resolution or connection occurs before authentication.
	if len(r.Header.Values("Proxy-Authorization")) != 1 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Proxy-Authorization")), []byte(expected)) != 1 {
		w.Header().Set("Proxy-Authenticate", `Basic realm="Golf job dependencies"`)
		http.Error(w, "Proxy authentication required.", http.StatusProxyAuthRequired)
		return
	}
	if r.Method != http.MethodConnect || r.Host != r.URL.Host || r.URL.Path != "" || r.URL.User != nil || r.URL.RawQuery != "" || p.ctx.Err() != nil {
		deny()
		return
	}
	select {
	case p.slots <- struct{}{}:
		defer func() { <-p.slots }()
	default:
		deny()
		return
	}
	ctx, cancel := context.WithTimeout(p.ctx, 15*time.Second)
	defer cancel()
	address, err := p.destination(ctx, r.Host)
	if err != nil {
		deny()
		return
	}
	remote, err := p.dial(ctx, "tcp", address)
	if err != nil {
		deny()
		return
	}
	defer remote.Close()
	h, ok := w.(http.Hijacker)
	if !ok {
		deny()
		return
	}
	client, buffer, err := h.Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	p.mu.Lock()
	if p.ctx.Err() != nil {
		p.mu.Unlock()
		return
	}
	p.connections[client] = true
	p.connections[remote] = true
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.connections, client); delete(p.connections, remote); p.mu.Unlock() }()
	deadline := time.Now().Add(5 * time.Minute)
	_ = client.SetDeadline(deadline)
	_ = remote.SetDeadline(deadline)
	if _, err = buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil || buffer.Flush() != nil {
		return
	}
	done := make(chan struct{})
	go func() { _, _ = io.Copy(remote, io.LimitReader(buffer, 256<<20)); _ = remote.Close(); close(done) }()
	_, _ = io.Copy(client, io.LimitReader(remote, 256<<20))
	_ = client.Close()
	_ = remote.Close()
	<-done
}

// The explicit public Git exception is installation authority, independently
// bound to exact repository/job capsules at Golf. It grants no private-address
// exception to source-selected dependency destinations.
func StartActionsDependencyProxy(ctx context.Context, network, reachableHost string, git *JobGitContext) (*ActionDependencyAccess, func(), error) {
	if git == nil || git.Validate() != nil {
		return nil, nil, ErrInvalidJob
	}
	u, _ := url.Parse(git.Origin)
	gitPort := u.Port()
	if gitPort == "" {
		gitPort = "443"
	}
	gitHost := net.JoinHostPort(u.Hostname(), gitPort)
	resolveCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupNetIP(resolveCtx, "ip", u.Hostname())
	if err != nil || len(addresses) == 0 {
		return nil, nil, ErrInfrastructure
	}
	listener, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		return nil, nil, ErrInfrastructure
	}
	var entropy [32]byte
	if _, err = rand.Read(entropy[:]); err != nil {
		listener.Close()
		return nil, nil, ErrInfrastructure
	}
	access := &ActionDependencyAccess{Network: network, Address: net.JoinHostPort(reachableHost, strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)), Password: hex.EncodeToString(entropy[:])}
	if access.Validate() != nil {
		listener.Close()
		return nil, nil, ErrInvalidJob
	}
	proxyCtx, stop := context.WithCancel(ctx)
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 15 * time.Second}
	p := &dependencyProxy{ctx: proxyCtx, password: access.Password, gitHost: gitHost, gitAddress: net.JoinHostPort(addresses[0].String(), gitPort), connections: map[net.Conn]bool{}, slots: make(chan struct{}, 16), resolve: func(ctx context.Context, host string) ([]netip.Addr, error) {
		return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	}, dial: dialer.DialContext}
	server := &http.Server{Handler: p, ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 8192, BaseContext: func(net.Listener) context.Context { return proxyCtx }}
	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			stop()
			_ = server.Close()
			p.mu.Lock()
			for connection := range p.connections {
				_ = connection.Close()
			}
			p.mu.Unlock()
		})
	}
	go func() { <-proxyCtx.Done(); cleanup() }()
	go func() { _ = server.Serve(listener) }()
	return access, cleanup, nil
}

package main

// SSH hosts (docs/SSH_HOSTS.md): how ssh-run and ssh-probe reach a machine and run commands there. The SSH client is
// golang.org/x/crypto/ssh (already a Golf dependency); the key is Golf's per-host Ed25519 key, held in memory only. The host key
// must equal the key a person pinned in Golf; without a pin only the key the host offers is read, and nothing authenticates.
// Reaches: direct TCP; Tailscale (tailscaled in userspace networking with an ephemeral node, then `tailscale nc`); Cloudflare
// Tunnel (`cloudflared access ssh`, optionally with an Access service token); Workers VPC (one TCP connection the Durable Object
// bridges to its VPC network binding, accepted on a local port).

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

var (
	// Overridable in tests; the container image installs both at these names.
	tailscaleBin   = "tailscale"
	tailscaledBin  = "tailscaled"
	cloudflaredBin = "cloudflared"

	sshAddressPattern = regexp.MustCompile(`^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|[0-9.]{7,15}|[0-9a-fA-F:]{2,39})$`)
	sshUserPattern    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]{0,31}$`)
	workDirPattern    = regexp.MustCompile(`^/[A-Za-z0-9._/-]{0,199}$`)
	tailscaleTag      = regexp.MustCompile(`^tag:[a-z0-9][a-z0-9-]{0,49}$`)
	tailscaleKey      = regexp.MustCompile(`^tskey-[A-Za-z0-9_-]{8,200}$`)
	accessToken       = regexp.MustCompile(`^[A-Za-z0-9._-]{8,256}$`)

	errHostKeyNotPinned = errors.New("the host key is not pinned yet; confirm its fingerprint in Golf")
	errHostKeyMismatch  = errors.New("the host offered a different host key than the one pinned in Golf")
)

// sshTarget is the connection part of a job, as Golf sends it on standard input.
type sshTarget struct {
	Address       string `json:"address"`
	Port          int    `json:"port"`
	User          string `json:"user"`
	WorkDirectory string `json:"workDirectory"`
	Reach         string `json:"reach"`
	HostKey       string `json:"hostKey"`
	PrivateKey    string `json:"privateKey"`
	Tailscale     *struct {
		AuthKey  string   `json:"authKey"`
		Tags     []string `json:"tags"`
		Hostname string   `json:"hostname"`
	} `json:"tailscale,omitempty"`
	Tunnel *struct {
		Hostname     string `json:"hostname"`
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
	} `json:"tunnel,omitempty"`
	VPC *struct {
		ListenPort int `json:"listenPort"`
	} `json:"vpc,omitempty"`
}

// secrets lists every secret value of the target, for redaction.
func (t sshTarget) secrets() []string {
	s := []string{t.PrivateKey}
	if t.Tailscale != nil {
		s = append(s, t.Tailscale.AuthKey)
	}
	if t.Tunnel != nil {
		s = append(s, t.Tunnel.ClientSecret)
	}
	return s
}

func (t sshTarget) validate() error {
	switch {
	case !sshAddressPattern.MatchString(t.Address) || len(t.Address) > 253:
		return errors.New("address malformed")
	case t.Port < 1 || t.Port > 65535:
		return errors.New("port outside 1-65535")
	case !sshUserPattern.MatchString(t.User):
		return errors.New("user malformed")
	case t.WorkDirectory != "" && (!workDirPattern.MatchString(t.WorkDirectory) || strings.Contains(t.WorkDirectory, "//") ||
		slices.Contains(strings.Split(t.WorkDirectory, "/"), "..") || slices.Contains(strings.Split(t.WorkDirectory, "/"), ".")):
		return errors.New("work directory malformed")
	}
	switch t.Reach {
	case "direct":
	case "tailscale":
		if t.Tailscale == nil || !tailscaleKey.MatchString(t.Tailscale.AuthKey) || len(t.Tailscale.Tags) > 8 || !sshAddressPattern.MatchString(t.Tailscale.Hostname) {
			return errors.New("tailscale settings malformed")
		}
		for _, tag := range t.Tailscale.Tags {
			if !tailscaleTag.MatchString(tag) {
				return errors.New("tailscale tag malformed")
			}
		}
	case "cloudflare-tunnel":
		if t.Tunnel == nil || !sshAddressPattern.MatchString(t.Tunnel.Hostname) || (t.Tunnel.ClientID == "") != (t.Tunnel.ClientSecret == "") ||
			t.Tunnel.ClientID != "" && (!accessToken.MatchString(t.Tunnel.ClientID) || !accessToken.MatchString(t.Tunnel.ClientSecret)) {
			return errors.New("cloudflare tunnel settings malformed")
		}
	case "workers-vpc":
		if t.VPC == nil || t.VPC.ListenPort < 1024 || t.VPC.ListenPort > 65535 {
			return errors.New("workers-vpc settings malformed")
		}
	default:
		return errors.New("unknown reach")
	}
	return nil
}

// signer reads Golf's PKCS#8 Ed25519 private key (base64).
func (t sshTarget) signer() (ssh.Signer, error) {
	der, err := base64.StdEncoding.DecodeString(t.PrivateKey)
	if err != nil {
		return nil, errors.New("private key is not base64")
	}
	key, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, errors.New("private key is not PKCS#8")
	}
	edKey, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("private key is not Ed25519")
	}
	return ssh.NewSignerFromKey(edKey)
}

// pinnedKey parses the pinned host key, or nil when none is pinned.
func (t sshTarget) pinnedKey() (ssh.PublicKey, error) {
	if t.HostKey == "" {
		return nil, nil
	}
	key, _, _, rest, err := ssh.ParseAuthorizedKey([]byte(t.HostKey))
	if err != nil || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("pinned host key malformed")
	}
	return key, nil
}

// hostKeyAlgorithms asks the server for the pinned key's type (or, unpinned, prefers Ed25519).
func hostKeyAlgorithms(pinned ssh.PublicKey) []string {
	if pinned == nil {
		return []string{ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521, ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}
	}
	if pinned.Type() == ssh.KeyAlgoRSA {
		return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}
	}
	return []string{pinned.Type()}
}

// offeredKey is the host key a connection attempt saw, in OpenSSH form.
type offeredKey struct {
	mu  sync.Mutex
	key ssh.PublicKey
}

func (o *offeredKey) authorized() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.key == nil {
		return ""
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(o.key)))
}

// reach is an open path to the host plus whatever must stop with it.
type reach struct {
	conn  net.Conn
	stops []func()
}

func (r *reach) close() {
	if r.conn != nil {
		r.conn.Close()
	}
	for i := len(r.stops) - 1; i >= 0; i-- {
		r.stops[i]()
	}
}

// commandConn is a net.Conn over a helper's standard input and output (like OpenSSH's ProxyCommand).
type commandConn struct {
	cmd    *exec.Cmd
	in     io.WriteCloser
	out    io.ReadCloser
	stderr *limitedBuffer
	once   sync.Once
}

func startCommandConn(ctx context.Context, env []string, name string, args ...string) (*commandConn, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = env
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var errBuf bytes.Buffer
	stderr := &limitedBuffer{buf: &errBuf, max: 4 << 10}
	cmd.Stderr = stderr
	cmd.SysProcAttr = processAttributes()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &commandConn{cmd: cmd, in: in, out: out, stderr: stderr}
	go func() { <-ctx.Done(); c.Close() }()
	return c, nil
}

func (c *commandConn) Read(p []byte) (int, error)  { return c.out.Read(p) }
func (c *commandConn) Write(p []byte) (int, error) { return c.in.Write(p) }
func (c *commandConn) Close() error {
	c.once.Do(func() {
		c.in.Close()
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
		_ = c.cmd.Wait()
	})
	return nil
}
func (c *commandConn) LocalAddr() net.Addr { return &net.UnixAddr{Name: "local", Net: "pipe"} }
func (c *commandConn) RemoteAddr() net.Addr {
	return &net.UnixAddr{Name: filepath.Base(c.cmd.Path), Net: "pipe"}
}
func (c *commandConn) SetDeadline(time.Time) error      { return nil }
func (c *commandConn) SetReadDeadline(time.Time) error  { return nil }
func (c *commandConn) SetWriteDeadline(time.Time) error { return nil }

// helperEnv is the environment for reach helpers: PATH and HOME only, plus what the helper needs.
func helperEnv(home string, extra ...string) []string {
	return append([]string{"PATH=" + os.Getenv("PATH"), "HOME=" + home}, extra...)
}

// openReach opens the path to the SSH port for the target's reach. dir is a private directory for helper state.
func openReach(ctx context.Context, t sshTarget, dir string, note func(string)) (*reach, error) {
	r := &reach{}
	port := strconv.Itoa(t.Port)
	switch t.Reach {
	case "direct":
		d := net.Dialer{Timeout: 20 * time.Second}
		conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(t.Address, port))
		if err != nil {
			return nil, fmt.Errorf("could not connect to %s: %v", net.JoinHostPort(t.Address, port), shortNetError(err))
		}
		r.conn = conn
	case "tailscale":
		socket, stop, err := startTailscale(ctx, t, dir, note)
		if err != nil {
			return nil, err
		}
		r.stops = append(r.stops, stop)
		conn, err := startCommandConn(ctx, helperEnv(dir), tailscaleBin, "--socket", socket, "nc", t.Address, port)
		if err != nil {
			r.close()
			return nil, fmt.Errorf("tailscale nc: %v", err)
		}
		r.conn = conn
	case "cloudflare-tunnel":
		env := helperEnv(dir)
		if t.Tunnel.ClientID != "" {
			env = append(env, "TUNNEL_SERVICE_TOKEN_ID="+t.Tunnel.ClientID, "TUNNEL_SERVICE_TOKEN_SECRET="+t.Tunnel.ClientSecret)
		}
		note("opening Cloudflare Access to " + t.Tunnel.Hostname)
		conn, err := startCommandConn(ctx, env, cloudflaredBin, "access", "ssh", "--hostname", t.Tunnel.Hostname)
		if err != nil {
			return nil, fmt.Errorf("cloudflared access ssh: %v", err)
		}
		r.conn = conn
	case "workers-vpc":
		// The Durable Object connects to this port and bridges it to its VPC network binding.
		ln, err := net.Listen("tcp", ":"+strconv.Itoa(t.VPC.ListenPort))
		if err != nil {
			return nil, fmt.Errorf("workers-vpc bridge: %v", err)
		}
		note("waiting for the Workers VPC bridge")
		type accepted struct {
			conn net.Conn
			err  error
		}
		ch := make(chan accepted, 1)
		go func() { c, err := ln.Accept(); ch <- accepted{c, err} }()
		select {
		case a := <-ch:
			ln.Close()
			if a.err != nil {
				return nil, fmt.Errorf("workers-vpc bridge: %v", a.err)
			}
			r.conn = a.conn
		case <-time.After(60 * time.Second):
			ln.Close()
			return nil, errors.New("the Workers VPC bridge did not connect within 60 seconds")
		case <-ctx.Done():
			ln.Close()
			return nil, ctx.Err()
		}
	default:
		return nil, errors.New("unknown reach")
	}
	return r, nil
}

func shortNetError(err error) string {
	var op *net.OpError
	if errors.As(err, &op) && op.Err != nil {
		return op.Err.Error()
	}
	return err.Error()
}

// startTailscale joins the tailnet as an ephemeral node (state in memory only) with userspace networking, so no device or root
// is needed. The auth key reaches tailscale through a private file, not argv. stop logs out (the node disappears at once).
func startTailscale(ctx context.Context, t sshTarget, dir string, note func(string)) (string, func(), error) {
	tsDir := filepath.Join(dir, "tailscale")
	if err := os.Mkdir(tsDir, 0700); err != nil {
		return "", nil, err
	}
	socket := filepath.Join(tsDir, "tailscaled.sock")
	daemon := exec.Command(tailscaledBin, "--tun=userspace-networking", "--state=mem:", "--statedir="+tsDir, "--socket="+socket, "--port=0")
	daemon.Env = helperEnv(tsDir)
	var logBuf bytes.Buffer
	daemon.Stdout, daemon.Stderr = &limitedBuffer{buf: &logBuf, max: 16 << 10}, &limitedBuffer{buf: &logBuf, max: 16 << 10}
	daemon.SysProcAttr = processAttributes()
	if err := daemon.Start(); err != nil {
		return "", nil, fmt.Errorf("tailscaled: %v", err)
	}
	keyFile := filepath.Join(tsDir, "authkey")
	stop := func() {
		lctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		logout := exec.CommandContext(lctx, tailscaleBin, "--socket", socket, "logout")
		logout.Env = helperEnv(tsDir)
		_ = logout.Run()
		_ = daemon.Process.Kill()
		_ = daemon.Wait()
		_ = os.RemoveAll(tsDir)
	}
	if err := os.WriteFile(keyFile, []byte(t.Tailscale.AuthKey), 0600); err != nil {
		stop()
		return "", nil, err
	}
	args := []string{"--socket", socket, "up", "--auth-key=file:" + keyFile, "--hostname=" + t.Tailscale.Hostname, "--accept-dns=false", "--accept-routes=false", "--timeout=60s"}
	if len(t.Tailscale.Tags) > 0 {
		args = append(args, "--advertise-tags="+strings.Join(t.Tailscale.Tags, ","))
	}
	note("joining the tailnet as ephemeral node " + t.Tailscale.Hostname)
	var out bytes.Buffer
	for attempt := 0; ; attempt++ {
		uctx, cancel := context.WithTimeout(ctx, 75*time.Second)
		up := exec.CommandContext(uctx, tailscaleBin, args...)
		up.Env = helperEnv(tsDir)
		out.Reset()
		up.Stdout, up.Stderr = &limitedBuffer{buf: &out, max: 4 << 10}, &limitedBuffer{buf: &out, max: 4 << 10}
		err := up.Run()
		cancel()
		if err == nil {
			break
		}
		// tailscaled may not listen on its socket yet.
		if attempt < 10 && strings.Contains(out.String(), "tailscaled") && ctx.Err() == nil {
			time.Sleep(time.Second)
			continue
		}
		_ = os.Remove(keyFile)
		stop()
		return "", nil, fmt.Errorf("tailscale up failed: %s", clip(redact(strings.TrimSpace(out.String()), []string{t.Tailscale.AuthKey}), 300))
	}
	_ = os.Remove(keyFile)
	return socket, stop, nil
}

// connectSSH opens the reach and the SSH connection. With auth false (an unpinned probe) it stops after reading the host key.
func connectSSH(ctx context.Context, t sshTarget, dir string, auth bool, offered *offeredKey, note func(string)) (*ssh.Client, *reach, error) {
	pinned, err := t.pinnedKey()
	if err != nil {
		return nil, nil, err
	}
	config := &ssh.ClientConfig{User: t.User, Timeout: 30 * time.Second, HostKeyAlgorithms: hostKeyAlgorithms(pinned),
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			offered.mu.Lock()
			offered.key = key
			offered.mu.Unlock()
			switch {
			case pinned == nil:
				return errHostKeyNotPinned
			case !bytes.Equal(key.Marshal(), pinned.Marshal()):
				return errHostKeyMismatch
			}
			return nil
		}}
	if auth {
		signer, err := t.signer()
		if err != nil {
			return nil, nil, err
		}
		config.Auth = []ssh.AuthMethod{ssh.PublicKeys(signer)}
	}
	r, err := openReach(ctx, t, dir, note)
	if err != nil {
		return nil, nil, err
	}
	addr := net.JoinHostPort(t.Address, strconv.Itoa(t.Port))
	type result struct {
		conn  ssh.Conn
		chans <-chan ssh.NewChannel
		reqs  <-chan *ssh.Request
		err   error
	}
	done := make(chan result, 1)
	go func() {
		c, chans, reqs, err := ssh.NewClientConn(r.conn, addr, config)
		done <- result{c, chans, reqs, err}
	}()
	select {
	case res := <-done:
		if res.err != nil {
			r.close()
			switch {
			case errors.Is(res.err, errHostKeyNotPinned):
				return nil, nil, errHostKeyNotPinned
			case errors.Is(res.err, errHostKeyMismatch):
				return nil, nil, errHostKeyMismatch
			case strings.Contains(res.err.Error(), "unable to authenticate"):
				return nil, nil, fmt.Errorf("the host refused Golf's key for %s; install the public key from Golf in that account's ~/.ssh/authorized_keys", t.User)
			}
			return nil, nil, fmt.Errorf("SSH handshake failed: %s", clip(res.err.Error(), 200))
		}
		return ssh.NewClient(res.conn, res.chans, res.reqs), r, nil
	case <-time.After(45 * time.Second):
		r.close()
		return nil, nil, errors.New("SSH handshake timed out")
	case <-ctx.Done():
		r.close()
		return nil, nil, ctx.Err()
	}
}

// shQuote quotes one word for a POSIX shell (and for fish, which reads '…'\”…' the same way); scripts here never use backslashes.
func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// shellCommand is the exec request: the account's login shell runs `/bin/sh -c script`, so the script is POSIX whatever that shell is.
func shellCommand(script string) string { return "/bin/sh -c " + shQuote(script) }

// loginScript runs script in the account's login shell (-l), so tools installed in its profile's PATH are found.
func loginScript(script string) string { return `exec "${SHELL:-/bin/sh}" -lc ` + shQuote(script) }

// remoteRun runs one command; it returns the exit status (-1 when the host sent none). When ctx ends the remote side is sent
// SIGTERM and the session closes.
func remoteRun(ctx context.Context, client *ssh.Client, command string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	session, err := client.NewSession()
	if err != nil {
		return -1, fmt.Errorf("SSH session: %v", err)
	}
	defer session.Close()
	session.Stdin, session.Stdout, session.Stderr = stdin, stdout, stderr
	if err := session.Start(command); err != nil {
		return -1, fmt.Errorf("SSH command: %v", err)
	}
	waited := make(chan error, 1)
	go func() { waited <- session.Wait() }()
	select {
	case err = <-waited:
	case <-ctx.Done():
		_ = session.Signal(ssh.SIGTERM)
		session.Close()
		<-waited
		return -1, ctx.Err()
	}
	return exitStatus(err)
}

func exitStatus(err error) (int, error) {
	var exit *ssh.ExitError
	var missing *ssh.ExitMissingError
	switch {
	case err == nil:
		return 0, nil
	case errors.As(err, &exit):
		return exit.ExitStatus(), nil
	case errors.As(err, &missing):
		return -1, nil
	}
	return -1, err
}

// remoteOutput runs a short command and returns its bounded standard output and exit status.
func remoteOutput(ctx context.Context, client *ssh.Client, command string, timeout time.Duration) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var out, errOut bytes.Buffer
	code, err := remoteRun(ctx, client, command, nil, &limitedBuffer{buf: &out, max: 64 << 10}, &limitedBuffer{buf: &errOut, max: 8 << 10})
	if code != 0 && out.Len() == 0 {
		out.Write(errOut.Bytes())
	}
	return out.Bytes(), code, err
}

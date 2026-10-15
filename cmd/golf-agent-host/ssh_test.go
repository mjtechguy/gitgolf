package main

// SSH host runner tests against a real OpenSSH server started as this user on a free local port (skipped when /usr/sbin/sshd or
// ssh-keygen is missing). The fake Golf server and the fake tool are the outbound host's (main_test.go). Tailscale and
// cloudflared are replaced by scripts that check their arguments and connect through this test binary (TestHelperNetcat).

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// TestHelperNetcat is a netcat for the fake reach helpers: `test-binary -test.run=TestHelperNetcat -- host port`.
func TestHelperNetcat(t *testing.T) {
	args := os.Args
	at := -1
	for i, a := range args {
		if a == "--" {
			at = i
		}
	}
	if at < 0 || len(args) != at+3 {
		return
	}
	conn, err := net.Dial("tcp", net.JoinHostPort(args[at+1], args[at+2]))
	if err != nil {
		os.Exit(3)
	}
	go func() { _, _ = io.Copy(conn, os.Stdin); conn.(*net.TCPConn).CloseWrite() }()
	_, _ = io.Copy(os.Stdout, conn)
	os.Exit(0)
}

type testSSHD struct {
	dir, home, bin, dump string
	port                 int
	hostKey              string // authorized_keys form of the server's key
	privateKey           string // Golf's PKCS#8 key, base64
	cmd                  *exec.Cmd
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func newTestSSHD(t *testing.T) *testSSHD {
	t.Helper()
	if _, err := os.Stat("/usr/sbin/sshd"); err != nil {
		t.Skip("no /usr/sbin/sshd on this machine")
	}
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("no ssh-keygen on this machine")
	}
	dir := t.TempDir()
	s := &testSSHD{dir: dir, home: filepath.Join(dir, "home"), bin: filepath.Join(dir, "bin"), dump: filepath.Join(dir, "dump"), port: freePort(t)}
	for _, d := range []string{s.home, s.bin} {
		if err := os.Mkdir(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if out, err := exec.Command(keygen, "-q", "-t", "ed25519", "-N", "", "-f", filepath.Join(dir, "hostkey")).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v %s", err, out)
	}
	pub, _ := os.ReadFile(filepath.Join(dir, "hostkey.pub"))
	fields := strings.Fields(string(pub))
	s.hostKey = fields[0] + " " + fields[1]
	golfPub, golfPriv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(golfPriv)
	s.privateKey = base64.StdEncoding.EncodeToString(der)
	sshPub, _ := ssh.NewPublicKey(golfPub)
	if err := os.WriteFile(filepath.Join(dir, "authorized_keys"), []byte("restrict "+string(ssh.MarshalAuthorizedKey(sshPub))), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.bin, "claude"), []byte(fakeTool), 0700); err != nil {
		t.Fatal(err)
	}
	config := strings.Join([]string{
		"Port " + strconv.Itoa(s.port), "ListenAddress 127.0.0.1", "HostKey " + filepath.Join(dir, "hostkey"), "AuthorizedKeysFile " + filepath.Join(dir, "authorized_keys"),
		"PidFile " + filepath.Join(dir, "sshd.pid"), "StrictModes no", "UsePAM no", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
		"SetEnv HOME=" + s.home + " SHELL=/bin/sh PATH=" + s.bin + ":/usr/bin:/bin FAKE_DUMP=" + s.dump, "",
	}, "\n")
	if err := os.WriteFile(filepath.Join(dir, "sshd_config"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	s.cmd = exec.Command("/usr/sbin/sshd", "-D", "-e", "-f", filepath.Join(dir, "sshd_config"))
	var log bytes.Buffer
	s.cmd.Stderr = &log
	// Its own process group, so the per-connection sshd children stop with it (they hold the log pipe).
	s.cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	s.cmd.WaitDelay = 2 * time.Second
	if err := s.cmd.Start(); err != nil {
		t.Skipf("sshd did not start: %v", err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL); _ = s.cmd.Wait() })
	for i := 0; i < 50; i++ {
		if c, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(s.port)); err == nil {
			c.Close()
			return s
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("sshd did not listen: %s", log.String())
	return nil
}

func (s *testSSHD) target(pinned bool) sshTarget {
	t := sshTarget{Address: "127.0.0.1", Port: s.port, User: os.Getenv("USER"), Reach: "direct", PrivateKey: s.privateKey}
	if t.User == "" {
		out, _ := exec.Command("id", "-un").Output()
		t.User = strings.TrimSpace(string(out))
	}
	if pinned {
		t.HostKey = s.hostKey
	}
	return t
}

func sshProbe(t *testing.T, target sshTarget) probeReport {
	t.Helper()
	in, _ := json.Marshal(sshJob{SSH: target})
	var out bytes.Buffer
	if err := cmdSSHProbe(context.Background(), bytes.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	var report probeReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("probe output %q: %v", out.String(), err)
	}
	return report
}

func TestSSHProbeOffersKeyThenProvesItAndReportsTools(t *testing.T) {
	s := newTestSSHD(t)
	// Unpinned: only the offered key, nothing authenticates.
	first := sshProbe(t, s.target(false))
	if first.HostKey != s.hostKey || first.Authenticated || first.Matched != nil || first.Error != "" || !strings.HasPrefix(first.Fingerprint, "SHA256:") {
		t.Fatalf("unpinned probe: %+v", first)
	}
	// Pinned: signs in, reports the OS and the fake Claude Code (version and sign-in from its status command).
	second := sshProbe(t, s.target(true))
	if !second.Authenticated || second.Matched == nil || !*second.Matched || second.OS != "linux" || second.Arch == "" || second.Error != "" {
		t.Fatalf("pinned probe: %+v", second)
	}
	if len(second.Tools) != 1 || second.Tools[0].Tool != "claude" || second.Tools[0].Version != "9.9.9" || second.Tools[0].SignedIn == nil || !*second.Tools[0].SignedIn {
		t.Fatalf("tools: %+v", second.Tools)
	}
	// Another pinned key: refused before any sign-in, and the offered key is reported.
	other := s.target(true)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	k, _ := ssh.NewPublicKey(otherPub)
	other.HostKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k)))
	third := sshProbe(t, other)
	if third.Authenticated || third.Matched == nil || *third.Matched || third.HostKey != s.hostKey || !strings.Contains(third.Error, "different host key") {
		t.Fatalf("mismatched probe: %+v", third)
	}
	// Golf's key not installed: the host refuses it, with what to do.
	stranger := s.target(true)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	stranger.PrivateKey = base64.StdEncoding.EncodeToString(der)
	fourth := sshProbe(t, stranger)
	if fourth.Authenticated || !strings.Contains(fourth.Error, "authorized_keys") || strings.Contains(fourth.Error, stranger.PrivateKey) {
		t.Fatalf("refused key probe: %+v", fourth)
	}
	// A malformed job is reported, not run.
	var out bytes.Buffer
	_ = cmdSSHProbe(context.Background(), strings.NewReader(`{"ssh":{"address":"bad host","port":22,"user":"x","reach":"direct"}}`), &out)
	if !strings.Contains(out.String(), "invalid job") {
		t.Fatalf("malformed job: %s", out.String())
	}
}

// runSSH runs ssh-run for one fake task against the test sshd.
func runSSH(t *testing.T, f *fakeGolf, ft *fakeTask, target sshTarget) string {
	t.Helper()
	in, _ := json.Marshal(sshJob{Origin: f.srv.URL, Task: &ft.task, SSH: target})
	var out syncBuffer
	done := make(chan error, 1)
	go func() { done <- cmdSSHRun(context.Background(), bytes.NewReader(in), &out) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("ssh-run: %v (%s)", err, out.String())
		}
	case <-time.After(90 * time.Second):
		t.Fatalf("ssh-run did not finish: %s", out.String())
	}
	if ft.finish == nil {
		t.Fatalf("no finish: %s", out.String())
	}
	return out.String()
}

func remoteWorkLeft(t *testing.T, s *testSSHD) []string {
	entries, _ := os.ReadDir(filepath.Join(s.home, ".golf-agent", "work"))
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestSSHRunCommitsPushesAndCleansUpWithoutTheTokenOnTheHost(t *testing.T) {
	s := newTestSSHD(t)
	f := newFakeGolf(t)
	ft := f.addTask("Please say hello. MODE=success", 10*time.Minute, nil)
	runSSH(t, f, ft, s.target(true))
	if ft.finish.State != "succeeded" || ft.finish.CommitID == "" || ft.finish.ExitCode != 0 {
		t.Fatalf("finish: %+v\nlog: %s", ft.finish, strings.Join(ft.lines, "\n"))
	}
	if got := strings.Join(ft.finish.ChangedFiles, ","); got != "HELLO.md,docs/NOTE.md" {
		t.Fatalf("changed files %s", got)
	}
	if ft.finish.Summary != "Created HELLO.md and docs/NOTE.md." || ft.finish.Usage == nil || ft.finish.Usage.InputTokens != 13 {
		t.Fatalf("summary/usage: %+v", ft.finish)
	}
	// The branch in Golf: one commit on baseCommit, the agent identity and the trailer.
	head := gitCommand(t, f.bare, "rev-parse", "refs/heads/"+ft.task.Branch)
	if head != ft.finish.CommitID || gitCommand(t, f.bare, "rev-parse", head+"^") != f.base {
		t.Fatalf("branch %s parent", head)
	}
	message := gitCommand(t, f.bare, "log", "-1", "--format=%an <%ae>%n%B", head)
	if !strings.Contains(message, "Golf agent (claude) <agent@golf.invalid>") || !strings.Contains(message, "Golf-Agent-Task: "+ft.task.ID) {
		t.Fatalf("commit message %s", message)
	}
	// The tool ran on the host in its own working copy, read the prompt on stdin, and never saw the token.
	pwd, _ := os.ReadFile(s.dump + ".pwd")
	if !strings.HasPrefix(strings.TrimSpace(string(pwd)), filepath.Join(s.home, ".golf-agent", "work", ft.task.ID, "repo")) {
		t.Fatalf("tool ran in %s", pwd)
	}
	for _, file := range []string{s.dump + ".env", s.dump + ".initenv", s.dump + ".args"} {
		data, _ := os.ReadFile(file)
		if bytes.Contains(data, []byte(ft.task.Token)) || bytes.Contains(data, []byte("golf_agent_task_")) {
			t.Fatalf("%s holds the task token", file)
		}
	}
	args, _ := os.ReadFile(s.dump + ".args")
	if !strings.Contains(string(args), "--permission-mode\nacceptEdits") || strings.Contains(string(args), "MODE=") {
		t.Fatalf("args %s", args)
	}
	if left := remoteWorkLeft(t, s); len(left) != 0 {
		t.Fatalf("remote work left: %v", left)
	}
	log := strings.Join(ft.lines, "\n")
	for _, want := range []string{"connecting to", "sending the working copy", "running claude on branch", "a warning on stderr", "Writing HELLO.md", "pushed " + ft.task.Branch} {
		if !strings.Contains(log, want) {
			t.Fatalf("log lacks %q:\n%s", want, log)
		}
	}
	if strings.Contains(log, ft.task.Token) {
		t.Fatal("log holds the token")
	}
}

func TestSSHRunNoChangesFailureAndFoldedCommits(t *testing.T) {
	s := newTestSSHD(t)
	f := newFakeGolf(t)
	for _, c := range []struct{ mode, state string }{{"nochange", "no_changes"}, {"fail", "failed"}, {"selfcommit", "succeeded"}} {
		ft := f.addTask("MODE="+c.mode, 10*time.Minute, nil)
		runSSH(t, f, ft, s.target(true))
		if ft.finish.State != c.state {
			t.Fatalf("%s: %+v\n%s", c.mode, ft.finish, strings.Join(ft.lines, "\n"))
		}
		if c.mode == "selfcommit" {
			// The tool's own commit on the host is not taken; its tree is, as one proposal commit.
			if got := strings.Join(ft.finish.ChangedFiles, ","); got != "ONE.txt,TWO.txt" {
				t.Fatalf("selfcommit files %s", got)
			}
		}
	}
	if left := remoteWorkLeft(t, s); len(left) != 0 {
		t.Fatalf("remote work left: %v", left)
	}
}

func TestSSHRunCancelStopsTheRemoteToolAndCleansUp(t *testing.T) {
	s := newTestSSHD(t)
	f := newFakeGolf(t)
	old := cancelPollInterval
	cancelPollInterval = 500 * time.Millisecond
	t.Cleanup(func() { cancelPollInterval = old })
	// Cancel learnt from a log answer while the tool waits.
	ft := f.addTask("MODE=cancel", 10*time.Minute, func(ft *fakeTask) { ft.cancelOnLine = "CANCEL_POINT" })
	runSSH(t, f, ft, s.target(true))
	if ft.finish.State != "cancelled" {
		t.Fatalf("finish %+v", ft.finish)
	}
	waitGone(t, s.dump+".child")
	if left := remoteWorkLeft(t, s); len(left) != 0 {
		t.Fatalf("remote work left: %v", left)
	}
	// A silent tool: the empty-chunk poll learns of the cancel.
	silent := f.addTask("MODE=silent", 10*time.Minute, nil)
	go func() {
		for i := 0; i < 100; i++ {
			time.Sleep(200 * time.Millisecond)
			f.mu.Lock()
			if silent.started {
				silent.cancelOnLine = "running claude"
			}
			f.mu.Unlock()
		}
	}()
	runSSH(t, f, silent, s.target(true))
	if silent.finish.State != "cancelled" {
		t.Fatalf("silent finish %+v", silent.finish)
	}
	// The deadline.
	late := f.addTask("MODE=deadline", 8*time.Second, nil)
	runSSH(t, f, late, s.target(true))
	if late.finish.State != "timed_out" {
		t.Fatalf("deadline finish %+v", late.finish)
	}
}

func TestSSHRunRefusesAnotherHostKeyBeforeSendingAnything(t *testing.T) {
	s := newTestSSHD(t)
	f := newFakeGolf(t)
	ft := f.addTask("MODE=success", 10*time.Minute, nil)
	target := s.target(true)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	k, _ := ssh.NewPublicKey(otherPub)
	target.HostKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k)))
	runSSH(t, f, ft, target)
	if ft.finish.State != "failed" || !strings.Contains(ft.finish.Failure, "connect_failed") || !strings.Contains(ft.finish.Failure, "different host key") {
		t.Fatalf("finish %+v", ft.finish)
	}
	if _, err := os.Stat(filepath.Join(s.home, ".golf-agent")); err == nil {
		t.Fatal("something reached the host")
	}
}

// fakeReach writes fake tailscale, tailscaled and cloudflared that connect through TestHelperNetcat.
func fakeReach(t *testing.T, port int) (dir, record string) {
	t.Helper()
	dir = t.TempDir()
	record = filepath.Join(dir, "record")
	self, _ := os.Executable()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0700); err != nil {
			t.Fatal(err)
		}
	}
	write("tailscaled", `echo "tailscaled $*" >> `+record+`; exec sleep 300`+"\n")
	write("tailscale", `echo "tailscale $*" >> `+record+`
for a in "$@"; do case "$a" in --auth-key=file:*) echo "key $(cat "${a#--auth-key=file:}")" >> `+record+`;; esac; done
case "$3" in nc) exec `+self+` -test.run=TestHelperNetcat -- 127.0.0.1 "$5";; esac
exit 0
`)
	write("cloudflared", `echo "cloudflared $* id=$TUNNEL_SERVICE_TOKEN_ID secret=$TUNNEL_SERVICE_TOKEN_SECRET" >> `+record+`
exec `+self+` -test.run=TestHelperNetcat -- 127.0.0.1 `+strconv.Itoa(port)+"\n")
	return dir, record
}

func TestSSHReachesTailscaleCloudflareTunnelAndWorkersVPC(t *testing.T) {
	s := newTestSSHD(t)
	dir, record := fakeReach(t, s.port)
	saved := []string{tailscaleBin, tailscaledBin, cloudflaredBin}
	tailscaleBin, tailscaledBin, cloudflaredBin = filepath.Join(dir, "tailscale"), filepath.Join(dir, "tailscaled"), filepath.Join(dir, "cloudflared")
	t.Cleanup(func() { tailscaleBin, tailscaledBin, cloudflaredBin = saved[0], saved[1], saved[2] })

	ts := s.target(true)
	ts.Reach = "tailscale"
	ts.Tailscale = &struct {
		AuthKey  string   `json:"authKey"`
		Tags     []string `json:"tags"`
		Hostname string   `json:"hostname"`
	}{AuthKey: "tskey-auth-test123456", Tags: []string{"tag:golf-agent"}, Hostname: "golf-1a2b3c4d"}
	if report := sshProbe(t, ts); !report.Authenticated {
		t.Fatalf("tailscale probe %+v", report)
	}
	tunnel := s.target(true)
	tunnel.Reach = "cloudflare-tunnel"
	tunnel.Tunnel = &struct {
		Hostname     string `json:"hostname"`
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
	}{Hostname: "ssh.example.com", ClientID: "abcdefgh.access", ClientSecret: strings.Repeat("S", 32)}
	if report := sshProbe(t, tunnel); !report.Authenticated {
		t.Fatalf("tunnel probe %+v", report)
	}
	data, _ := os.ReadFile(record)
	text := string(data)
	for _, want := range []string{"tailscaled --tun=userspace-networking --state=mem:", "up --auth-key=file:", "--hostname=golf-1a2b3c4d", "--advertise-tags=tag:golf-agent",
		"key tskey-auth-test123456", " nc 127.0.0.1 " + strconv.Itoa(s.port), " logout", "cloudflared access ssh --hostname ssh.example.com id=abcdefgh.access secret=" + strings.Repeat("S", 32)} {
		if !strings.Contains(text, want) {
			t.Fatalf("record lacks %q:\n%s", want, text)
		}
	}
	// The auth key never appears in argv.
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "tailscale") && strings.Contains(line, "tskey-") {
			t.Fatalf("auth key in argv: %s", line)
		}
	}
	// Workers VPC: ssh-probe listens; the bridge (the Durable Object, here a goroutine) connects and pipes to the host.
	vpc := s.target(true)
	vpc.Reach = "workers-vpc"
	vpc.VPC = &struct {
		ListenPort int `json:"listenPort"`
	}{ListenPort: freePort(t)}
	go func() {
		for i := 0; i < 100; i++ {
			inner, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(vpc.VPC.ListenPort))
			if err != nil {
				time.Sleep(100 * time.Millisecond)
				continue
			}
			outer, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(s.port))
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(outer, inner) }()
			_, _ = io.Copy(inner, outer)
			return
		}
	}()
	if report := sshProbe(t, vpc); !report.Authenticated {
		t.Fatalf("vpc probe %+v", report)
	}
}

func TestExtractArchiveRefusesEscapes(t *testing.T) {
	build := func(entries ...[3]string) *bytes.Buffer {
		var buf bytes.Buffer
		tw := newTarWriter(&buf)
		for _, e := range entries {
			tw.add(e[0], e[1], e[2])
		}
		tw.close()
		return &buf
	}
	for name, archive := range map[string]*bytes.Buffer{
		"dotdot":   build([3]string{"file", "../evil", "x"}),
		"absolute": build([3]string{"file", "/tmp/evil", "x"}),
		"symlink":  build([3]string{"symlink", "link", "/tmp"}, [3]string{"file", "link/evil", "x"}),
	} {
		root := t.TempDir()
		if err := extractArchive(archive, root); err == nil {
			t.Fatalf("%s: extracted", name)
		}
	}
	root := t.TempDir()
	if err := extractArchive(build([3]string{"file", "./a/b.txt", "hello"}, [3]string{"file", ".git/config", "[core]"}, [3]string{"symlink", "a/l", "b.txt"}), root); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "a", "b.txt")); string(data) != "hello" {
		t.Fatalf("content %q", data)
	}
	if _, err := os.Stat(filepath.Join(root, ".git")); err == nil {
		t.Fatal(".git was taken from the host")
	}
	if target, _ := os.Readlink(filepath.Join(root, "a", "l")); target != "b.txt" {
		t.Fatalf("symlink %q", target)
	}
}

func TestSSHJobValidation(t *testing.T) {
	good := `{"origin":"https://golf.example","ssh":{"address":"h.example.net","port":22,"user":"agent","reach":"direct","privateKey":"x"}}`
	if _, err := readJob(strings.NewReader(good)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		`{"ssh":{"address":"h","port":0,"user":"agent","reach":"direct"}}`,
		`{"ssh":{"address":"h","port":22,"user":"a b","reach":"direct"}}`,
		`{"ssh":{"address":"h","port":22,"user":"agent","reach":"pigeon"}}`,
		`{"ssh":{"address":"h","port":22,"user":"agent","reach":"tailscale","tailscale":{"authKey":"nope","hostname":"x"}}}`,
		`{"ssh":{"address":"h","port":22,"user":"agent","reach":"cloudflare-tunnel","tunnel":{"hostname":"h","clientId":"abcdefgh"}}}`,
		`{"ssh":{"address":"h","port":22,"user":"agent","reach":"direct","workDirectory":"/a/../b"}}`,
		`{"ssh":{"address":"h","port":22,"user":"agent","reach":"direct"},"extra":1}`,
	} {
		if _, err := readJob(strings.NewReader(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	if !strings.Contains(shellCommand("echo 'x'"), `'echo '\''x'\'''`) {
		t.Fatal(shellCommand("echo 'x'"))
	}
}

type testTar struct{ tw *tar.Writer }

func newTarWriter(w io.Writer) *testTar { return &testTar{tw: tar.NewWriter(w)} }
func (t *testTar) add(kind, name, value string) {
	if kind == "symlink" {
		_ = t.tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeSymlink, Linkname: value, Mode: 0777})
		return
	}
	_ = t.tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0644, Size: int64(len(value))})
	_, _ = t.tw.Write([]byte(value))
}
func (t *testTar) close() { _ = t.tw.Close() }

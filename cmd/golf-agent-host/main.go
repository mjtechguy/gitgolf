// Command golf-agent-host is the outbound host process for Golf agent hosts
// (docs/AGENT_HOSTS.md). It registers a machine, reports the coding CLIs installed
// there, claims tasks and runs one CLI headless per task in a private working copy.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const hostVersion = "0.1.0"

var (
	uuidPattern       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	shaPattern        = regexp.MustCompile(`^[0-9a-f]{40}$`)
	regTokenPattern   = regexp.MustCompile(`^golfagentreg_[0-9a-f]{64}$`)
	credentialPattern = regexp.MustCompile(`^golf_agent_host_([0-9a-f-]{36})_[0-9a-f]{64}$`)
	modelPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`)
)

// hostFile is DIR/host.json. It holds the host credential and is written 0600.
type hostFile struct {
	Origin     string `json:"origin"`
	HostID     int64  `json:"hostId"`
	UUID       string `json:"uuid"`
	Name       string `json:"name"`
	Credential string `json:"credential"`
}

// toolConfig is one entry of the optional configuration file's "tools" object.
type toolConfig struct {
	Enabled   *bool    `json:"enabled,omitempty"`
	Models    []string `json:"models,omitempty"`
	ExtraArgs []string `json:"extraArgs,omitempty"`
	// Sandbox applies to Codex only: "workspace-write" (default) or "danger-full-access".
	Sandbox string `json:"sandbox,omitempty"`
}

type config struct {
	MaxConcurrent int                   `json:"maxConcurrent,omitempty"`
	WorkRoot      string                `json:"workRoot,omitempty"`
	KeepWork      bool                  `json:"keepWork,omitempty"`
	Tools         map[string]toolConfig `json:"tools,omitempty"`
}

func (c config) tool(name string) toolConfig { return c.Tools[name] }

func (c config) enabled(name string) bool {
	t, ok := c.Tools[name]
	return !ok || t.Enabled == nil || *t.Enabled
}

func (c config) codexSandbox() string {
	if s := c.Tools["codex"].Sandbox; s != "" {
		return s
	}
	return "workspace-write"
}

func validOrigin(origin string) bool {
	u, err := url.Parse(origin)
	return err == nil && u.String() == origin && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && u.Path == "" &&
		(u.Scheme == "https" || u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))
}

// privateDirectory creates path (0700) and refuses it unless it is a real directory
// owned by this user, not group or world accessible, and reached without symlinks.
func privateDirectory(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return fmt.Errorf("%s: use an absolute, clean path", path)
	}
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("%s must be a private directory (mode 0700, not a symlink)", path)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("%s must be owned by this user", path)
	}
	if resolved, err := filepath.EvalSymlinks(path); err != nil || resolved != path {
		return fmt.Errorf("%s cannot be reached through a symlink", path)
	}
	return nil
}

// privateFile checks an existing file is a regular, user-owned file with no group or
// world access.
func privateFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("%s must be a private regular file (mode 0600, not a symlink)", path)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("%s must be owned by this user", path)
	}
	return nil
}

// writePrivateJSON atomically replaces file with value, mode 0600.
func writePrivateJSON(file string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".host-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		if _, err = f.Write(append(data, '\n')); err == nil {
			err = f.Sync()
		}
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), file)
}

func loadHostFile(state string) (hostFile, error) {
	var h hostFile
	if err := privateDirectory(state); err != nil {
		return h, err
	}
	file := filepath.Join(state, "host.json")
	if err := privateFile(file); err != nil {
		return h, fmt.Errorf("host.json unavailable (run register first): %w", err)
	}
	data, err := os.ReadFile(file)
	if err != nil || len(data) > 16<<10 {
		return h, errors.New("host.json unreadable")
	}
	if err := json.Unmarshal(data, &h); err != nil {
		return h, errors.New("host.json is not valid JSON")
	}
	m := credentialPattern.FindStringSubmatch(h.Credential)
	if !validOrigin(h.Origin) || m == nil || m[1] != h.UUID || !uuidPattern.MatchString(h.UUID) {
		return h, errors.New("host.json does not hold a valid origin and host credential; register again")
	}
	return h, nil
}

func loadConfig(path string) (config, error) {
	var c config
	if path != "" {
		info, err := os.Lstat(path)
		if err != nil {
			return c, err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Size() > 64<<10 {
			return c, fmt.Errorf("%s must be a regular file, not a symlink, not group or world writable, at most 64 KiB", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return c, err
		}
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&c); err != nil || decoder.Decode(new(any)) != io.EOF {
			return c, fmt.Errorf("%s: invalid configuration: %v", path, err)
		}
	}
	if c.MaxConcurrent == 0 {
		c.MaxConcurrent = 1
	}
	if c.MaxConcurrent < 1 || c.MaxConcurrent > 4 {
		return c, errors.New("maxConcurrent must be 1 to 4 (Golf runs at most 4 tasks per host)")
	}
	if c.WorkRoot != "" && (!filepath.IsAbs(c.WorkRoot) || filepath.Clean(c.WorkRoot) != c.WorkRoot) {
		return c, errors.New("workRoot must be an absolute, clean path")
	}
	for name, t := range c.Tools {
		if toolSpecs[name] == nil {
			return c, fmt.Errorf("unknown tool %q (use codex, claude, opencode or grok)", name)
		}
		for _, m := range t.Models {
			if !modelPattern.MatchString(m) {
				return c, fmt.Errorf("tools.%s.models: %q is not a model name", name, m)
			}
		}
		if len(t.ExtraArgs) > 32 {
			return c, fmt.Errorf("tools.%s.extraArgs: at most 32 arguments", name)
		}
		for _, a := range t.ExtraArgs {
			if a == "" || len(a) > 1024 || strings.ContainsRune(a, 0) || a == "--" || !utf8.ValidString(a) {
				return c, fmt.Errorf("tools.%s.extraArgs: invalid argument", name)
			}
		}
		if t.Sandbox != "" && (name != "codex" || t.Sandbox != "workspace-write" && t.Sandbox != "danger-full-access") {
			return c, errors.New(`sandbox is a Codex setting: "workspace-write" or "danger-full-access"`)
		}
	}
	return c, nil
}

func cmdRegister(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("register", flag.ContinueOnError)
	origin := fs.String("origin", "", "Golf origin, e.g. https://golf.example.com")
	name := fs.String("name", "", "name shown in Golf for this host")
	state := fs.String("state", "", "absolute private state directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	token := os.Getenv("GOLF_AGENT_REGISTRATION_TOKEN")
	os.Unsetenv("GOLF_AGENT_REGISTRATION_TOKEN")
	*name = strings.TrimSpace(*name)
	if fs.NArg() != 0 || !validOrigin(*origin) {
		return errors.New("use --origin with an exact HTTPS origin (HTTP only for localhost)")
	}
	if *name == "" || utf8.RuneCountInString(*name) > 100 || strings.ContainsAny(*name, "\x00\r\n") {
		return errors.New("use --name with 1 to 100 characters")
	}
	if !regTokenPattern.MatchString(token) {
		return errors.New("set GOLF_AGENT_REGISTRATION_TOKEN to the registration token from Golf")
	}
	if err := privateDirectory(*state); err != nil {
		return err
	}
	c := newAPIClient(*origin, "")
	var out struct {
		HostID     wireID `json:"hostId"`
		UUID       string `json:"uuid"`
		Credential string `json:"credential"`
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := c.post(ctx, "/native/agent-host/register", "", map[string]any{
		"registrationToken": token, "name": *name, "hostVersion": hostVersion, "os": runtime.GOOS, "arch": runtime.GOARCH,
	}, &out)
	if err != nil {
		return fmt.Errorf("registration failed: %w", err)
	}
	m := credentialPattern.FindStringSubmatch(out.Credential)
	if !uuidPattern.MatchString(out.UUID) || m == nil || m[1] != out.UUID || int64(out.HostID) < 1 {
		return errors.New("registration response did not hold a valid host credential")
	}
	h := hostFile{Origin: *origin, HostID: int64(out.HostID), UUID: out.UUID, Name: *name, Credential: out.Credential}
	if err := writePrivateJSON(filepath.Join(*state, "host.json"), h); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "registered host %q (%s) with %s; credential saved in %s\n", *name, out.UUID, *origin, filepath.Join(*state, "host.json"))
	return nil
}

func cmdRun(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	state := fs.String("state", "", "absolute private state directory holding host.json")
	configPath := fs.String("config", "", "optional JSON configuration file")
	keepWork := fs.Bool("keep-work", false, "keep each task's working copy for debugging")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("unexpected arguments")
	}
	h, err := loadHostFile(*state)
	if err != nil {
		return err
	}
	c, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if *keepWork {
		c.KeepWork = true
	}
	hst, err := newHost(h, c, *state, stdout)
	if err != nil {
		return err
	}
	return hst.run(ctx)
}

func main() {
	usage := "usage:\n  GOLF_AGENT_REGISTRATION_TOKEN=… golf-agent-host register --origin URL --name NAME --state DIR\n  golf-agent-host run --state DIR [--config FILE] [--keep-work]\n  golf-agent-host ssh-run|ssh-probe < JOB (inside Golf's SSH host container)"
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "register":
		err = cmdRegister(os.Args[2:], os.Stdout)
	case "run":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		err = cmdRun(ctx, os.Args[2:], os.Stdout)
		stop()
	case "ssh-run", "ssh-probe": // SSH hosts (ssh_run.go): one task or connection test; the job arrives on standard input
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		if os.Args[1] == "ssh-run" {
			err = cmdSSHRun(ctx, os.Stdin, os.Stderr)
		} else {
			err = cmdSSHProbe(ctx, os.Stdin, os.Stdout)
		}
		stop()
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "golf-agent-host:", err)
		os.Exit(1)
	}
}

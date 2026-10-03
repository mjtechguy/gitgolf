package codexaccount

// Native account-only adapters. No source, tool, task or arbitrary RPC input is accepted.
import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type nativeCache struct {
	APIKey string                     `json:"apiKey,omitempty"`
	Files  map[string]json.RawMessage `json:"files,omitempty"`
}
type Native struct {
	mu                              sync.Mutex
	binary, harness, provider, home string
	cache                           nativeCache
	login                           *exec.Cmd
	input                           io.WriteCloser
	loginID                         string
	loginDone                       chan struct{}
	done                            chan struct{}
	events                          chan LoginCompleted
	closeOnce                       sync.Once
}

var nativeFiles = []string{".claude/.credentials.json", ".claude/.claude.json", ".claude.json"}

func ValidNativeKey(key string) bool {
	return len(key) >= 20 && len(key) <= 4096 && strings.TrimSpace(key) == key && !strings.ContainsAny(key, "\r\n\x00\t ")
}
func NewNative(binary, harness, provider string, initial []byte) (*Native, error) {
	if !filepath.IsAbs(binary) || !((harness == "claude-code" && provider == "anthropic") || (harness == "opencode" && (provider == "openai" || provider == "anthropic" || provider == "opencode"))) || len(initial) > maxAuth {
		return nil, ErrInvalidCredential
	}
	info, e := os.Stat(binary)
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return nil, ErrUnavailable
	}
	p := &Native{binary: binary, harness: harness, provider: provider, done: make(chan struct{}), events: make(chan LoginCompleted, 4)}
	if len(initial) > 0 {
		if json.Unmarshal(initial, &p.cache) != nil || p.cache.APIKey != "" && !ValidNativeKey(p.cache.APIKey) {
			return nil, ErrInvalidCredential
		}
	}
	p.home, e = os.MkdirTemp("", "golf-agent-account-")
	if e != nil {
		return nil, ErrUnavailable
	}
	os.Chmod(p.home, 0700)
	for name, value := range p.cache.Files {
		allowed := false
		for _, file := range nativeFiles {
			if name == file {
				allowed = true
			}
		}
		if !allowed || !json.Valid(value) {
			p.Close()
			return nil, ErrInvalidCredential
		}
		if e = p.writeFile(name, value); e != nil {
			p.Close()
			return nil, e
		}
	}
	if harness == "opencode" && p.cache.APIKey != "" {
		if e = p.openCodeKey(p.cache.APIKey); e != nil {
			p.Close()
			return nil, e
		}
	}
	return p, nil
}
func (p *Native) writeFile(name string, value []byte) error {
	path := filepath.Join(p.home, name)
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return ErrUnavailable
	}
	if e := os.WriteFile(path, value, 0600); e != nil {
		return ErrUnavailable
	}
	return nil
}
func (p *Native) env() []string {
	env := []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + p.home, "CLAUDE_CONFIG_DIR=" + filepath.Join(p.home, ".claude"), "XDG_DATA_HOME=" + filepath.Join(p.home, ".local/share"), "XDG_CONFIG_HOME=" + filepath.Join(p.home, ".config"), "XDG_CACHE_HOME=" + filepath.Join(p.home, ".cache"), "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_AUTOUPDATER=1", "BROWSER=/bin/false", "TERM=dumb", "NO_COLOR=1", "OPENCODE_DISABLE_MODELS_FETCH=true"}
	if p.harness == "claude-code" && p.cache.APIKey != "" {
		env = append(env, "ANTHROPIC_API_KEY="+p.cache.APIKey)
	}
	return env
}
func (p *Native) command(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, p.binary, args...)
	cmd.Dir = p.home
	cmd.Env = p.env()
	cmd.Stderr = io.Discard
	return cmd
}

type boundedOutput struct{ bytes.Buffer }

func (b *boundedOutput) Write(v []byte) (int, error) {
	if b.Len()+len(v) > maxAuth {
		return 0, ErrUnavailable
	}
	return b.Buffer.Write(v)
}
func (p *Native) output(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := p.command(ctx, args...)
	var out boundedOutput
	cmd.Stdout = &out
	e := cmd.Run()
	if e != nil {
		return nil, ErrAuthentication
	}
	return out.Bytes(), nil
}
func (p *Native) openCodeKey(key string) error {
	data, _ := json.Marshal(map[string]any{p.provider: map[string]string{"type": "api", "key": key}})
	return p.writeFile(".local/share/opencode/auth.json", data)
}
func (p *Native) Account(ctx context.Context, refresh bool) (Account, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	select {
	case <-p.done:
		return Account{}, ErrUnavailable
	default:
	}
	if p.harness == "opencode" {
		if p.cache.APIKey == "" {
			return Account{}, nil
		}
		if _, e := p.output(ctx, "auth", "list"); e != nil {
			return Account{}, e
		}
		return Account{Type: "apiKey"}, nil
	}
	data, e := p.output(ctx, "auth", "status")
	if e != nil {
		return Account{}, e
	}
	var status struct {
		LoggedIn         bool   `json:"loggedIn"`
		AuthMethod       string `json:"authMethod"`
		Email            string `json:"email"`
		SubscriptionType string `json:"subscriptionType"`
	}
	if json.Unmarshal(data, &status) != nil || len(status.Email) > 254 || len(status.SubscriptionType) > 128 {
		return Account{}, ErrUnavailable
	}
	if !status.LoggedIn {
		return Account{}, nil
	}
	if status.AuthMethod == "api_key" {
		return Account{Type: "apiKey"}, nil
	}
	if status.AuthMethod != "claude.ai" {
		return Account{}, ErrAuthentication
	}
	return Account{Type: "claude", Email: status.Email, PlanType: status.SubscriptionType}, nil
}
func (p *Native) StartLogin(ctx context.Context, request LoginRequest) (Login, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if request.Type == "apiKey" {
		if !ValidNativeKey(request.APIKey) {
			return Login{}, ErrInvalidCredential
		}
		p.cache.APIKey = request.APIKey
		if p.harness == "opencode" {
			if e := p.openCodeKey(request.APIKey); e != nil {
				return Login{}, e
			}
		}
		return Login{Type: "apiKey"}, nil
	}
	if p.harness != "claude-code" || request.Type != "browserCode" || p.login != nil {
		return Login{}, ErrInvalidCredential
	}
	cmd := p.command(context.Background(), "auth", "login", "--claudeai")
	out, e := cmd.StdoutPipe()
	if e != nil {
		return Login{}, ErrUnavailable
	}
	input, e := cmd.StdinPipe()
	if e != nil {
		return Login{}, ErrUnavailable
	}
	if e = cmd.Start(); e != nil {
		input.Close()
		out.Close()
		return Login{}, ErrUnavailable
	}
	p.login = cmd
	p.input = input
	p.loginID = uuid.NewString()
	p.loginDone = make(chan struct{})
	finished := p.loginDone
	id := p.loginID
	urls := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 4096), 16384)
		total := 0
		re := regexp.MustCompile(`https://[^\s\x1b]+`)
		for scanner.Scan() {
			total += len(scanner.Bytes())
			if total > maxAuth {
				cmd.Process.Kill()
				break
			}
			for _, raw := range re.FindAllString(scanner.Text(), -1) {
				if strings.HasPrefix(raw, "https://claude.com/cai/oauth/authorize?") || strings.HasPrefix(raw, "https://claude.ai/oauth/authorize?") {
					select {
					case urls <- raw:
					default:
					}
				}
			}
		}
		err := cmd.Wait()
		close(finished)
		select {
		case p.events <- LoginCompleted{LoginID: id, Success: err == nil}:
		case <-p.done:
		}
	}()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case raw := <-urls:
		return Login{Type: "browserCode", LoginID: id, VerificationURL: raw, ExpiresAt: time.Now().Add(15 * time.Minute)}, nil
	case <-ctx.Done():
		cmd.Process.Kill()
		return Login{}, ErrUnavailable
	case <-timer.C:
		cmd.Process.Kill()
		return Login{}, ErrUnavailable
	case <-p.done:
		return Login{}, ErrUnavailable
	}
}
func (p *Native) CompleteLogin(ctx context.Context, id, code string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if id != p.loginID || p.input == nil || len(code) == 0 || len(code) > 4096 || strings.ContainsAny(code, "\r\n\x00") {
		return ErrInvalidCredential
	}
	_, e := io.WriteString(p.input, code+"\n")
	if e != nil {
		return ErrUnavailable
	}
	p.input.Close()
	p.input = nil
	return nil
}
func (p *Native) CancelLogin(ctx context.Context, id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if id != p.loginID {
		return ErrInvalidCredential
	}
	if p.input != nil {
		p.input.Close()
		p.input = nil
	}
	if p.login != nil && p.login.Process != nil {
		p.login.Process.Kill()
		p.login = nil
	}
	p.loginID = ""
	if p.loginDone != nil {
		<-p.loginDone
	}
	return nil
}
func (p *Native) Logout(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.login != nil && p.login.Process != nil {
		p.login.Process.Kill()
		p.login = nil
	}
	if p.input != nil {
		p.input.Close()
		p.input = nil
	}
	p.loginID = ""
	if p.loginDone != nil {
		<-p.loginDone
	}
	p.cache = nativeCache{}
	// Local cache removal only: no provider-side account revocation.
	for _, name := range append(append([]string{}, nativeFiles...), ".local/share/opencode/auth.json") {
		if e := os.Remove(filepath.Join(p.home, name)); e != nil && !os.IsNotExist(e) {
			return ErrUnavailable
		}
	}
	return nil
}
func (p *Native) Snapshot() ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	cache := nativeCache{APIKey: p.cache.APIKey, Files: map[string]json.RawMessage{}}
	if p.harness == "claude-code" {
		for _, name := range nativeFiles {
			path := filepath.Join(p.home, name)
			info, e := os.Lstat(path)
			if os.IsNotExist(e) {
				continue
			}
			if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > maxAuth {
				return nil, ErrUnavailable
			}
			file, e := os.Open(path)
			if e != nil {
				return nil, ErrUnavailable
			}
			data, e := io.ReadAll(io.LimitReader(file, maxAuth+1))
			file.Close()
			if e != nil || len(data) > maxAuth || !json.Valid(data) {
				return nil, ErrUnavailable
			}
			cache.Files[name] = data
		}
	}
	if cache.APIKey == "" && len(cache.Files) == 0 {
		return nil, nil
	}
	data, e := json.Marshal(cache)
	if e != nil || len(data) > maxAuth {
		return nil, ErrUnavailable
	}
	return data, nil
}
func (p *Native) Usage(context.Context) (Usage, error) { return Usage{}, ErrUnavailable }
func (p *Native) Events() <-chan LoginCompleted        { return p.events }
func (p *Native) Close() error {
	p.closeOnce.Do(func() {
		close(p.done)
		p.mu.Lock()
		if p.login != nil && p.login.Process != nil {
			p.login.Process.Kill()
		}
		if p.input != nil {
			p.input.Close()
		}
		finished := p.loginDone
		p.mu.Unlock()
		if finished != nil {
			<-finished
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		os.RemoveAll(p.home)
		p.cache = nativeCache{}
	})
	return nil
}

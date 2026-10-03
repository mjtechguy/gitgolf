// Package codexaccount exposes only the native Codex account protocol, never task RPCs.
package codexaccount

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/mail"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	ErrUnavailable       = errors.New("Codex account service unavailable")
	ErrAuthentication    = errors.New("Codex account needs authentication")
	ErrInvalidCredential = errors.New("Invalid Codex account credential")
)

const maxAuth = 64 << 10
const verificationURL = "https://auth.openai.com/codex/device"

var loginIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var userCodePattern = regexp.MustCompile(`^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$`)
var apiKeyPattern = regexp.MustCompile(`^sk-[A-Za-z0-9_-]{20,500}$`)

type Config struct {
	Binary string
	// Args is a trusted operator/test-only executable prefix, never user input.
	Args    []string
	Timeout time.Duration
}
type Account struct {
	Type, Email, PlanType string
	RequiresOpenAIAuth    bool
}
type LoginRequest struct{ Type, APIKey string }
type Login struct {
	Type, LoginID, VerificationURL, UserCode string
	ExpiresAt                                time.Time
}
type LoginCompleted struct {
	LoginID string
	Success bool
}
type response struct {
	ID     uint64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code int `json:"code"`
	} `json:"error"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type Process struct {
	cmd       *exec.Cmd
	home      string
	stdin     io.WriteCloser
	timeout   time.Duration
	callMu    sync.Mutex
	mu        sync.Mutex
	next      uint64
	pendingID uint64
	pending   chan response
	done      chan struct{}
	events    chan LoginCompleted
	closeOnce sync.Once
}

func validAuth(data []byte) bool {
	if len(data) == 0 {
		return true
	}
	if len(data) > maxAuth {
		return false
	}
	var value map[string]json.RawMessage
	return json.Unmarshal(data, &value) == nil && value != nil
}

func New(ctx context.Context, config Config, initialAuth []byte) (*Process, error) {
	if ctx.Err() != nil || !filepath.IsAbs(config.Binary) || !validAuth(initialAuth) {
		return nil, ErrInvalidCredential
	}
	info, err := os.Stat(config.Binary)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return nil, ErrUnavailable
	}
	timeout := config.Timeout
	if timeout == 0 {
		timeout = 20 * time.Second
	}
	if timeout < time.Second || timeout > 60*time.Second {
		return nil, ErrUnavailable
	}
	home, err := os.MkdirTemp("", "golf-codex-account-")
	if err != nil {
		return nil, ErrUnavailable
	}
	if err = os.Chmod(home, 0700); err != nil {
		os.RemoveAll(home)
		return nil, ErrUnavailable
	}
	if len(initialAuth) > 0 {
		if err = os.WriteFile(filepath.Join(home, "auth.json"), initialAuth, 0600); err != nil {
			os.RemoveAll(home)
			return nil, ErrUnavailable
		}
	}
	args := append(append([]string{}, config.Args...), "-c", `cli_auth_credentials_store="file"`, "app-server", "--listen", "stdio://")
	cmd := exec.Command(config.Binary, args...)
	cmd.Dir = home
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + home, "CODEX_HOME=" + home, "RUST_LOG=off"}
	cmd.Stderr = io.Discard
	input, err := cmd.StdinPipe()
	if err != nil {
		os.RemoveAll(home)
		return nil, ErrUnavailable
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		os.RemoveAll(home)
		return nil, ErrUnavailable
	}
	p := &Process{cmd: cmd, home: home, stdin: input, timeout: timeout, done: make(chan struct{}), events: make(chan LoginCompleted, 16)}
	if err = cmd.Start(); err != nil {
		input.Close()
		output.Close()
		os.RemoveAll(home)
		return nil, ErrUnavailable
	}
	go p.read(output)
	var initialized json.RawMessage
	err = p.request(ctx, "initialize", map[string]any{"clientInfo": map[string]string{"name": "golf_account", "version": "0.1.0"}, "capabilities": map[string]bool{"experimentalApi": false}}, &initialized)
	if err == nil {
		err = p.notify("initialized")
	}
	if err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

func (p *Process) read(output io.ReadCloser) {
	defer output.Close()
	defer close(p.events)
	defer close(p.done)
	defer p.cmd.Wait()
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 4096), maxAuth*4)
	for scanner.Scan() {
		var message response
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			break
		}
		if message.ID != 0 {
			if message.Method != "" {
				break
			} // No server-request/task RPC surface.
			p.mu.Lock()
			pending := p.pending
			matches := p.pendingID == message.ID
			p.mu.Unlock()
			if matches && pending != nil {
				select {
				case pending <- message:
				default:
				}
			}
			continue
		}
		if message.Method == "account/login/completed" {
			var event struct {
				LoginID *string `json:"loginId"`
				Success *bool   `json:"success"`
			}
			if json.Unmarshal(message.Params, &event) != nil || event.Success == nil {
				break
			}
			value := LoginCompleted{Success: *event.Success}
			if event.LoginID != nil {
				if !loginIDPattern.MatchString(*event.LoginID) {
					break
				}
				value.LoginID = *event.LoginID
			}
			select {
			case p.events <- value:
			default:
				p.cmd.Process.Kill()
				return
			}
		}
	}
	// Malformed, oversized or abruptly closed transport cannot remain usable.
	p.cmd.Process.Kill()
}

func (p *Process) request(ctx context.Context, method string, params any, target any) error {
	p.callMu.Lock()
	defer p.callMu.Unlock()
	return p.requestLocked(ctx, method, params, target)
}
func (p *Process) requestLocked(ctx context.Context, method string, params any, target any) error {
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	if ctx.Err() != nil {
		return ErrUnavailable
	}
	select {
	case <-p.done:
		return ErrUnavailable
	default:
	}
	p.mu.Lock()
	p.next++
	id := p.next
	pending := make(chan response, 1)
	p.pendingID = id
	p.pending = pending
	p.mu.Unlock()
	defer func() { p.mu.Lock(); p.pending = nil; p.pendingID = 0; p.mu.Unlock() }()
	data, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil || len(data) > maxAuth {
		return ErrUnavailable
	}
	written := make(chan error, 1)
	go func() { _, err := p.stdin.Write(append(data, '\n')); written <- err }()
	select {
	case err = <-written:
		if err != nil {
			return ErrUnavailable
		}
	case <-ctx.Done():
		p.cmd.Process.Kill()
		return ErrUnavailable
	case <-p.done:
		return ErrUnavailable
	}
	select {
	case reply := <-pending:
		if reply.Error != nil {
			if reply.Error.Code == 401 || reply.Error.Code == 403 {
				return ErrAuthentication
			}
			return ErrUnavailable
		}
		if len(reply.Result) == 0 || json.Unmarshal(reply.Result, target) != nil {
			return ErrUnavailable
		}
		return nil
	case <-ctx.Done():
		p.cmd.Process.Kill()
		return ErrUnavailable
	case <-p.done:
		return ErrUnavailable
	}
}
func (p *Process) notify(method string) error {
	p.callMu.Lock()
	defer p.callMu.Unlock()
	data, _ := json.Marshal(map[string]string{"method": method})
	_, err := p.stdin.Write(append(data, '\n'))
	if err != nil {
		return ErrUnavailable
	}
	return nil
}

func (p *Process) Account(ctx context.Context, refresh bool) (Account, error) {
	var result struct {
		Account *struct {
			Type     string  `json:"type"`
			Email    *string `json:"email"`
			PlanType *string `json:"planType"`
		} `json:"account"`
		Requires *bool `json:"requiresOpenaiAuth"`
	}
	if err := p.request(ctx, "account/read", map[string]bool{"refreshToken": refresh}, &result); err != nil {
		return Account{}, err
	}
	if result.Requires == nil {
		return Account{}, ErrUnavailable
	}
	account := Account{RequiresOpenAIAuth: *result.Requires}
	if result.Account == nil {
		return account, nil
	}
	if result.Account.Type != "apiKey" && result.Account.Type != "chatgpt" {
		return Account{}, ErrUnavailable
	}
	account.Type = result.Account.Type
	if result.Account.Email != nil {
		value := *result.Account.Email
		parsed, err := mail.ParseAddress(value)
		if len(value) > 254 || err != nil || parsed.Address != value || strings.ContainsAny(value, "\r\n") {
			return Account{}, ErrUnavailable
		}
		account.Email = value
	}
	if result.Account.PlanType != nil {
		value := *result.Account.PlanType
		if len(value) > 64 || !regexp.MustCompile(`^[a-zA-Z0-9_-]*$`).MatchString(value) {
			return Account{}, ErrUnavailable
		}
		account.PlanType = value
	}
	return account, nil
}
func (p *Process) StartLogin(ctx context.Context, request LoginRequest) (Login, error) {
	params := map[string]string{"type": request.Type}
	if request.Type == "apiKey" {
		if !apiKeyPattern.MatchString(request.APIKey) {
			return Login{}, ErrInvalidCredential
		}
		params["apiKey"] = request.APIKey
	} else if request.Type != "chatgptDeviceCode" || request.APIKey != "" {
		return Login{}, ErrInvalidCredential
	}
	var result struct {
		Type            string `json:"type"`
		LoginID         string `json:"loginId"`
		VerificationURL string `json:"verificationUrl"`
		UserCode        string `json:"userCode"`
	}
	if err := p.request(ctx, "account/login/start", params, &result); err != nil {
		return Login{}, err
	}
	if result.Type != request.Type {
		return Login{}, ErrUnavailable
	}
	login := Login{Type: result.Type}
	if request.Type == "apiKey" {
		return login, nil
	}
	if !loginIDPattern.MatchString(result.LoginID) || result.VerificationURL != verificationURL || !userCodePattern.MatchString(result.UserCode) {
		return Login{}, ErrUnavailable
	}
	login.LoginID = result.LoginID
	login.VerificationURL = result.VerificationURL
	login.UserCode = result.UserCode
	login.ExpiresAt = time.Now().UTC().Add(15 * time.Minute)
	return login, nil
}
func (p *Process) CancelLogin(ctx context.Context, id string) error {
	if !loginIDPattern.MatchString(id) {
		return ErrInvalidCredential
	}
	var result json.RawMessage
	return p.request(ctx, "account/login/cancel", map[string]string{"loginId": id}, &result)
}
func (p *Process) Logout(ctx context.Context) error {
	var result json.RawMessage
	return p.request(ctx, "account/logout", nil, &result)
}
func (p *Process) Events() <-chan LoginCompleted { return p.events }

func (p *Process) Snapshot() ([]byte, error) {
	p.callMu.Lock()
	defer p.callMu.Unlock()
	path := filepath.Join(p.home, "auth.json")
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if errors.Is(err, syscall.ENOENT) {
		return nil, nil
	}
	if err != nil {
		return nil, ErrUnavailable
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > maxAuth {
		return nil, ErrUnavailable
	}
	if meta, ok := info.Sys().(*syscall.Stat_t); !ok || meta.Uid != uint32(os.Geteuid()) {
		return nil, ErrUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(file, maxAuth+1))
	if err != nil || !validAuth(data) {
		return nil, ErrUnavailable
	}
	return data, nil
}
func (p *Process) Close() error {
	p.closeOnce.Do(func() {
		p.cmd.Process.Kill()
		p.stdin.Close()
		<-p.done
		p.callMu.Lock()
		defer p.callMu.Unlock()
		os.RemoveAll(p.home)
	})
	return nil
}

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// apiError is a non-200 answer from Golf ({ code, message }).
type apiError struct {
	Status  int
	Code    string
	Message string
	// NextOffset is set when a log chunk is refused because its offset is past the
	// stored count (409); the host resyncs to it.
	NextOffset *int64
}

func (e *apiError) Error() string {
	if e.Code == "" && e.Message == "" {
		return fmt.Sprintf("HTTP %d", e.Status)
	}
	return fmt.Sprintf("HTTP %d %s: %s", e.Status, e.Code, e.Message)
}

// isFinal reports an answer that retrying will not change (bad credential, refused,
// conflict, too large).
func isFinal(err error) bool {
	var a *apiError
	return errors.As(err, &a) && a.Status >= 400 && a.Status < 500 && a.Status != http.StatusRequestTimeout && a.Status != http.StatusTooManyRequests
}

func statusOf(err error) int {
	var a *apiError
	if errors.As(err, &a) {
		return a.Status
	}
	return 0
}

type apiClient struct {
	origin     string
	credential string
	http       *http.Client
}

func newAPIClient(origin, credential string) *apiClient {
	return &apiClient{origin: origin, credential: credential, http: &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// post sends a JSON POST to path. bearer overrides the host credential (task routes use
// the task token); an empty bearer with an empty credential sends no Authorization.
func (c *apiClient) post(ctx context.Context, path, bearer string, in, out any) error {
	data, err := json.Marshal(in)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.origin+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	if bearer == "" {
		bearer = c.credential
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "golf-agent-host/"+hostVersion)
	response, err := c.http.Do(request)
	if err != nil {
		return errors.New("Golf unreachable")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if err != nil || len(body) > 1<<20 {
		return errors.New("Golf response too large or unreadable")
	}
	if response.StatusCode != http.StatusOK {
		e := &apiError{Status: response.StatusCode}
		var payload struct {
			Code       string `json:"code"`
			Message    string `json:"message"`
			NextOffset *int64 `json:"nextOffset"`
		}
		if json.Unmarshal(body, &payload) == nil {
			e.Code, e.Message, e.NextOffset = clip(payload.Code, 64), clip(payload.Message, 300), payload.NextOffset
		}
		return e
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return errors.New("Golf response is not the expected JSON")
	}
	return nil
}

func newUUID() string {
	var v [16]byte
	if _, err := rand.Read(v[:]); err != nil {
		panic(err)
	}
	v[6] = v[6]&0x0f | 0x40
	v[8] = v[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", v[:4], v[4:6], v[6:8], v[8:10], v[10:])
}

type toolReport struct {
	Tool     string `json:"tool"`
	Version  string `json:"version"`
	SignedIn *bool  `json:"signedIn"`
	Account  string `json:"account"`
}

type heartbeatResponse struct {
	OK     bool     `json:"ok"`
	Cancel []string `json:"cancel"`
	State  string   `json:"state"`
}

type taskTarget struct {
	Kind   string `json:"kind"`
	Number int64  `json:"number"`
	Title  string `json:"title"`
	URL    string `json:"url"`
}

type taskMCP struct {
	URL string `json:"url"`
}

type claimedTask struct {
	ID         string     `json:"id"`
	Repository string     `json:"repository"`
	CloneURL   string     `json:"cloneUrl"`
	Branch     string     `json:"branch"`
	BaseRef    string     `json:"baseRef"`
	BaseCommit string     `json:"baseCommit"`
	Tool       string     `json:"tool"`
	Model      string     `json:"model"`
	Prompt     string     `json:"prompt"`
	Deadline   int64      `json:"deadline"`
	Token      string     `json:"token"`
	Target     taskTarget `json:"target"`
	// MCP names Golf's remote MCP endpoint for this task's token, or is nil.
	MCP *taskMCP `json:"mcp"`
}

type usageReport struct {
	InputTokens  int64    `json:"inputTokens"`
	OutputTokens int64    `json:"outputTokens"`
	CostUSD      *float64 `json:"costUsd,omitempty"`
}

type finishRequest struct {
	State        string       `json:"state"`
	ExitCode     int          `json:"exitCode"`
	CommitID     string       `json:"commitId"`
	Summary      string       `json:"summary"`
	ChangedFiles []string     `json:"changedFiles"`
	Usage        *usageReport `json:"usage,omitempty"`
	Failure      string       `json:"failure"`
}

var baseRefPattern = regexp.MustCompile(`^refs/heads/[A-Za-z0-9._/-]{1,200}$`)

// tokenUsable reports whether the claimed task carries a token for its own id, so the
// host can at least report a refusal.
func tokenUsable(t claimedTask) bool {
	return uuidPattern.MatchString(t.ID) &&
		regexp.MustCompile(`^golf_agent_task_`+regexp.QuoteMeta(t.ID)+`_[0-9a-f]{64}$`).MatchString(t.Token)
}

// validateTask checks a claimed task against the contract before anything runs.
func validateTask(t claimedTask, origin string, now time.Time) error {
	switch {
	case !tokenUsable(t):
		return errors.New("task id or token malformed")
	case t.CloneURL != origin+"/native/agent-host/tasks/"+t.ID+"/git":
		return errors.New("cloneUrl is not this task's Git route on the registered origin")
	case t.Branch != "golf-agent/"+t.ID[:8]:
		return errors.New("branch is not golf-agent/<first 8 hex of the task id>")
	case !baseRefPattern.MatchString(t.BaseRef) || strings.Contains(t.BaseRef, "..") || strings.Contains(t.BaseRef, "//") ||
		strings.HasSuffix(t.BaseRef, "/") || strings.HasSuffix(t.BaseRef, ".lock"):
		return errors.New("baseRef is not a branch")
	case !shaPattern.MatchString(t.BaseCommit):
		return errors.New("baseCommit is not a 40-hex commit id")
	case toolSpecs[t.Tool] == nil:
		return errors.New("unknown tool")
	case t.Model != "" && !modelPattern.MatchString(t.Model):
		return errors.New("model name malformed")
	case strings.TrimSpace(t.Prompt) == "" || len(t.Prompt) > 64<<10 || strings.ContainsRune(t.Prompt, 0):
		return errors.New("prompt empty or too large")
	case t.Deadline <= now.UnixMilli() || t.Deadline > now.Add(2*time.Hour+10*time.Minute).UnixMilli():
		return errors.New("deadline outside the allowed window")
	case t.Target.Kind != "issue" && t.Target.Kind != "pull_request" || t.Target.Number < 1:
		return errors.New("target malformed")
	case t.MCP != nil && t.MCP.URL != origin+"/mcp":
		// The task token goes only to the registered origin.
		return errors.New("mcp.url is not the registered origin's /mcp endpoint")
	}
	return nil
}

func clip(s string, max int) string {
	s = strings.ToValidUTF8(s, "�")
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !isRuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

// wireID reads an id Golf sends as a decimal string (its usual form, like other ids in the API) or as a JSON number.
type wireID int64

func (v *wireID) UnmarshalJSON(data []byte) error {
	text := strings.Trim(string(data), `"`)
	n, err := strconv.ParseInt(text, 10, 64)
	if err != nil || n < 0 || len(data) > 2 && data[0] == '"' && data[len(data)-1] != '"' {
		return fmt.Errorf("invalid id %s", data)
	}
	*v = wireID(n)
	return nil
}

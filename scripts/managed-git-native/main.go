// Disposable supported-API client. Credentials enter stdin and remain in RAM.
// The only origin is the fresh Compose native service; this is not a proxy.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const nativeOrigin = "http://forgejo:3000"
const inputLimit = 1 << 20
const responseLimit = 2 << 20

var projectPattern = regexp.MustCompile(`^golf-gitread-[a-f0-9]{10}$`)
var objectPattern = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
var errInput = errors.New("fixture_input_refused")

type input struct {
	Project string          `json:"project"`
	Token   string          `json:"token"`
	Method  string          `json:"method"`
	Path    string          `json:"path"`
	Body    json.RawMessage `json:"body,omitempty"`
}
type output struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body,omitempty"`
}

func actor(project, value string) bool {
	for _, role := range []string{"owner", "reader", "outside", "admin"} {
		if value == project+"-"+role {
			return true
		}
	}
	return false
}
func validate(v input) error {
	if !projectPattern.MatchString(v.Project) || len(v.Token) > 8192 || strings.ContainsAny(v.Token, "\r\n\x00") {
		return errInput
	}
	u, e := url.Parse(v.Path)
	if e != nil || u.Scheme != "" || u.Host != "" || u.RawPath != "" || u.Fragment != "" || u.Path != v.Path && u.RawQuery == "" || strings.ContainsAny(v.Path, "%\\\r\n\x00") || strings.Contains(u.Path, "//") {
		return errInput
	}
	if v.Method == http.MethodGet && u.Path == "/api/v1/version" && u.RawQuery == "" && len(v.Body) == 0 {
		return nil
	}
	if v.Token == "" {
		return errInput
	}
	if v.Method == http.MethodGet && u.Path == "/api/v1/user" && u.RawQuery == "" && len(v.Body) == 0 {
		return nil
	}
	if v.Method == http.MethodPost && u.Path == "/api/v1/user/repos" && u.RawQuery == "" {
		var b struct {
			Name     string `json:"name"`
			Private  bool   `json:"private"`
			AutoInit bool   `json:"auto_init"`
		}
		if decode(v.Body, &b) != nil || b.Name != "proof" && b.Name != "other" || !b.Private || !b.AutoInit {
			return errInput
		}
		return nil
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/api/v1/repos/"), "/")
	if !strings.HasPrefix(u.Path, "/api/v1/repos/") || len(parts) < 2 || !actor(v.Project, parts[0]) || parts[1] != "proof" && parts[1] != "other" && parts[1] != "proof-renamed" {
		return errInput
	}
	if len(parts) == 2 && u.RawQuery == "" {
		if (v.Method == http.MethodGet || v.Method == http.MethodDelete) && len(v.Body) == 0 {
			return nil
		}
		if v.Method == http.MethodPatch {
			var b struct {
				Name string `json:"name"`
			}
			if decode(v.Body, &b) == nil && (b.Name == "proof" || b.Name == "proof-renamed") {
				return nil
			}
		}
	}
	if v.Method == http.MethodGet && len(v.Body) == 0 {
		if len(parts) == 4 && parts[2] == "branches" && parts[3] == "main" && u.RawQuery == "" {
			return nil
		}
		if len(parts) == 5 && parts[2] == "git" && parts[3] == "trees" && objectPattern.MatchString(parts[4]) && u.RawQuery == "page=1&per_page=100" {
			return nil
		}
	}
	if len(parts) == 4 && parts[2] == "collaborators" && parts[3] == v.Project+"-reader" && u.RawQuery == "" {
		if v.Method == http.MethodDelete && len(v.Body) == 0 {
			return nil
		}
		if v.Method == http.MethodPut {
			var b struct {
				Permission string `json:"permission"`
			}
			if decode(v.Body, &b) == nil && b.Permission == "read" {
				return nil
			}
		}
	}
	if len(parts) == 4 && parts[2] == "contents" && parts[3] == "proof.txt" && v.Method == http.MethodPost && u.RawQuery == "" {
		var b struct {
			Content string `json:"content"`
			Message string `json:"message"`
		}
		if decode(v.Body, &b) == nil && len(b.Content) > 0 && len(b.Content) <= 2048 && b.Message == "Add owned READ fixture" {
			return nil
		}
	}
	return errInput
}
func decode(raw []byte, value any) error {
	if len(raw) == 0 {
		return errInput
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(value) != nil {
		return errInput
	}
	if d.Decode(new(any)) != io.EOF {
		return errInput
	}
	return nil
}
func execute(v input, client *http.Client) (output, error) {
	if validate(v) != nil {
		return output{}, errInput
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, v.Method, nativeOrigin+v.Path, bytes.NewReader(v.Body))
	if e != nil {
		return output{}, errInput
	}
	req.Header.Set("Accept", "application/json")
	if len(v.Body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	if v.Token != "" {
		req.Header.Set("Authorization", "token "+v.Token)
	}
	// An arbitrary retained-account token can never mutate through user/repos.
	// Independently require a real current project-owned native actor first.
	if v.Path != "/api/v1/version" && v.Path != "/api/v1/user" {
		identity, _ := http.NewRequestWithContext(ctx, http.MethodGet, nativeOrigin+"/api/v1/user", nil)
		identity.Header.Set("Authorization", "token "+v.Token)
		r, e := client.Do(identity)
		if e != nil {
			return output{}, errors.New("fixture_native_unavailable")
		}
		raw, readErr := io.ReadAll(io.LimitReader(r.Body, responseLimit+1))
		r.Body.Close()
		if readErr != nil || r.StatusCode != 200 || len(raw) > responseLimit || !ownedIdentity(v.Project, raw) {
			return output{}, errors.New("fixture_actor_refused")
		}
	}
	response, e := client.Do(req)
	if e != nil {
		return output{}, errors.New("fixture_native_unavailable")
	}
	defer response.Body.Close()
	out := output{Status: response.StatusCode}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return out, nil
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if e != nil || len(raw) > responseLimit {
		return output{}, errors.New("fixture_native_bound")
	}
	if len(raw) > 0 {
		if !json.Valid(raw) {
			return output{}, errors.New("fixture_native_shape")
		}
		if v.Path == "/api/v1/user" && !ownedIdentity(v.Project, raw) {
			return output{}, errors.New("fixture_actor_refused")
		}
		out.Body = raw
	}
	return out, nil
}
func ownedIdentity(project string, raw []byte) bool {
	var user struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
	}
	return json.Unmarshal(raw, &user) == nil && user.ID > 0 && actor(project, user.Login)
}
func main() {
	raw, e := io.ReadAll(io.LimitReader(os.Stdin, inputLimit+1))
	var v input
	if e != nil || len(raw) > inputLimit || decode(raw, &v) != nil || validate(v) != nil {
		os.Stderr.WriteString("fixture_input_refused\n")
		os.Exit(1)
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	out, e := execute(v, client)
	if e != nil {
		os.Stderr.WriteString("fixture_native_failed\n")
		os.Exit(1)
	}
	if json.NewEncoder(os.Stdout).Encode(out) != nil {
		os.Exit(1)
	}
}

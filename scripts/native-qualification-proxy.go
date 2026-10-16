// This fixture-only adapter runs INSIDE one disposable Compose network. Build
// with CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o OWNED_PATH THIS_FILE.
// Bind mount that binary read-only in a cached qualified core image; no build,
// pull, native patch, retained stack, or production proxy is authorized here.
// Forward :8081 only internally; publish control :8082 ONLY on 127.0.0.1.
// Environment: NATIVE_QUALIFICATION_PROJECT=golf-(rules49|access48)-10hex,
// NATIVE_QUALIFICATION_NONCE=64hex (RAM/environment only; never an artifact).
// Native destination is fixed. Writes are issued once: no redirects/retries.
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const nativeDestination = "http://forgejo:3000"
const nonceHeader = "X-Native-Qualification-Nonce"
const maxRequest = 1 << 20
const maxResponse = 2 << 20
const maxCounters = 256

var projectPattern = regexp.MustCompile(`^golf-(?:rules49|access48)-[a-f0-9]{10}$`)
var noncePattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type counter struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Count  uint64 `json:"count"` // dispatch attempts, not inferred native effects
}
type observation struct {
	Method          string                `json:"method"`
	Category        string                `json:"category"`
	Status          int                   `json:"status,omitempty"`
	Bytes           int                   `json:"bytes,omitempty"`
	ElapsedMS       int64                 `json:"elapsedMs"`
	Failure         string                `json:"failure,omitempty"`         // closed category, no error text
	CallerCancelled bool                  `json:"callerCancelled,omitempty"` // verified incoming GET cancellation only
	TagReceipt      *tagReceiptComparison `json:"tagReceipt,omitempty"`      // bounded counts/equality only
}
type tagReceiptComparison struct {
	RequestedUsers int  `json:"requestedUsers"`
	ReceivedUsers  int  `json:"receivedUsers"`
	RequestedTeams int  `json:"requestedTeams"`
	ReceivedTeams  int  `json:"receivedTeams"`
	PatternEqual   bool `json:"patternEqual"`
	UsersEqual     bool `json:"usersEqual"`
	TeamsEqual     bool `json:"teamsEqual"`
}

func compareTagReceipt(payload, body []byte) *tagReceiptComparison {
	type row struct {
		Pattern string   `json:"name_pattern"`
		Users   []string `json:"whitelist_usernames"`
		Teams   []string `json:"whitelist_teams"`
	}
	var desired, actual row
	if json.Unmarshal(payload, &desired) != nil || json.Unmarshal(body, &actual) != nil || desired.Pattern == "" || actual.Pattern == "" || len(desired.Users) > 100 || len(actual.Users) > 100 || len(desired.Teams) > 100 || len(actual.Teams) > 100 {
		return nil
	}
	for _, list := range [][]string{desired.Users, actual.Users, desired.Teams, actual.Teams} {
		slices.Sort(list)
	}
	return &tagReceiptComparison{len(desired.Users), len(actual.Users), len(desired.Teams), len(actual.Teams), desired.Pattern == actual.Pattern, slices.Equal(desired.Users, actual.Users), slices.Equal(desired.Teams, actual.Teams)}
}

type fault struct {
	Method   string `json:"method"`
	Path     string `json:"path"`
	Status   int    `json:"status"`
	RuleName string `json:"ruleName,omitempty"`
}
type snapshot struct {
	Project             string        `json:"project"`
	NativeDestination   string        `json:"nativeDestination"`
	Counts              []counter     `json:"counts"`
	Observations        []observation `json:"observations"`
	ForwardRequestCount uint64        `json:"forwardRequestCount"`
	Lost                uint64        `json:"lost"`
	Failures            uint64        `json:"failures"`
	CallerCancelled     uint64        `json:"callerCancelled"`
	RejectedWrites      uint64        `json:"rejectedWrites"` // refused before dispatch; no path, method, headers or body retained
	Armed               *fault        `json:"armed"`
}
type adapter struct {
	project, nonce string
	client         *http.Client
	mu             sync.Mutex
	state          snapshot
	stop           chan struct{}
	stopOnce       sync.Once
	armHistory     [2]fault // private, bounded reservation history; never serialized
	armCount       int
}

func newAdapter(project, nonce string) (*adapter, error) {
	if !projectPattern.MatchString(project) || !noncePattern.MatchString(nonce) {
		return nil, errors.New("invalid owned fixture configuration")
	}
	transport := &http.Transport{
		Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		DisableKeepAlives: true, DisableCompression: true, MaxConnsPerHost: 32,
		ResponseHeaderTimeout: 8 * time.Second,
	}
	return &adapter{project: project, nonce: nonce, client: &http.Client{Transport: transport, Timeout: 9 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, stop: make(chan struct{}), state: snapshot{Project: project, NativeDestination: nativeDestination, Counts: []counter{}, Observations: []observation{}}}, nil
}
func (a *adapter) ownedBase() string {
	return `/api/v1/repos/` + regexp.QuoteMeta(a.project) + `-(?:owner|org)/[A-Za-z0-9_-]+`
}
func (a *adapter) allowedWrite(method, path string) bool {
	decoded, err := url.PathUnescape(path)
	if err != nil || !utf8.ValidString(decoded) || strings.Contains(decoded, "\\") {
		return false
	}
	for _, segment := range strings.Split(decoded, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	for _, c := range decoded {
		if c < 32 || c == 127 {
			return false
		}
	}
	base := a.ownedBase()
	if method == http.MethodPatch && regexp.MustCompile(`^`+base+`$`).MatchString(path) {
		return true
	}
	if (method == http.MethodPost || method == http.MethodPatch || method == http.MethodDelete) && regexp.MustCompile(`^`+base+`/(?:branch_protections|tag_protections)(?:/[^/?]+)?$`).MatchString(path) {
		return true
	}
	return (method == http.MethodPut || method == http.MethodDelete) && regexp.MustCompile(`^`+base+`/collaborators/`+regexp.QuoteMeta(a.project)+`-(?:recipient|directadmin|outsider|golfadmin|teamadmin)$`).MatchString(path)
}
func (a *adapter) validFault(f fault) bool {
	if !a.allowedWrite(f.Method, f.Path) || strings.Contains(f.Path, "?") {
		return false
	}
	if strings.HasPrefix(a.project, "golf-access48-") {
		return f.Method == http.MethodPut && f.Status == http.StatusNoContent && f.RuleName == "" && strings.Contains(f.Path, "/collaborators/")
	}
	if f.Method == http.MethodPost && f.Status == http.StatusCreated && f.RuleName == "unknown/*" && strings.HasSuffix(f.Path, "/branch_protections") {
		return true
	}
	return f.Method == http.MethodPut && f.Status == http.StatusNoContent && f.RuleName == "" && strings.Contains(f.Path, "/collaborators/")
}
func category(path string) string {
	if strings.Contains(path, "/branch_protections") {
		return "branch_protections"
	}
	if strings.Contains(path, "/tag_protections") {
		return "tag_protections"
	}
	if strings.Contains(path, "/collaborators/") {
		return "collaborator"
	}
	if regexp.MustCompile(`^/api/v1/repos/[^/]+/[^/?]+$`).MatchString(path) {
		return "repository"
	}
	return "authority"
}
func copyHeaders(dst, src http.Header) {
	// RFC hop-by-hop headers include names nominated by Connection.
	blocked := map[string]bool{"connection": true, "proxy-connection": true, "keep-alive": true, "proxy-authenticate": true, "proxy-authorization": true, "te": true, "trailer": true, "transfer-encoding": true, "upgrade": true, "content-length": true, strings.ToLower(nonceHeader): true}
	for _, value := range src.Values("Connection") {
		for _, field := range strings.Split(value, ",") {
			blocked[strings.ToLower(strings.TrimSpace(field))] = true
		}
	}
	for key, values := range src {
		if !blocked[strings.ToLower(key)] {
			dst[key] = append([]string(nil), values...)
		}
	}
}
func (a *adapter) begin(method, path string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if method != http.MethodGet {
		index := -1
		for i, c := range a.state.Counts {
			if c.Method == method && c.Path == path {
				index = i
				break
			}
		}
		if index < 0 {
			if len(a.state.Counts) >= maxCounters {
				return false
			}
			a.state.Counts = append(a.state.Counts, counter{Method: method, Path: path})
			index = len(a.state.Counts) - 1
		}
		a.state.Counts[index].Count++
	}
	a.state.ForwardRequestCount++
	return true
}
func (a *adapter) observed(o observation) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if o.CallerCancelled {
		a.state.CallerCancelled++
	} else if o.Failure != "" {
		a.state.Failures++
	}
	a.state.Observations = append(a.state.Observations, o)
	if len(a.state.Observations) > 64 {
		a.state.Observations = append([]observation(nil), a.state.Observations[len(a.state.Observations)-64:]...)
	}
}
func (a *adapter) shouldDrop(method, path string, status int, body []byte, contentEncoding ...string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := a.state.Armed
	if f == nil || f.Method != method || f.Path != path {
		return false
	}
	valid := status == f.Status
	if f.Status == http.StatusNoContent {
		valid = valid && len(body) == 0
	} else {
		if len(contentEncoding) > 0 && contentEncoding[0] != "" {
			if contentEncoding[0] != "gzip" {
				valid = false
			} else {
				reader, err := gzip.NewReader(bytes.NewReader(body))
				if err != nil {
					valid = false
				} else {
					decoded, err := io.ReadAll(io.LimitReader(reader, maxResponse+1))
					_ = reader.Close()
					if err != nil || len(decoded) > maxResponse {
						valid = false
					} else {
						body = decoded
					}
				}
			}
		}
		var value struct {
			RuleName string `json:"rule_name"`
		}
		valid = valid && json.Unmarshal(body, &value) == nil && value.RuleName == f.RuleName
	}
	if !valid {
		a.state.Failures++
		return false
	}
	a.state.Armed = nil
	a.state.Lost++
	return true
}
func classify(err error) string {
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var netError net.Error
	if errors.As(err, &netError) && netError.Timeout() {
		return "timeout"
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "disconnected"
	}
	return "transport"
}
func callerReadCancelled(r *http.Request, err error) bool {
	// A provider cancellation, timeout or disconnect alone is not a caller abort.
	// Never discount cancellation of any possibly dispatched native write.
	return r.Method == http.MethodGet && errors.Is(r.Context().Err(), context.Canceled) && errors.Is(err, context.Canceled)
}
func (a *adapter) rejectWrite(method string) {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		a.mu.Lock()
		defer a.mu.Unlock()
		// Saturation prevents wrapping to zero. Qualification requires zero, so
		// saturation cannot hide another refused attempt in a passing fixture.
		if a.state.RejectedWrites < (1<<53)-1 {
			a.state.RejectedWrites++
		}
	}
}

func (a *adapter) forward(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	path := r.URL.RequestURI()
	if r.URL.IsAbs() || r.URL.Host != "" || !strings.HasPrefix(path, "/api/v1/") || len(path) > 4096 || len(r.TransferEncoding) != 0 || r.ContentLength > maxRequest || r.Method != http.MethodGet && !a.allowedWrite(r.Method, path) {
		a.rejectWrite(r.Method)
		http.Error(w, "Owned qualification route refused", http.StatusForbidden)
		return
	}
	payload, err := io.ReadAll(io.LimitReader(r.Body, maxRequest+1))
	if err != nil || len(payload) > maxRequest || r.Method == http.MethodGet && len(payload) != 0 {
		a.rejectWrite(r.Method)
		http.Error(w, "Owned qualification request refused", http.StatusBadRequest)
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), r.Method, nativeDestination+path, bytes.NewReader(payload))
	if err != nil {
		a.rejectWrite(r.Method)
		http.Error(w, "Owned qualification request refused", http.StatusBadRequest)
		return
	}
	copyHeaders(request.Header, r.Header)
	request.GetBody = nil // never make a mutation replayable
	request.Close = true
	if !a.begin(r.Method, path) {
		a.rejectWrite(r.Method)
		http.Error(w, "Owned qualification counter bound reached", http.StatusServiceUnavailable)
		return
	}
	response, err := a.client.Do(request)
	if err != nil {
		a.observed(observation{Method: r.Method, Category: category(path), ElapsedMS: time.Since(started).Milliseconds(), Failure: "preheaders_" + classify(err), CallerCancelled: callerReadCancelled(r, err)})
		http.Error(w, "Owned qualification native transport unavailable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil || len(body) > maxResponse {
		kind := "response_bound"
		if err != nil {
			kind = "response_" + classify(err)
		}
		a.observed(observation{Method: r.Method, Category: category(path), Status: response.StatusCode, ElapsedMS: time.Since(started).Milliseconds(), Failure: kind, CallerCancelled: callerReadCancelled(r, err)})
		http.Error(w, "Owned qualification native response unavailable", http.StatusBadGateway)
		return
	}
	o := observation{Method: r.Method, Category: category(path), Status: response.StatusCode, Bytes: len(body), ElapsedMS: time.Since(started).Milliseconds()}
	if r.Method == http.MethodPatch && o.Category == "tag_protections" && response.StatusCode == http.StatusOK && response.Header.Get("Content-Encoding") == "" {
		o.TagReceipt = compareTagReceipt(payload, body)
	}
	a.observed(o)
	if a.shouldDrop(r.Method, path, response.StatusCode, body, response.Header.Get("Content-Encoding")) {
		conn, _, err := http.NewResponseController(w).Hijack()
		if err != nil {
			a.observed(observation{Method: r.Method, Category: category(path), Failure: "drop_hijack"})
			http.Error(w, "Owned qualification drop unavailable", http.StatusBadGateway)
			return
		}
		_ = conn.Close() // the native response was verified; send no acknowledgement
		return
	}
	copyHeaders(w.Header(), response.Header)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(response.StatusCode)
	if _, err := w.Write(body); err != nil {
		a.observed(observation{Method: r.Method, Category: category(path), Failure: "downstream_" + classify(err)})
	}
}
func (a *adapter) control(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	provided := r.Header.Get(nonceHeader)
	if len(provided) != len(a.nonce) || subtle.ConstantTimeCompare([]byte(provided), []byte(a.nonce)) != 1 {
		http.Error(w, "Control unavailable", http.StatusUnauthorized)
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/health" {
		writeJSON(w, map[string]string{"state": "ready", "project": a.project, "nativeDestination": nativeDestination})
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/state" {
		a.mu.Lock()
		value := a.state
		value.Counts = append([]counter{}, a.state.Counts...)
		value.Observations = append([]observation{}, a.state.Observations...)
		if value.Armed != nil {
			f := *value.Armed
			value.Armed = &f
		}
		a.mu.Unlock()
		writeJSON(w, value)
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/arm" {
		var f fault
		decoder := json.NewDecoder(io.LimitReader(r.Body, 8193))
		decoder.DisallowUnknownFields()
		if r.ContentLength > 8192 || decoder.Decode(&f) != nil || decoder.Decode(new(any)) != io.EOF || !a.validFault(f) {
			http.Error(w, "Fault arm refused", http.StatusBadRequest)
			return
		}
		a.mu.Lock()
		limit := 1
		if strings.HasPrefix(a.project, "golf-access48-") {
			limit = 2
		}
		repeated := false
		for _, previous := range a.armHistory[:a.armCount] {
			if previous.Method == f.Method && previous.Path == f.Path {
				repeated = true
			}
		}
		if a.state.Armed != nil || a.armCount >= limit || repeated {
			a.mu.Unlock()
			http.Error(w, "Fault already reserved", http.StatusConflict)
			return
		}
		a.armHistory[a.armCount] = f
		a.armCount++
		a.state.Armed = &f
		a.mu.Unlock()
		writeJSON(w, map[string]string{"state": "armed"})
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/stop" {
		writeJSON(w, map[string]string{"state": "stopping"})
		a.stopOnce.Do(func() { close(a.stop) })
		return
	}
	http.Error(w, "Control route unavailable", http.StatusNotFound)
}
func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
func selfCheckFaultControl() {
	controlArm := func(a *adapter, f fault, status int) {
		payload, _ := json.Marshal(f)
		request := httptest.NewRequest(http.MethodPost, "/arm", bytes.NewReader(payload))
		request.Header.Set(nonceHeader, a.nonce)
		response := httptest.NewRecorder()
		a.control(response, request)
		if response.Code != status || response.Header().Get("Cache-Control") != "no-store" {
			panic("source control arm status/metadata fence")
		}
		if status == http.StatusOK && strings.TrimSpace(response.Body.String()) != `{"state":"armed"}` {
			panic("source control arm receipt")
		}
	}
	a, _ := newAdapter("golf-access48-0123456789", strings.Repeat("f", 64))
	first := fault{Method: http.MethodPut, Path: "/api/v1/repos/" + a.project + "-owner/direct-unknown/collaborators/" + a.project + "-recipient", Status: http.StatusNoContent}
	second := first
	second.Path = strings.Replace(first.Path, "/direct-unknown/", "/invitation-unknown/", 1)
	third := first
	third.Path = strings.Replace(first.Path, "/direct-unknown/", "/third-unknown/", 1)
	concurrent, _ := newAdapter(a.project, strings.Repeat("c", 64))
	statuses := make(chan int, 2)
	for _, candidate := range []fault{first, second} {
		go func(f fault) {
			payload, _ := json.Marshal(f)
			request := httptest.NewRequest(http.MethodPost, "/arm", bytes.NewReader(payload))
			request.Header.Set(nonceHeader, concurrent.nonce)
			response := httptest.NewRecorder()
			concurrent.control(response, request)
			statuses <- response.Code
		}(candidate)
	}
	results := []int{<-statuses, <-statuses}
	slices.Sort(results)
	if !slices.Equal(results, []int{http.StatusOK, http.StatusConflict}) || concurrent.armCount != 1 || concurrent.state.Armed == nil {
		panic("source simultaneous control arms were not serialized")
	}
	controlArm(a, first, http.StatusOK)
	controlArm(a, second, http.StatusConflict) // an active arm cannot be replaced
	if a.armCount != 1 || *a.state.Armed != first {
		panic("source concurrent arm changed original reservation")
	}
	if !a.shouldDrop(first.Method, first.Path, first.Status, nil) || a.state.Lost != 1 {
		panic("source first control-arm drop")
	}
	controlArm(a, first, http.StatusConflict) // a consumed exact target cannot rearm
	controlArm(a, second, http.StatusOK)
	if !a.shouldDrop(second.Method, second.Path, second.Status, nil) || a.state.Lost != 2 || a.armCount != 2 {
		panic("source second distinct control-arm drop")
	}
	controlArm(a, second, http.StatusConflict)
	controlArm(a, third, http.StatusConflict)
	accessRule := fault{Method: http.MethodPost, Path: "/api/v1/repos/" + a.project + "-owner/rules/branch_protections", Status: http.StatusCreated, RuleName: "unknown/*"}
	controlArm(a, accessRule, http.StatusBadRequest)
	freshAccess, _ := newAdapter(a.project, strings.Repeat("a", 64))
	controlArm(freshAccess, accessRule, http.StatusBadRequest) // no rule fault via Access, even first
	if freshAccess.armCount != 0 {
		panic("source invalid profile consumed an arm")
	}
	rules, _ := newAdapter("golf-rules49-0123456789", strings.Repeat("b", 64))
	rule := fault{Method: http.MethodPost, Path: "/api/v1/repos/" + rules.project + "-owner/rules/branch_protections", Status: http.StatusCreated, RuleName: "unknown/*"}
	controlArm(rules, rule, http.StatusOK)
	otherRule := rule
	otherRule.Path = strings.Replace(rule.Path, "/rules/", "/other-rules/", 1)
	controlArm(rules, otherRule, http.StatusConflict)
	if !rules.shouldDrop(rule.Method, rule.Path, rule.Status, []byte(`{"rule_name":"unknown/*"}`)) {
		panic("source Rules control-arm drop")
	}
	controlArm(rules, rule, http.StatusConflict)
	controlArm(rules, otherRule, http.StatusConflict)
	if rules.armCount != 1 || rules.state.Lost != 1 {
		panic("source Rules total arm ceiling")
	}
	request := httptest.NewRequest(http.MethodGet, "/state", nil)
	request.Header.Set(nonceHeader, a.nonce)
	response := httptest.NewRecorder()
	a.control(response, request)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), first.Path) || strings.Contains(response.Body.String(), second.Path) || strings.Contains(response.Body.String(), "armHistory") || strings.Contains(response.Body.String(), a.nonce) {
		panic("source private consumed-arm history exposed")
	}
}

func selfCheck() {
	selfCheckFaultControl()
	refused, _ := newAdapter("golf-access48-0123456789", strings.Repeat("e", 64))
	ownerPath := "/api/v1/repos/golf-access48-0123456789-org/owned/collaborators/golf-access48-0123456789-owner"
	for _, method := range []string{http.MethodPut, http.MethodDelete, http.MethodPost, http.MethodPatch} {
		request := httptest.NewRequest(method, ownerPath, strings.NewReader("private-fixture-body"))
		request.Header.Set("Authorization", "token private-fixture-token")
		response := httptest.NewRecorder()
		refused.forward(response, request)
		if response.Code != http.StatusForbidden {
			panic("source protected owner route was not refused")
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/not-native", nil)
	response := httptest.NewRecorder()
	refused.forward(response, request)
	if response.Code != http.StatusForbidden || refused.state.RejectedWrites != 4 || refused.state.ForwardRequestCount != 0 || len(refused.state.Counts) != 0 || len(refused.state.Observations) != 0 || refused.state.Failures != 0 {
		panic("source refused writes must remain distinct from reads and native dispatch")
	}
	oversized := httptest.NewRequest(http.MethodPut, strings.Replace(ownerPath, "-owner", "-recipient", 1), strings.NewReader(strings.Repeat("x", maxRequest+1)))
	oversized.ContentLength = -1
	response = httptest.NewRecorder()
	refused.forward(response, oversized)
	if response.Code != http.StatusBadRequest || refused.state.RejectedWrites != 5 || refused.state.ForwardRequestCount != 0 {
		panic("source pre-dispatch payload refusal count")
	}
	var rejectionChecks sync.WaitGroup
	for range 32 {
		rejectionChecks.Add(1)
		go func() { defer rejectionChecks.Done(); refused.rejectWrite(http.MethodPut) }()
	}
	rejectionChecks.Wait()
	if refused.state.RejectedWrites != 37 {
		panic("source concurrent aggregate refusal count")
	}
	refusedJSON, _ := json.Marshal(refused.state)
	if bytes.Contains(refusedJSON, []byte(ownerPath)) || bytes.Contains(refusedJSON, []byte("private-fixture")) || bytes.Contains(refusedJSON, []byte(refused.nonce)) {
		panic("source refused request metadata leak")
	}
	refused.state.RejectedWrites = (1 << 53) - 1
	refused.rejectWrite(http.MethodDelete)
	if refused.state.RejectedWrites != (1<<53)-1 {
		panic("source refusal counter wrapped")
	}
	comparison := compareTagReceipt([]byte(`{"name_pattern":"v*","whitelist_usernames":["private-b","private-a"],"whitelist_teams":[]}`), []byte(`{"name_pattern":"v*","whitelist_usernames":["private-a","private-b"],"whitelist_teams":[]}`))
	diagnosticJSON, _ := json.Marshal(comparison)
	if comparison == nil || !comparison.UsersEqual || comparison.RequestedUsers != 2 || strings.Contains(string(diagnosticJSON), "private") {
		panic("closed tag receipt diagnostic")
	}
	if compareTagReceipt([]byte(`{"name_pattern":"v*"}`), []byte(`{"name_pattern":"v*","whitelist_usernames":true}`)) != nil {
		panic("malformed tag diagnostic")
	}
	a, err := newAdapter("golf-rules49-0123456789", strings.Repeat("a", 64))
	if err != nil {
		panic("source configuration check")
	}
	path := "/api/v1/repos/golf-rules49-0123456789-owner/rules/branch_protections"
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	deadline, end := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer end()
	ca, _ := newAdapter("golf-rules49-0123456789", strings.Repeat("d", 64))
	for _, tc := range []struct {
		method string
		ctx    context.Context
		err    error
		want   bool
	}{
		{http.MethodGet, cancelled, fmt.Errorf("wrapped: %w", context.Canceled), true},
		{http.MethodGet, context.Background(), context.Canceled, false},
		{http.MethodGet, deadline, context.Canceled, false},
		{http.MethodGet, cancelled, context.DeadlineExceeded, false},
		{http.MethodGet, cancelled, io.EOF, false},
		{http.MethodPut, cancelled, context.Canceled, false},
	} {
		r, _ := http.NewRequestWithContext(tc.ctx, tc.method, nativeDestination+path, nil)
		got := callerReadCancelled(r, tc.err)
		if got != tc.want {
			panic("source caller cancellation fence")
		}
		ca.begin(tc.method, path)
		ca.observed(observation{Method: tc.method, Category: "authority", Failure: "preheaders_cancelled", CallerCancelled: got})
	}
	if ca.state.CallerCancelled != 1 || ca.state.Failures != 5 || ca.state.ForwardRequestCount != 6 {
		panic("source separate caller/provider cancellation counts")
	}
	if !a.allowedWrite("POST", path) || a.allowedWrite("POST", path+"?x=1") || a.allowedWrite("DELETE", "/api/v1/repos/foreign/rules") || a.allowedWrite("PUT", path) || a.allowedWrite("PATCH", path+"/%2E%2E%2F%2E%2E") || a.allowedWrite("PATCH", path+"/%ZZ") {
		panic("source ownership check")
	}
	if !a.allowedWrite("PATCH", path+"/release%2F%2A") || !a.validFault(fault{Method: "POST", Path: path, Status: 201, RuleName: "unknown/*"}) {
		panic("source exact route check")
	}
	a.state.Armed = &fault{Method: "POST", Path: path, Status: 201, RuleName: "unknown/*"}
	if a.shouldDrop("GET", path, 201, []byte(`{"rule_name":"unknown/*"}`)) || a.shouldDrop("POST", path, 200, []byte(`{"rule_name":"unknown/*"}`)) || a.state.Lost != 0 || !a.shouldDrop("POST", path, 201, []byte(`{"rule_name":"unknown/*"}`)) || a.state.Lost != 1 || a.shouldDrop("POST", path, 201, []byte(`{"rule_name":"unknown/*"}`)) {
		panic("source once-only fault check")
	}
	gz, _ := newAdapter("golf-rules49-0123456789", strings.Repeat("c", 64))
	gz.state.Armed = &fault{Method: "POST", Path: path, Status: 201, RuleName: "unknown/*"}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = writer.Write([]byte(`{"rule_name":"unknown/*"}`))
	_ = writer.Close()
	if !gz.shouldDrop("POST", path, 201, compressed.Bytes(), "gzip") || gz.state.Lost != 1 {
		panic("source encoded native acknowledgement check")
	}
	b, _ := newAdapter("golf-access48-0123456789", strings.Repeat("b", 64))
	collaborator := "/api/v1/repos/golf-access48-0123456789-org/rules/collaborators/golf-access48-0123456789-recipient"
	if !b.validFault(fault{Method: "PUT", Path: collaborator, Status: 204}) || b.validFault(fault{Method: "DELETE", Path: collaborator, Status: 204}) {
		panic("source collaborator arm check")
	}
	b.state.Armed = &fault{Method: "PUT", Path: collaborator, Status: 204}
	if b.shouldDrop("PUT", collaborator, 204, []byte(`{}`)) || !b.shouldDrop("PUT", collaborator, 204, nil) {
		panic("source empty native ack check")
	}
	header := http.Header{"Authorization": {"token fixture-value"}, "Connection": {"X-Fixture-Hop"}, "X-Fixture-Hop": {"removed"}, nonceHeader: {strings.Repeat("a", 64)}}
	copied := http.Header{}
	copyHeaders(copied, header)
	if copied.Get("Authorization") != "token fixture-value" || copied.Get("X-Fixture-Hop") != "" || copied.Get(nonceHeader) != "" {
		panic("source header boundary check")
	}
	for i := range maxCounters {
		if !a.begin("POST", path+"/"+strconv.Itoa(i)) {
			panic("source counter admission")
		}
	}
	if a.begin("POST", path+"/overflow") || len(a.state.Counts) != maxCounters {
		panic("source counter bound")
	}
	for range 65 {
		a.observed(observation{Method: "GET", Category: "authority"})
	}
	if len(a.state.Observations) != 64 {
		panic("source observation bound")
	}
	encoded, _ := json.Marshal(a.state)
	if bytes.Contains(encoded, []byte(a.nonce)) || bytes.Contains(encoded, []byte("fixture-value")) {
		panic("source safe snapshot check")
	}
	fmt.Println("PASS: pure owned-route/refused-write/once-only-fault/header/bounds checks; no native calls or listeners")
}
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--self-check" {
		selfCheck()
		return
	}
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "Qualification adapter arguments refused")
		os.Exit(2)
	}
	a, err := newAdapter(os.Getenv("NATIVE_QUALIFICATION_PROJECT"), os.Getenv("NATIVE_QUALIFICATION_NONCE"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "Qualification adapter configuration refused")
		os.Exit(2)
	}
	silent := log.New(io.Discard, "", 0)
	forward := &http.Server{Addr: ":8081", Handler: http.HandlerFunc(a.forward), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 12 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 32 << 10, ErrorLog: silent}
	control := &http.Server{Addr: ":8082", Handler: http.HandlerFunc(a.control), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 8 << 10, ErrorLog: silent}
	failed := make(chan struct{}, 2)
	for _, server := range []*http.Server{forward, control} {
		go func(s *http.Server) {
			if err := s.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				failed <- struct{}{}
			}
		}(server)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	select {
	case <-a.stop:
	case <-signals:
	case <-failed:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = forward.Shutdown(ctx)
	_ = control.Shutdown(ctx)
}

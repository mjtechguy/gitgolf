package server

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

const workflowActionsFixture = "name: Check\non: workflow_dispatch\njobs:\n  test:\n    runs-on: linux\n    steps:\n      - name: Inspect only\n        run: echo untrusted-script\n        shell: sh\n"

func TestWorkflowInspectionGrammar(t *testing.T) {
	valid := golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET
	unsupported := golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_UNSUPPORTED
	invalid := golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_INVALID
	gitlab := "stages: [test]\ncheck:\n  stage: test\n  image: alpine@sha256:" + strings.Repeat("a", 64) + "\n  script: [echo checked]\n"
	for _, tc := range []struct {
		name, body string
		gitlab     bool
		state      golfv1.WorkflowInspectionState
		code       string
	}{
		{"actions", workflowActionsFixture, false, valid, ""},
		{"dispatch mapping", strings.Replace(workflowActionsFixture, "on: workflow_dispatch", "on:\n  workflow_dispatch: {}", 1), false, valid, ""},
		{"push scalar", strings.Replace(workflowActionsFixture, "on: workflow_dispatch", "on: push", 1), false, valid, ""},
		{"push mapping", strings.Replace(workflowActionsFixture, "on: workflow_dispatch", "on:\n  push:\n    branches: [main, topic/one]\n  workflow_dispatch:", 1), false, valid, ""},
		{"push branches shape", strings.Replace(workflowActionsFixture, "on: workflow_dispatch", "on:\n  push:\n    branches: main", 1), false, unsupported, "push_branches"},
		{"push pattern", strings.Replace(workflowActionsFixture, "on: workflow_dispatch", "on:\n  push:\n    branches: ['topic/**']", 1), false, unsupported, "push_branch_literal"},
		{"push paths", strings.Replace(workflowActionsFixture, "on: workflow_dispatch", "on:\n  push:\n    branches: [main]\n    paths: [src]", 1), false, unsupported, "unsupported_key"},
		{"gitlab", gitlab, true, valid, ""},
		{"dependency", strings.Replace(workflowActionsFixture, "run: echo untrusted-script", "uses: remote/action@main", 1), false, unsupported, "action_dependency"},
		{"expression", strings.Replace(workflowActionsFixture, "runs-on: linux", "runs-on: ${{ secrets.private }}", 1), false, unsupported, "expression"},
		{"event", strings.Replace(workflowActionsFixture, "on: workflow_dispatch", "on: pull_request_target", 1), false, unsupported, "event"},
		{"unknown", workflowActionsFixture + "permissions: write-all\n", false, unsupported, "unsupported_key"},
		{"syntax", "jobs: [\n", false, invalid, "yaml_syntax"},
		{"duplicate", workflowActionsFixture + "name: second\n", false, invalid, "duplicate_key"},
		{"alias", "name: &a Check\non: *a\njobs: {}\n", false, unsupported, "yaml_indirection"},
		{"cyclic alias", "name: &a [*a]\n", false, unsupported, "yaml_indirection"},
		{"tag", "name: !command private-content\n", false, unsupported, "yaml_indirection"},
		{"two docs", workflowActionsFixture + "---\nprivate: secret\n", false, invalid, "yaml_documents"},
		{"control", workflowActionsFixture + "\x00", false, invalid, "text_encoding"},
		{"escaped control", strings.Replace(workflowActionsFixture, "name: Check", `name: "\x00"`, 1), false, invalid, "decoded_control"},
		{"utf8", workflowActionsFixture + string([]byte{255}), false, invalid, "text_encoding"},
		{"oversize", strings.Repeat("a", maxWorkflowBytes+1), false, invalid, "text_encoding"},
		{"depth", "jobs: " + strings.Repeat("[", 34) + "0" + strings.Repeat("]", 34), false, invalid, "yaml_complexity"},
		{"nodes", "jobs: [" + strings.Repeat("0,", 4100) + "]", false, invalid, "yaml_complexity"},
		{"include", gitlab + "include: https://private.invalid/secret\n", true, unsupported, "gitlab_global"},
		{"unpinned", strings.Replace(gitlab, "alpine@sha256:"+strings.Repeat("a", 64), "alpine:latest", 1), true, unsupported, "image_pin"},
		{"rules", gitlab + "  rules: [{when: manual}]\n", true, unsupported, "unsupported_key"},
		{"GitLab only", gitlab + "  only: [branches]\n", true, unsupported, "unsupported_key"},
		{"GitLab except", gitlab + "  except: [tags]\n", true, unsupported, "unsupported_key"},
		{"GitLab workflow", gitlab + "workflow:\n  rules: [{when: always}]\n", true, unsupported, "gitlab_global"},
		{"script", strings.Replace(gitlab, "  script: [echo checked]\n", "", 1), true, invalid, "script_shape"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := &golfv1.WorkflowConfiguration{Format: golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS}
			if tc.gitlab {
				config.Format = golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI
			}
			inspectWorkflow(config, []byte(tc.body))
			if config.State != tc.state || len(config.Diagnostics) > maxWorkflowDiagnostics {
				t.Fatalf("state/bounds: %s, expected %s", config.State, tc.state)
			}
			found := tc.code == ""
			for _, diagnostic := range config.Diagnostics {
				found = found || diagnostic.Code == tc.code
				if strings.Contains(diagnostic.Message, "private-content") || strings.Contains(diagnostic.Message, "private.invalid") || strings.Contains(diagnostic.Message, "secrets.private") {
					t.Fatal("diagnostic echoed source")
				}
			}
			if !found {
				t.Fatal("missing diagnostic", tc.code)
			}
			if tc.state == valid && (len(config.Jobs) != 1 || config.Jobs[0].StepCount != 1) {
				t.Fatal("missing job metadata")
			}
			if tc.name == "actions" && (len(config.Events) != 1 || config.Events[0] != "workflow_dispatch") {
				t.Fatal("YAML on became boolean")
			}
			if tc.name == "push scalar" && (len(config.Events) != 1 || config.Events[0] != "push") ||
				tc.name == "push mapping" && (len(config.Events) != 2 || config.Events[0] != "push" || config.Events[1] != "workflow_dispatch") {
				t.Fatal("inspection lost the explicit event declarations")
			}
		})
	}
	config := &golfv1.WorkflowConfiguration{Format: golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS}
	body := workflowActionsFixture
	for i := 0; i < 50; i++ {
		body += fmt.Sprintf("unsupported%d: value\n", i)
	}
	inspectWorkflow(config, []byte(body))
	if len(config.Diagnostics) != maxWorkflowDiagnostics || config.Diagnostics[maxWorkflowDiagnostics-1].Code != "diagnostic_limit" {
		t.Fatal("diagnostic bounds")
	}
}

func workflowTestBlob(data []byte) string {
	digest := sha1.Sum(append([]byte("blob "+strconv.Itoa(len(data))+"\x00"), data...))
	return hex.EncodeToString(digest[:])
}
func workflowRequest(s *Server, session loginResult, ref string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]any{"repository": map[string]string{"owner": "alice", "name": "private"}, "ref": ref})
	req := httptest.NewRequest("POST", "/rpc"+golfv1connect.WorkflowServiceInspectWorkflowsProcedure, strings.NewReader(string(body)))
	req.Header.Set("Origin", s.config.PublicURL)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	if session.Value != "" {
		req.AddCookie(s.sessionCookie(session.Value, session.Expires, 3600))
	}
	response := httptest.NewRecorder()
	s.ServeHTTP(response, req)
	return response
}
func TestWorkflowBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if response := workflowRequest(s, loginResult{}, "main"); response.Code != 401 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("authentication", response.Code)
	}
	if response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), golfv1connect.WorkflowServiceInspectWorkflowsProcedure, "malformed"); response.Code != 403 {
		t.Fatal("delegation", response.Code)
	}
}

type workflowFixture struct {
	s            *Server
	files        map[string][]byte
	mode         atomic.Value
	contentReads atomic.Int32
	entered      chan struct{}
	resume       chan struct{}
}

func newWorkflowFixture(t *testing.T) (*workflowFixture, loginResult) {
	t.Helper()
	f := &workflowFixture{files: map[string][]byte{".github/workflows/check.yml": []byte(workflowActionsFixture), ".gitlab-ci.yml": []byte("check:\n  image: alpine:latest\n  script: echo inspect\n")}, entered: make(chan struct{}, 1), resume: make(chan struct{})}
	f.mode.Store("")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mode := f.mode.Load().(string)
		write := func(value any) { json.NewEncoder(w).Encode(value) }
		if r.URL.Path == "/api/v1/version" {
			write(map[string]string{"version": "1.27.3"})
			return
		}
		if r.Method != "GET" || r.Header.Get("Authorization") != "token workflow-fixture" {
			t.Error("unexpected method/credential")
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/api/v1/user" {
			id := int64(42)
			if mode == "identity" {
				id = 43
			}
			write(User{ID: id, Login: "alice"})
			return
		}
		if mode == "denied" || mode == "scope" {
			if mode == "scope" {
				w.WriteHeader(403)
			} else {
				w.WriteHeader(404)
			}
			return
		}
		base := "/api/v1/repos/alice/private"
		if r.URL.Path == base {
			id := int64(11)
			if mode == "replacement" {
				id = 12
			}
			write(Repository{ID: id, Name: "private", FullName: "alice/private", HTMLURL: "https://forge.invalid/alice/private", Private: true, Empty: mode == "empty"})
			return
		}
		if r.URL.Path == base+"/commits" {
			commit := strings.Repeat("a", 40)
			if mode == "advanced" && r.URL.Query().Get("sha") != commit {
				commit = strings.Repeat("b", 40)
			}
			write([]map[string]string{{"sha": commit}})
			return
		}
		prefix := base + "/contents-ext/"
		if !strings.HasPrefix(r.URL.Path, prefix) {
			t.Error("unexpected endpoint")
			w.WriteHeader(404)
			return
		}
		if ref := r.URL.Query().Get("ref"); ref != strings.Repeat("a", 40) && ref != strings.Repeat("b", 40) {
			t.Error("mutable source ref")
		}
		name := strings.TrimPrefix(r.URL.Path, prefix)
		content := strings.Contains(r.URL.Query().Get("includes"), "file_content")
		if mode == "missing" {
			w.WriteHeader(404)
			return
		}
		if name == ".github" {
			entry := forgeContents{sourceEntry: sourceEntry{Name: "workflows", Path: ".github/workflows", Type: "dir", SHA: strings.Repeat("c", 40)}}
			if mode == "symlink-location" {
				entry.Type = "symlink"
			}
			write(contentsEnvelope{Directory: []forgeContents{entry}})
			return
		}
		entry := func(name string, data []byte) forgeContents {
			return forgeContents{sourceEntry: sourceEntry{Name: path.Base(name), Path: name, Type: "file", SHA: workflowTestBlob(data), Size: int64(len(data))}}
		}
		if name == ".github/workflows" {
			if mode == "symlink-location" {
				t.Error("followed symlink directory")
			}
			entries := []forgeContents{}
			for filename, data := range f.files {
				if strings.HasPrefix(filename, name+"/") {
					entries = append(entries, entry(filename, data))
				}
			}
			sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
			write(contentsEnvelope{Directory: entries})
			return
		}
		data, found := f.files[name]
		if !found {
			w.WriteHeader(404)
			return
		}
		file := entry(name, data)
		if content {
			f.contentReads.Add(1)
			if mode == "wait" {
				f.entered <- struct{}{}
				select {
				case <-f.resume:
				case <-r.Context().Done():
					return
				}
			}
			file.Encoding, file.Content = "base64", base64.StdEncoding.EncodeToString(data)
			if mode == "corrupt" {
				file.Content = base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", len(data))))
			}
		}
		write(contentsEnvelope{File: &file})
	}))
	t.Cleanup(provider.Close)
	t.Cleanup(func() { close(f.resume) })
	var err error
	f.s, err = New(testConfig(provider.URL), testDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	session, err := f.s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "workflow-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	return f, session
}

func TestWorkflowDiscoveryPostgres(t *testing.T) {
	f, session := newWorkflowFixture(t)
	inspect := func(ref string) *golfv1.InspectWorkflowsResponse {
		response := workflowRequest(f.s, session, ref)
		if response.Code != 200 {
			t.Fatal("inspection", response.Code)
		}
		var result golfv1.InspectWorkflowsResponse
		if err := protojson.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.ExecutionAvailable || result.RepositoryId != "11" || result.CatalogVersion != workflowCatalog {
			t.Fatal("runtime/repository/catalogue claims")
		}
		return &result
	}
	first := inspect("main")
	if len(first.Configurations) != 2 || first.Configurations[0].BlobId != workflowTestBlob(f.files[".github/workflows/check.yml"]) || first.Configurations[0].State != golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET || first.Configurations[1].State != golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_UNSUPPORTED {
		t.Fatal("discovery/metadata")
	}
	f.mode.Store("advanced")
	if inspect("main").CommitId == first.CommitId || inspect(first.CommitId).CommitId != first.CommitId {
		t.Fatal("snapshot followed moved branch")
	}
	for _, test := range []struct {
		mode string
		code int
	}{{"scope", 403}, {"denied", 404}, {"identity", 401}, {"corrupt", 503}, {"empty", 400}} {
		f.mode.Store(test.mode)
		response := workflowRequest(f.s, session, "main")
		if response.Code != test.code || strings.Contains(response.Body.String(), "untrusted-script") {
			t.Fatal("boundary/corruption", test.mode, response.Code)
		}
	}
	f.mode.Store("missing")
	if len(inspect("main").Configurations) != 0 {
		t.Fatal("invented files")
	}
	f.mode.Store("symlink-location")
	if result := inspect("main"); len(result.Diagnostics) != 1 || len(result.Configurations) != 1 {
		t.Fatal("location diagnostic")
	}
	f.mode.Store("")
	f.files[".github/workflows/check.yml"] = []byte(strings.Repeat("a", maxWorkflowBytes+1))
	f.contentReads.Store(0)
	result := inspect("main")
	if result.Configurations[0].State != golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_UNSUPPORTED || result.Configurations[0].ByteSize != maxWorkflowBytes+1 || f.contentReads.Load() != 1 {
		t.Fatal("oversize file was fetched or metadata lost")
	}
	for i := 0; i < 20; i++ {
		f.files[fmt.Sprintf(".github/workflows/many%d.yml", i)] = []byte(workflowActionsFixture)
	}
	if response := workflowRequest(f.s, session, "main"); response.Code != 429 {
		t.Fatal("file count", response.Code)
	}
	f.files = map[string][]byte{}
	for i := 0; i < 9; i++ {
		f.files[fmt.Sprintf(".github/workflows/large%d.yml", i)] = []byte(strings.Repeat("a", maxWorkflowBytes))
	}
	f.contentReads.Store(0)
	if response := workflowRequest(f.s, session, "main"); response.Code != 429 || f.contentReads.Load() != 0 {
		t.Fatal("aggregate size", response.Code)
	}
}

func TestWorkflowPostWaitDenialPostgres(t *testing.T) {
	for _, mode := range []string{"logout", "denied", "identity", "replacement"} {
		t.Run(mode, func(t *testing.T) {
			f, session := newWorkflowFixture(t)
			f.mode.Store("wait")
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- workflowRequest(f.s, session, "main") }()
			select {
			case <-f.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("source did not block")
			}
			if mode == "logout" {
				if err := f.s.logoutSession(context.Background(), session.Value); err != nil {
					t.Fatal(err)
				}
				f.mode.Store("")
			} else {
				f.mode.Store(mode)
			}
			f.resume <- struct{}{}
			select {
			case response := <-done:
				want := 401
				if mode == "denied" {
					want = 404
				} else if mode == "replacement" {
					want = 503
				}
				if response.Code != want || strings.Contains(response.Body.String(), "configurations") {
					t.Fatal("post-wait disclosure", response.Code)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("source did not resume")
			}
		})
	}
}

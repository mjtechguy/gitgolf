package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestActionsWorkflowDirectorySelection(t *testing.T) {
	const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	for _, tc := range []struct {
		name, setting, directory string
		files                    map[string]string
		kinds                    map[string]string
		diagnostics              int
		denied                   bool
	}{
		{name: "github only", directory: ".github/workflows", files: map[string]string{".github/workflows/a.yml": workflowActionsFixture}},
		{name: "forgejo only", directory: ".forgejo/workflows", files: map[string]string{".forgejo/workflows/a.yaml": workflowActionsFixture}},
		{name: "both prefer forgejo", directory: ".forgejo/workflows", files: map[string]string{".forgejo/workflows/a.yml": workflowActionsFixture, ".github/workflows/b.yml": workflowActionsFixture}, diagnostics: 1},
		{name: "empty first inventory", directory: ".forgejo/workflows", files: map[string]string{".forgejo/workflows/.keep": "", ".github/workflows/b.yml": workflowActionsFixture}, diagnostics: 1},
		{name: "nested first", directory: ".forgejo/workflows", files: map[string]string{".forgejo/workflows/nested/a.yml": workflowActionsFixture, ".github/workflows/b.yml": workflowActionsFixture}, diagnostics: 1},
		{name: "invalid YAML still selects first", directory: ".forgejo/workflows", files: map[string]string{".forgejo/workflows/a.yml": "invalid: [", ".github/workflows/b.yml": workflowActionsFixture}, diagnostics: 1},
		{name: "renamed first falls back", directory: ".github/workflows", files: map[string]string{".forgejo/renamed/a.yml": workflowActionsFixture, ".github/workflows/b.yml": workflowActionsFixture}},
		{name: "deleted directories", files: map[string]string{"README.md": "ordinary"}},
		{name: "symlink parent", directory: ".github/workflows", files: map[string]string{".forgejo": "elsewhere", ".github/workflows/b.yml": workflowActionsFixture}, kinds: map[string]string{".forgejo": "symlink"}, diagnostics: 1},
		{name: "file workflow location", directory: ".github/workflows", files: map[string]string{".forgejo/workflows": "elsewhere", ".github/workflows/b.yml": workflowActionsFixture}, diagnostics: 1},
		{name: "submodule location", files: map[string]string{".forgejo/workflows": "elsewhere"}, kinds: map[string]string{".forgejo/workflows": "submodule"}, diagnostics: 1},
		{name: "operator reversed", setting: ".github/workflows,.forgejo/workflows", directory: ".github/workflows", files: map[string]string{".forgejo/workflows/a.yml": workflowActionsFixture, ".github/workflows/b.yml": workflowActionsFixture}, diagnostics: 1},
		{name: "operator github only", setting: ".github/workflows", files: map[string]string{".forgejo/workflows/a.yml": workflowActionsFixture}},
		{name: "permission is not absence", files: map[string]string{".github/workflows/b.yml": workflowActionsFixture}, denied: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			objects := workflowSourceObjects(commit, tc.files, tc.kinds)
			var blobs atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.denied {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				if strings.Contains(r.URL.Path, "/git/blobs/") {
					blobs.Add(1)
				}
				if !objects.serve(w, r, "/api/v1/repos/alice/example") {
					t.Error("unexpected source endpoint")
					w.WriteHeader(500)
				}
			}))
			defer provider.Close()
			config := testConfig(provider.URL)
			config.ForgeWorkflowDirs = tc.setting
			s, err := New(config, nil)
			if err != nil {
				t.Fatal(err)
			}
			directory, entries, diagnostics, err := s.actionsWorkflowDirectory(t.Context(), forgeCredential{Kind: "pat", Token: "directory-fixture"}, "/repos/alice/example", commit)
			if tc.denied {
				var upstream forgeError
				if !errors.As(err, &upstream) || upstream.status != http.StatusForbidden {
					t.Fatal("permission failure swallowed", err)
				}
				return
			}
			if err != nil || directory != tc.directory || len(diagnostics) != tc.diagnostics || blobs.Load() != 0 {
				t.Fatal("selection/diagnostic/metadata boundary", directory, diagnostics, err)
			}
			for _, entry := range entries {
				if !strings.HasPrefix(entry.Path, directory+"/") {
					t.Fatal("merged directory inventories")
				}
			}
		})
	}
}

func TestWorkflowPlannerFailureClassificationPostgres(t *testing.T) {
	for _, tc := range []struct {
		name         string
		exit, status int
	}{
		{"unsupported_source", 3, 200}, {"planner_unavailable", 1, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, session := newWorkflowFixture(t)
			helper := filepath.Join(t.TempDir(), "owned-planner")
			exit := "1"
			if tc.exit == 3 {
				exit = "3"
			}
			if err := os.WriteFile(helper, []byte("#!/bin/sh\nexit "+exit+"\n"), 0700); err != nil {
				t.Fatal(err)
			}
			f.s.config.ActionsEngineBinary, f.s.config.ActionsEngineCatalog = helper, runner.ActionsCatalog
			f.s.runnerImages = map[string]string{"linux": "example/runtime@sha256:" + strings.Repeat("b", 64)}
			response := workflowRequest(f.s, session, "main")
			if response.Code != tc.status || strings.Contains(response.Body.String(), "untrusted-script") {
				t.Fatal("planner failure was misclassified or exposed source", response.Code)
			}
			if tc.status == 200 {
				var result golfv1.InspectWorkflowsResponse
				if err := protojson.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				item := result.Configurations[0]
				if item.State != golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_UNSUPPORTED || len(item.Diagnostics) == 0 || len(item.Diagnostics) > maxWorkflowDiagnostics || !strings.Contains(item.Diagnostics[len(item.Diagnostics)-1].Message, runner.ActionsCatalog) {
					t.Fatal("refusal lost its selected profile and remediation")
				}
			}
		})
	}
}

func TestWorkflowDefinitionUsesSelectedDirectory(t *testing.T) {
	const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	files := map[string]string{".forgejo/workflows/a.yml": workflowActionsFixture, ".github/workflows/b.yml": workflowActionsFixture}
	objects := workflowSourceObjects(commit, files, nil)
	var blobs atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/commits") {
			json.NewEncoder(w).Encode([]map[string]string{{"sha": commit}})
			return
		}
		if strings.Contains(r.URL.Path, "/git/blobs/") {
			blobs.Add(1)
		}
		if !objects.serve(w, r, "/api/v1/repos/alice/example") {
			t.Error("unexpected endpoint")
			w.WriteHeader(500)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	credential := forgeCredential{Kind: "pat", Token: "directory-fixture"}
	if _, _, _, err := s.readWorkflowDefinition(t.Context(), credential, repositoryKey{"alice", "example"}, commit, ".github/workflows/b.yml"); !errors.Is(err, errWorkflowExecutionUnsupported) || blobs.Load() != 0 {
		t.Fatal("suppressed directory admitted or fetched", err)
	}
	got, blob, body, err := s.readWorkflowDefinition(t.Context(), credential, repositoryKey{"alice", "example"}, commit, ".forgejo/workflows/a.yml")
	if err != nil || got != commit || blob != workflowTestBlob([]byte(workflowActionsFixture)) || string(body) != workflowActionsFixture || blobs.Load() != 1 {
		t.Fatal("selected exact workflow refused", err)
	}
}

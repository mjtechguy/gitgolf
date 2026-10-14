package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mjtechguy/golf-git/internal/runner"
)

func gitCommand(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func TestAssignmentValidation(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	c := config{Origin: "https://golf.example.invalid", MachineID: id, ImageID: "sha256:" + strings.Repeat("a", 64), StateDirectory: t.TempDir()}
	credential := "golf_runner_" + id + "_" + strings.Repeat("b", 64)
	if err := validConfig(c, credential); err != nil {
		t.Fatal(err)
	}
	c.Origin = "https:///missing-host"
	if validConfig(c, credential) == nil {
		t.Fatal("accepted an origin without a host")
	}
	c.Origin = "https://golf.example.invalid"
	a := assignment{Contract: workflowContract, JobID: id, Generation: 1, Lease: strings.Repeat("c", 64),
		LeaseExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Deadline: time.Now().Add(5 * time.Minute).UnixMilli(),
		CommitID: strings.Repeat("d", 40), TreeID: strings.Repeat("e", 40), Branch: "feature", ImageID: c.ImageID,
		PolicySHA256: strings.Repeat("f", 64), WorkflowSHA256: strings.Repeat("a", 64),
		CloneURL: c.Origin + "/native/runner-machine/" + id + "/git"}
	a.Workflow.Path = ".github/workflows/test.yml"
	a.Workflow.BlobID = strings.Repeat("b", 40)
	a.Workflow.Plan.Format = "actions"
	a.Workflow.Plan.JobID = "verify"
	a.Workflow.Plan.Steps = []step{{Run: "echo ok", Shell: "sh"}}
	if err := validate(a, c); err != nil {
		t.Fatal(err)
	}
	a.Workflow.Path = ".github/workflows/../evil.yml"
	if validate(a, c) == nil {
		t.Fatal("accepted workflow path traversal")
	}
	a.Workflow.Path = ".github/workflows/test.yml"
	a.Workflow.Plan.AfterScript = "echo unsupported"
	if validate(a, c) == nil {
		t.Fatal("accepted Actions after_script")
	}
	a.Workflow.Plan.AfterScript = ""
	a.Workflow.Path = ".gitlab-ci.yml"
	a.Workflow.Plan.Format = "gitlab"
	a.Workflow.Plan.Image = "alpine:3.23@sha256:" + strings.Repeat("d", 64)
	if err := validate(a, c); err != nil {
		t.Fatal(err)
	}
	a.Workflow.Plan.Image = "alpine:latest"
	if validate(a, c) == nil {
		t.Fatal("accepted an unpinned GitLab job image")
	}
	a.Contract = moduleContract
	a.Workflow = assignment{}.Workflow
	a.WorkflowSHA256 = ""
	a.Module = "tests.unit"
	if err := validate(a, c); err != nil {
		t.Fatal(err)
	}
	a.Module = "tests; exit 0"
	if validate(a, c) == nil {
		t.Fatal("accepted shell syntax in a module")
	}
}

func TestSourceUsesOnlyLeasedGitProxyAndExactObjects(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "source")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	gitCommand(t, repo, "init", "-q", "-b", "feature")
	if err := os.MkdirAll(filepath.Join(repo, ".github", "workflows"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".github", "workflows", "test.yml"), []byte("on: pull_request\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitCommand(t, repo, "add", ".")
	gitCommand(t, repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source")
	commit := gitCommand(t, repo, "rev-parse", "HEAD")
	tree := gitCommand(t, repo, "rev-parse", "HEAD^{tree}")
	blob := gitCommand(t, repo, "rev-parse", "HEAD:.github/workflows/test.yml")
	bare := filepath.Join(root, "repo.git")
	gitCommand(t, root, "init", "-q", "--bare", bare)
	gitCommand(t, repo, "push", "-q", bare, "feature")
	credential, lease := "golf_runner_11111111-1111-4111-8111-111111111111_"+strings.Repeat("a", 64), strings.Repeat("b", 64)
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+credential || r.Header.Get("X-Golf-Runner-Lease") != lease ||
			!strings.HasPrefix(r.URL.Path, "/native/runner-machine/11111111-1111-4111-8111-111111111111/git/") {
			http.Error(w, "denied", http.StatusForbidden)
			return
		}
		requests.Add(1)
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		cmd := exec.Command("git", "http-backend")
		cmd.Env = append(os.Environ(), "GIT_PROJECT_ROOT="+root, "GIT_HTTP_EXPORT_ALL=1", "REQUEST_METHOD="+r.Method,
			"PATH_INFO=/repo.git/"+strings.TrimPrefix(r.URL.Path, "/native/runner-machine/11111111-1111-4111-8111-111111111111/git/"),
			"QUERY_STRING="+r.URL.RawQuery, "CONTENT_TYPE="+r.Header.Get("Content-Type"))
		cmd.Stdin = bytes.NewReader(body)
		output, err := cmd.Output()
		if err != nil {
			http.Error(w, "backend unavailable", http.StatusBadGateway)
			return
		}
		parts := bytes.SplitN(output, []byte("\r\n\r\n"), 2)
		if len(parts) != 2 {
			http.Error(w, "invalid backend response", http.StatusBadGateway)
			return
		}
		for _, line := range bytes.Split(parts[0], []byte("\r\n")) {
			if kv := bytes.SplitN(line, []byte(":"), 2); len(kv) == 2 && !bytes.EqualFold(kv[0], []byte("Status")) {
				w.Header().Set(string(kv[0]), strings.TrimSpace(string(kv[1])))
			}
		}
		_, _ = w.Write(parts[1])
	}))
	defer server.Close()
	a := assignment{Contract: workflowContract, JobID: "11111111-1111-4111-8111-111111111111", CommitID: commit, TreeID: tree,
		Branch: "feature", Lease: lease, CloneURL: server.URL + "/native/runner-machine/11111111-1111-4111-8111-111111111111/git"}
	a.Workflow.Path, a.Workflow.BlobID = ".github/workflows/test.yml", blob
	c := client{credential: credential}
	archive, err := c.source(context.Background(), a, filepath.Join(root, "work"))
	if err == nil {
		t.Fatal("source preparation succeeded without a work directory", archive)
	}
	work := filepath.Join(root, "work")
	if err := os.Mkdir(work, 0700); err != nil {
		t.Fatal(err)
	}
	archive, err = c.source(context.Background(), a, work)
	if err != nil || requests.Load() < 2 {
		t.Fatalf("leased clone failed: %v; requests=%d", err, requests.Load())
	}
	if info, err := os.Stat(archive); err != nil || info.Size() == 0 {
		t.Fatalf("source archive missing: %v", err)
	}
	a.CommitID = strings.Repeat("f", 40)
	other := filepath.Join(root, "other")
	if err := os.Mkdir(other, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := c.source(context.Background(), a, other); err == nil {
		t.Fatal("accepted a moved commit")
	}
}

func TestCompletedAttemptReplaysExactReceipt(t *testing.T) {
	const jobID = "11111111-1111-4111-8111-111111111111"
	finish := map[string]any{"state": "FAILED", "exitCode": 7, "stdout": "", "stderr": "failed", "cleanup": "confirmed"}
	record := attemptJournal{ClaimID: jobID, JobID: jobID, Generation: 2, State: "cleanup-confirmed", Lease: strings.Repeat("a", 64), Finish: finish}
	file := filepath.Join(t.TempDir(), "active.json")
	if err := journal(file, record); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var restored attemptJournal
	if err := decode(bytes.NewReader(data), 4096, &restored); err != nil || restored.Finish["exitCode"] != float64(7) {
		t.Fatalf("journal changed: %v %#v", err, restored)
	}
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path != "/native/runner-machine/"+jobID+"/finish" || r.Header.Get("X-Golf-Runner-Lease") != record.Lease {
			http.Error(w, "wrong attempt", 403)
			return
		}
		var body map[string]any
		if decode(r.Body, 4096, &body) != nil || body["state"] != "FAILED" || body["exitCode"] != float64(7) {
			http.Error(w, "changed result", 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"result":{"state":"FAILED","contract":"golf.native.workflow-shell.v1","jobId":"`+jobID+`","exitCode":7,"producer":{"kind":"customer-runner","generation":2,"cleanup":"asserted"}}}`)
	}))
	defer server.Close()
	c := client{config: config{Origin: server.URL}, credential: "secret", http: server.Client()}
	if err := c.finish(context.Background(), file, restored); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 1 {
		t.Fatalf("expected one completion replay, got %d", requests.Load())
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("journal persisted after receipt: %v", err)
	}
}

func TestLocalClaimCloneExecuteAndFinish(t *testing.T) {
	imageID := os.Getenv("GOLF_RUNNER_TEST_IMAGE")
	if imageID == "" {
		t.Skip("set GOLF_RUNNER_TEST_IMAGE to an installed approved image ID")
	}
	for _, format := range []string{"actions", "gitlab"} {
		t.Run(format, func(t *testing.T) { localClaimCloneExecuteAndFinish(t, imageID, format) })
	}
	if os.Getenv("GOLF_RUNNER_TEST_ACTIONS_ENGINE") != "" {
		t.Run("actions-act", func(t *testing.T) { localClaimCloneExecuteAndFinish(t, imageID, "actions-act") })
		if os.Getenv("GOLF_RUNNER_TEST_SOCKETLESS_BUILD") == "true" {
			t.Run("actions-act-build", func(t *testing.T) { localClaimCloneExecuteAndFinish(t, imageID, "actions-act-build") })
		}
	}
	const alpineID = "sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0"
	if err := exec.Command("docker", "image", "inspect", alpineID).Run(); err == nil {
		t.Run("gitlab-pinned", func(t *testing.T) { localClaimCloneExecuteAndFinish(t, alpineID, "gitlab-pinned") })
	}
}

func localClaimCloneExecuteAndFinish(t *testing.T, imageID, format string) {
	root := t.TempDir()
	repo := filepath.Join(root, "source")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	gitCommand(t, repo, "init", "-q", "-b", "feature")
	if err := os.MkdirAll(filepath.Join(repo, ".github", "workflows"), 0700); err != nil {
		t.Fatal(err)
	}
	workflowPath := ".github/workflows/verify.yml"
	fixture := "native-actions-shell.yml"
	if format == "actions-act" || format == "actions-act-build" {
		fixture = "native-actions-act.yml"
	} else if format != "actions" {
		workflowPath = ".gitlab-ci.yml"
		fixture = "native-gitlab-shell.yml"
		if format == "gitlab-pinned" {
			fixture = "gitlab-shell.yml"
		}
	}
	workflowSource, err := os.ReadFile(filepath.Join("..", "..", "docs", "compatibility", "fixtures", fixture))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, workflowPath), workflowSource, 0600); err != nil {
		t.Fatal(err)
	}
	if format == "actions-act" || format == "actions-act-build" {
		content, readErr := os.ReadFile(filepath.Join("..", "..", "docs", "compatibility", "fixtures", "native-actions-owned-action.yml"))
		if readErr != nil {
			t.Fatal(readErr)
		}
		path := filepath.Join(repo, "actions", "owned")
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "action.yml"), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("exact source\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if format == "actions-act-build" {
		content := "FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0\nCOPY README.md /source.txt\nRUN test -f /source.txt && printf built > /artifact\n"
		if err := os.WriteFile(filepath.Join(repo, "Dockerfile"), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	gitCommand(t, repo, "add", ".")
	gitCommand(t, repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source")
	commit, tree, blob := gitCommand(t, repo, "rev-parse", "HEAD"), gitCommand(t, repo, "rev-parse", "HEAD^{tree}"), gitCommand(t, repo, "rev-parse", "HEAD:"+workflowPath)
	gitCommand(t, root, "init", "-q", "--bare", filepath.Join(root, "repo.git"))
	gitCommand(t, repo, "push", "-q", filepath.Join(root, "repo.git"), "feature")
	const jobID = "11111111-1111-4111-8111-111111111111"
	credential := "golf_runner_" + jobID + "_" + strings.Repeat("a", 64)
	lease := strings.Repeat("b", 64)
	var origin string
	finished := make(chan map[string]any, 1)
	var gitRequests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+credential {
			http.Error(w, "denied", 403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/native/runner-machine/claim":
			var body struct {
				ClaimID         string `json:"claimId"`
				ActionsCatalog  string `json:"actionsCatalog"`
				SocketlessBuild bool   `json:"socketlessBuild"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || !uuid.MatchString(body.ClaimID) || strings.HasPrefix(format, "actions-act") && body.ActionsCatalog != runner.ActionsCatalog || format == "actions-act-build" && !body.SocketlessBuild {
				http.Error(w, "claim", 400)
				return
			}
			a := assignment{Contract: workflowContract, JobID: jobID, Generation: 1, Lease: lease, LeaseExpiresAt: time.Now().Add(90 * time.Second).UnixMilli(), Deadline: time.Now().Add(5 * time.Minute).UnixMilli(), CommitID: commit, TreeID: tree, Branch: "feature", ImageID: imageID, PolicySHA256: strings.Repeat("c", 64), WorkflowSHA256: strings.Repeat("d", 64), CloneURL: origin + "/native/runner-machine/" + jobID + "/git"}
			a.Workflow.Path, a.Workflow.BlobID, a.Workflow.Plan.Format, a.Workflow.Plan.JobID = workflowPath, blob, format, "verify"
			if format == "actions-act" || format == "actions-act-build" {
				a.Contract = actionsContract
				if format == "actions-act-build" {
					a.Contract, a.Build = actionsBuildContract, true
				}
				a.Workflow.Plan.Format = "actions-act"
				a.Workflow.Plan.JobID = ""
				a.Workflow.Plan.Catalog = runner.ActionsCatalog
				a.ImageRef = "alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0"
				a.PullRequestNumber = 1
				a.BaseCommitID = commit
			} else if format == "gitlab-pinned" {
				a.Workflow.Plan.Format, a.Workflow.Plan.JobID = "gitlab", "proof"
				a.Workflow.Plan.Image = "alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0"
				a.Workflow.Plan.Steps = []step{{Run: "value=shared\nmkdir prepared\ncd prepared\ntest \"$value\" = shared\ntest \"${PWD##*/}\" = prepared\ncd ..\ntest -f README.md\nprintf \"gitlab proof\\n\"", Shell: "sh"}}
			} else if format == "gitlab" {
				a.Workflow.Plan.Steps = []step{{Run: "test -f README.md && echo main && exit 7", Shell: "sh"}}
				a.Workflow.Plan.AfterScript = "echo after-script"
			} else {
				a.Workflow.Plan.Steps = []step{{Run: "test -f README.md && cat README.md", Shell: "sh"}}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"assignment": a})
		case r.URL.Path == "/native/runner-machine/"+jobID+"/finish":
			if r.Header.Get("X-Golf-Runner-Lease") != lease {
				http.Error(w, "lease", 403)
				return
			}
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				http.Error(w, "body", 400)
				return
			}
			finished <- body
			_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"state": body["state"], "jobId": jobID, "cleanup": "destroyed", "producer": map[string]any{"kind": "customer-runner"}}})
		case strings.HasPrefix(r.URL.Path, "/native/runner-machine/"+jobID+"/git/"):
			gitRequests.Add(1)
			if r.Header.Get("X-Golf-Runner-Lease") != lease {
				http.Error(w, "lease", 403)
				return
			}
			payload, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			cmd := exec.Command("git", "http-backend")
			cmd.Env = append(os.Environ(), "GIT_PROJECT_ROOT="+root, "GIT_HTTP_EXPORT_ALL=1", "REQUEST_METHOD="+r.Method,
				"PATH_INFO=/repo.git/"+strings.TrimPrefix(r.URL.Path, "/native/runner-machine/"+jobID+"/git/"), "QUERY_STRING="+r.URL.RawQuery, "CONTENT_TYPE="+r.Header.Get("Content-Type"))
			cmd.Stdin = bytes.NewReader(payload)
			output, err := cmd.Output()
			if err != nil {
				http.Error(w, "git", 502)
				return
			}
			parts := bytes.SplitN(output, []byte("\r\n\r\n"), 2)
			if len(parts) != 2 {
				http.Error(w, "git", 502)
				return
			}
			for _, line := range bytes.Split(parts[0], []byte("\r\n")) {
				if kv := bytes.SplitN(line, []byte(":"), 2); len(kv) == 2 && !bytes.EqualFold(kv[0], []byte("Status")) {
					w.Header().Set(string(kv[0]), strings.TrimSpace(string(kv[1])))
				}
			}
			_, _ = w.Write(parts[1])
		default:
			http.Error(w, "path", 404)
		}
	}))
	defer server.Close()
	origin = server.URL
	c := client{config: config{Origin: origin, MachineID: jobID, ImageID: imageID, StateDirectory: filepath.Join(root, "state")}, credential: credential, http: server.Client()}
	if format == "actions-act" || format == "actions-act-build" {
		c.config.ImageRef = "alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0"
		c.config.ActionsEngineBinary = os.Getenv("GOLF_RUNNER_TEST_ACTIONS_ENGINE")
		c.config.SocketlessBuild = format == "actions-act-build"
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	worked, err := c.runOnce(ctx)
	if err != nil || !worked {
		t.Fatalf("native job did not complete: worked=%t err=%v", worked, err)
	}
	select {
	case result := <-finished:
		if gitRequests.Load() < 2 || result["cleanup"] != "confirmed" {
			t.Fatalf("unverified source or cleanup: requests=%d result=%#v", gitRequests.Load(), result)
		}
		if (format == "actions" || format == "actions-act" || format == "actions-act-build") && (result["state"] != "PASSED" || result["exitCode"] != float64(0) || !strings.Contains(result["stdout"].(string), "exact source")) ||
			format == "gitlab" && (result["state"] != "FAILED" || result["exitCode"] != float64(7) || !strings.Contains(result["stdout"].(string), "after-script")) ||
			format == "gitlab-pinned" && (result["state"] != "PASSED" || result["exitCode"] != float64(0) || !strings.Contains(result["stdout"].(string), "gitlab proof")) {
			t.Fatalf("unexpected completion: %#v", result)
		}
		if format == "actions-act-build" {
			build, ok := result["build"].(map[string]any)
			if !ok || !ociDigest.MatchString(build["digest"].(string)) || build["sourceCommit"] != commit || build["bytes"].(float64) < 1 {
				t.Fatalf("missing OCI build receipt: %#v", result)
			}
		}
	default:
		t.Fatal("completion was not sent")
	}
	if _, err := os.Stat(filepath.Join(c.config.StateDirectory, "active.json")); !os.IsNotExist(err) {
		t.Fatalf("attempt journal remained: %v", err)
	}
}

func TestLocalRecoveryKeepsAttemptFenced(t *testing.T) {
	imageID := os.Getenv("GOLF_RUNNER_TEST_IMAGE")
	if imageID == "" {
		t.Skip("set GOLF_RUNNER_TEST_IMAGE to an installed approved image ID")
	}
	const id = "22222222-2222-4222-8222-222222222222"
	root := t.TempDir()
	state := filepath.Join(root, "state")
	if err := os.Mkdir(state, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(state, "job-leftover"), 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(state, "active.json")
	if err := journal(file, attemptJournal{ClaimID: id, JobID: id, Generation: 1, State: "claimed"}); err != nil {
		t.Fatal(err)
	}
	c := client{config: config{MachineID: id, ImageID: imageID, StateDirectory: state}}
	if err := c.recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(state, "job-leftover")); !os.IsNotExist(err) {
		t.Fatalf("source workspace remained: %v", err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var record attemptJournal
	if err := decode(bytes.NewReader(data), 4096, &record); err != nil || record.State != "locally-cleaned" || record.JobID != id {
		t.Fatalf("recovery journal changed: %v %#v", err, record)
	}
	if _, err := c.runOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "requires cleanup reconciliation") {
		t.Fatalf("fenced attempt was reusable: %v", err)
	}
}

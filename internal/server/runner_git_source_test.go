package server

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func runnerGitRequest(attempt, suffix string, body []byte) *http.Request {
	method := http.MethodGet
	if body != nil {
		method = http.MethodPost
	}
	r := httptest.NewRequest(method, "https://golf.invalid/internal/ci/attempt/"+attempt+"/git/"+suffix, bytes.NewReader(body))
	r.TLS = &tls.ConnectionState{Version: tls.VersionTLS13}
	r.Header.Set("Golf-Runner-ID", "fixture")
	r.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	if body != nil {
		r.Header.Set("Content-Type", "application/x-git-upload-pack-request")
	}
	return r
}

func TestJobGitV2ClosedNegotiationAndAdvertisement(t *testing.T) {
	for _, commit := range []string{strings.Repeat("a", 40), strings.Repeat("a", 64)} {
		format := "sha1"
		if len(commit) == 64 {
			format = "sha256"
		}
		request := func(command string, capabilities []string, arguments ...string) []byte {
			body := encodeGitPacket([]byte("command=" + command + "\n"))
			for _, value := range capabilities {
				body = append(body, encodeGitPacket([]byte(value+"\n"))...)
			}
			body = append(body, []byte("0001")...)
			for _, value := range arguments {
				body = append(body, encodeGitPacket([]byte(value+"\n"))...)
			}
			return append(body, []byte("0000")...)
		}
		caps := []string{"agent=git/2.43.0", "object-format=" + format}
		args := []string{"thin-pack", "ofs-delta", "no-progress", "want " + commit, "shallow " + commit, "deepen 1", "have " + commit, "done"}
		valid := request("fetch", caps, args...)
		if jobGitV2Negotiation(valid, commit) != nil || jobGitV2Negotiation(request("fetch", caps, "want "+commit, "have "+commit, "deepen 1"), commit) != nil || jobGitV2Negotiation(request("ls-refs", caps, "peel", "symrefs", "unborn", "ref-prefix refs/heads/", "ref-prefix HEAD"), commit) != nil {
			t.Fatal("bounded v2 discovery/fetch rejected")
		}
		for _, replacement := range []string{"want " + strings.Repeat("f", len(commit)), "have " + strings.Repeat("f", len(commit)), "deepen 2", "deepen-relative", "filter blob:none", "include-tag", "want-ref refs/heads/main", "server-option=attacker", "packfile-uris https", "sideband-all"} {
			changed := append(append([]string{}, args...), replacement)
			if jobGitV2Negotiation(request("fetch", caps, changed...), commit) == nil {
				t.Fatal("unsupported or foreign v2 fetch accepted", replacement)
			}
		}
		for _, body := range [][]byte{
			append(append([]byte{}, valid...), []byte("0000")...),
			bytes.Replace(valid, []byte("0001"), []byte("0002"), 1),
			valid[:len(valid)-4],
			bytes.Repeat([]byte("0000"), 1025),
			request("fetch", caps, "want "+commit, "done"),
			request("fetch", caps, "deepen 1", "done"),
			request("fetch", caps, "want "+commit, "deepen 1"),
			request("fetch", append(append([]string{}, caps...), caps[0]), args...),
			request("fetch", []string{"object-format=wrong"}, args...),
			request("fetch", []string{"server-option=attacker"}, args...),
			request("object-info", caps, "oid "+commit),
			request("ls-refs", caps, "ref-prefix private\rurl"),
		} {
			if jobGitV2Negotiation(body, commit) == nil {
				t.Fatal("malformed or widened v2 command accepted")
			}
		}
		advertisement := func(rows ...string) []byte {
			body := encodeGitPacket([]byte("version 2\n"))
			for _, row := range rows {
				body = append(body, encodeGitPacket([]byte(row+"\n"))...)
			}
			return append(body, []byte("0000")...)
		}
		native := advertisement("agent=git/2.43.0", "ls-refs=unborn", "fetch=shallow filter wait-for-done", "server-option", "object-format="+format, "object-info")
		filtered, err := jobGitV2Advertisement(native, commit)
		if err != nil || bytes.Contains(filtered, []byte("filter")) || bytes.Contains(filtered, []byte("server-option")) || bytes.Contains(filtered, []byte("object-info")) || !bytes.Contains(filtered, []byte("fetch=shallow\n")) {
			t.Fatal("v2 advertisement did not describe the actual bounded commands")
		}
		preamble := append(encodeGitPacket([]byte("# service=git-upload-pack\n")), []byte("0000")...)
		wrapped := append(append([]byte{}, preamble...), native...)
		actual, err := jobGitV2Advertisement(wrapped, commit)
		if err != nil || !bytes.Equal(actual, append(append([]byte{}, preamble...), filtered...)) {
			t.Fatal("native smart-HTTP service preamble was lost", err)
		}
		for _, body := range [][]byte{native[:len(native)-4], append(append([]byte{}, native...), []byte("0002")...), advertisement("ls-refs", "fetch=filter", "object-format="+format), advertisement("ls-refs", "fetch=shallow", "object-format=wrong"), advertisement("ls-refs", "ls-refs", "fetch=shallow", "object-format="+format)} {
			if _, err := jobGitV2Advertisement(body, commit); err == nil {
				t.Fatal("unusable or malformed native v2 advertisement accepted")
			}
		}
	}
}

func runnerGitFetch(commit string) []byte {
	body := encodeGitPacket([]byte("want " + commit + " multi_ack_detailed side-band-64k thin-pack ofs-delta agent=git/2.54.0\n"))
	body = append(body, encodeGitPacket([]byte("deepen 1\n"))...)
	body = append(body, []byte("0000")...)
	return append(body, encodeGitPacket([]byte("done\n"))...)
}

func TestRunnerGitPreparationRouteAndExactNegotiation(t *testing.T) {
	const attempt = "12345678123442348234123456789abc"
	commit := strings.Repeat("a", 40)
	run := workflowRunRecord{RepositoryOwner: "alice", RepositoryName: "example", CommitID: commit}
	r := runnerGitRequest(attempt, "info/refs?service=git-upload-pack", nil)
	route, err := runnerGitRoute(r, attempt, run)
	if err != nil || route.Key != (repositoryKey{"alice", "example"}) || !route.Advertisement {
		t.Fatal("exact attempt route refused", err)
	}
	for _, mutate := range []func(*http.Request){
		func(r *http.Request) { r.TLS = nil },
		func(r *http.Request) { r.TLS.Version = tls.VersionTLS12 },
		func(r *http.Request) { r.URL.Path += "/" },
		func(r *http.Request) { r.URL.RawPath = r.URL.Path },
		func(r *http.Request) { r.URL.RawQuery += "&token=secret" },
		func(r *http.Request) { r.URL.RawQuery = "service=git-receive-pack" },
		func(r *http.Request) { r.Header.Set("Git-Protocol", "version=2") },
		func(r *http.Request) { r.Header.Set("Content-Encoding", "gzip") },
		func(r *http.Request) { r.Header.Set("Cookie", "private-session") },
		func(r *http.Request) { r.Header.Set("Origin", "https://golf.invalid") },
		func(r *http.Request) { r.Header.Add("Golf-Runner-ID", "fixture") },
	} {
		r := runnerGitRequest(attempt, "info/refs?service=git-upload-pack", nil)
		mutate(r)
		if _, err := runnerGitRoute(r, attempt, run); err == nil {
			t.Fatal("noncanonical or unsafe preparation route accepted")
		}
	}
	valid := runnerGitFetch(commit)
	if runnerGitNegotiation(valid, commit) != nil {
		t.Fatal("bounded exact H fetch refused")
	}
	shallow := encodeGitPacket([]byte("want " + commit + "\n"))
	shallow = append(shallow, encodeGitPacket([]byte("shallow "+commit+"\n"))...)
	shallow = append(shallow, encodeGitPacket([]byte("deepen 1\n"))...)
	shallow = append(shallow, []byte("0000")...)
	if runnerGitNegotiation(shallow, commit) != nil {
		t.Fatal("admitted H shallow negotiation refused")
	}
	for _, body := range [][]byte{
		runnerGitFetch(strings.Repeat("b", 40)),
		bytes.Replace(valid, []byte("deepen 1"), []byte("deepen 2"), 1),
		bytes.Replace(valid, []byte("thin-pack"), []byte("evil-pack"), 1),
		append(append([]byte{}, valid...), encodeGitPacket([]byte("have "+commit+"\n"))...),
		append(encodeGitPacket([]byte("want "+commit+"\n")), []byte("0000")...),
		append(encodeGitPacket([]byte("want "+commit+"\n")), append(encodeGitPacket([]byte("want "+commit+"\n")), valid...)...),
		[]byte("0001"), bytes.Repeat([]byte{'x'}, 4097),
	} {
		if runnerGitNegotiation(body, commit) == nil {
			t.Fatal("unsupported negotiation admitted")
		}
	}
}

func TestRunnerGitPreparationActualGitDepthOne(t *testing.T) {
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("installed Git is required for the controlled smart HTTP consumer check")
	}
	root := t.TempDir()
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + root, "XDG_CONFIG_HOME=" + root, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", "LANG=C"}
	run := func(t *testing.T, dir string, args ...string) string {
		t.Helper()
		cmd := exec.CommandContext(t.Context(), git, args...)
		cmd.Dir = dir
		cmd.Env = env
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("controlled Git command failed (%s): %v %s", args[0], err, output)
		}
		return strings.TrimSpace(string(output))
	}
	work := filepath.Join(root, "work")
	if err = os.Mkdir(work, 0700); err != nil {
		t.Fatal(err)
	}
	run(t, work, "init", "--initial-branch=main")
	for _, text := range []string{"older source", "exact admitted source"} {
		if err = os.WriteFile(filepath.Join(work, "README.md"), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		run(t, work, "add", "README.md")
		run(t, work, "-c", "user.name=Golf fixture", "-c", "user.email=fixture@golf.invalid", "commit", "-m", "controlled source")
	}
	commit := run(t, work, "rev-parse", "HEAD")
	run(t, root, "clone", "--bare", "--no-hardlinks", work, filepath.Join(root, "fixture.git"))
	backend := &cgi.Handler{Path: git, Args: []string{"http-backend"}, Root: "/", Dir: root, Env: append(env, "GIT_PROJECT_ROOT="+root, "GIT_HTTP_EXPORT_ALL=1"), Stderr: io.Discard}
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v2 := r.Header.Get("Git-Protocol") == "version=2"
		if r.Header.Get("Git-Protocol") != "" && !v2 || (r.URL.Path != "/fixture.git/info/refs" && r.URL.Path != "/fixture.git/git-upload-pack") {
			http.Error(w, "unsupported", 400)
			return
		}
		if r.Method == http.MethodPost {
			body, err := io.ReadAll(io.LimitReader(r.Body, 4097))
			negotiation := runnerGitNegotiation
			if v2 {
				negotiation = jobGitV2Negotiation
			}
			if err != nil || negotiation(body, commit) != nil {
				t.Logf("controlled exact-H Git request refused: %q", body)
				http.Error(w, "unsupported exact-H negotiation", 400)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			reads.Add(1)
		}
		recorder := httptest.NewRecorder()
		backend.ServeHTTP(recorder, r)
		for name, values := range recorder.Header() {
			w.Header()[name] = values
		}
		body := recorder.Body.Bytes()
		if r.Method == http.MethodGet && recorder.Code == 200 {
			var err error
			if v2 {
				body, err = jobGitV2Advertisement(body, commit)
			} else {
				body, err = runnerGitAdvertisement(body)
			}
			if err != nil {
				http.Error(w, "advertisement refused", 500)
				return
			}
		}
		w.WriteHeader(recorder.Code)
		w.Write(body)
	}))
	t.Cleanup(server.Close)
	for _, version := range []string{"0", "2"} {
		t.Run("protocol_"+version, func(t *testing.T) {
			destination := filepath.Join(root, "destination-"+version)
			if err = os.Mkdir(destination, 0700); err != nil {
				t.Fatal(err)
			}
			run(t, destination, "init")
			run(t, destination, "remote", "add", "origin", server.URL+"/fixture.git")
			before := reads.Load()
			repeats := 1
			if version == "2" {
				repeats = 2
			}
			for range repeats {
				run(t, destination, "-c", "protocol.version="+version, "-c", "credential.helper=", "fetch", "--no-tags", "--prune", "--no-recurse-submodules", "--depth=1", "origin", "+"+commit+":refs/remotes/origin/admitted")
			}
			run(t, destination, "checkout", "--detach", "FETCH_HEAD")
			if reads.Load() <= before || run(t, destination, "rev-parse", "HEAD") != commit || run(t, destination, "rev-list", "--count", "HEAD") != "1" || run(t, destination, "rev-parse", "--is-shallow-repository") != "true" {
				t.Fatal("controlled real Git consumer did not retain exact shallow H")
			}
			if content, err := os.ReadFile(filepath.Join(destination, "README.md")); err != nil || string(content) != "exact admitted source" {
				t.Fatal("real checkout bytes differ", err)
			}
		})
	}
}

// A real database lease and common runner fences with supported-native HTTP
// fixtures. No actual Git process/daemon or unchanged upstream CI is claimed.
func TestRunnerGitPreparationReadAndLateRevocationPostgres(t *testing.T) {
	for _, scenario := range []string{"", "native-denial", "workflow-drift", "lease-revocation", "policy-revision", "redirect", "push-logout", "push-grant-expiry", "push-role-change"} {
		t.Run(scenario, func(t *testing.T) {
			late := scenario
			var f *workflowRunFixture
			grantID := ""
			if strings.HasPrefix(scenario, "push-") {
				var run workflowRunRecord
				f, run, _ = automaticRunFixture(t)
				grantID = run.AutomationGrantID.String
				if _, err := f.server.db.ExecContext(t.Context(), `UPDATE golf_execution_policies SET push_allowed=true`); err != nil {
					t.Fatal(err)
				}
				late = strings.TrimPrefix(scenario, "push-")
				if late == "logout" {
					if _, err := f.server.db.ExecContext(t.Context(), `DELETE FROM golf_sessions`); err != nil {
						t.Fatal(err)
					}
					late = ""
				}
			} else {
				f = newWorkflowRunFixture(t)
				f.enable(t)
				if _, err := f.dispatch(t, originalDispatchKey); err != nil {
					t.Fatal(err)
				}
			}
			poll := engineWorkerCall(f, engineLease{}, "poll", map[string]any{"capabilities": []string{"golf.runner.job-limits.v1"}})
			var lease engineLease
			if poll.Code != 200 || json.Unmarshal(poll.Body.Bytes(), &lease) != nil {
				t.Fatal("assignment", poll.Code)
			}
			forwards := 0
			base := http.DefaultTransport
			f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/alice/example.git/git-upload-pack" || r.URL.Path == "/alice/example.git/info/refs" {
					forwards++
					user, token, ok := r.BasicAuth()
					if !ok || user != "alice" || token != "run-fixture" || r.Header.Get("Golf-Attempt-Token") != "" || r.Header.Get("Golf-Runner-ID") != "" || r.Header.Get("Cookie") != "" {
						t.Fatal("native forwarding identity or header isolation")
					}
					if r.Method == http.MethodPost {
						body, _ := io.ReadAll(r.Body)
						if !bytes.Equal(body, runnerGitFetch(f.commit)) {
							t.Fatal("negotiation bytes changed")
						}
					}
					f.mu.Lock()
					if late == "native-denial" {
						f.denied = true
					}
					if late == "workflow-drift" {
						f.workflow = []byte("different workflow")
					}
					if late == "role-change" {
						f.permission = "read"
					}
					f.mu.Unlock()
					if late == "grant-expiry" {
						if _, err := f.server.db.ExecContext(t.Context(), `UPDATE golf_automation_grants SET expires_at=created_at+interval '1 microsecond' WHERE id=$1`, grantID); err != nil {
							t.Fatal(err)
						}
					}
					if late == "lease-revocation" {
						if _, err := f.server.db.ExecContext(t.Context(), `UPDATE golf_workflow_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, lease.RunID); err != nil {
							t.Fatal(err)
						}
					}
					if late == "policy-revision" {
						if _, err := f.server.db.ExecContext(t.Context(), `UPDATE golf_execution_policies SET revision=revision+1 WHERE forge_url=$1 AND scope='instance'`, f.server.config.GiteaURL); err != nil {
							t.Fatal(err)
						}
					}
					content := "application/x-git-upload-pack-result"
					body := []byte("private bounded pack fixture")
					if r.Method == http.MethodGet {
						content = "application/x-git-upload-pack-advertisement"
						body = append(encodeGitPacket([]byte("# service=git-upload-pack\n")), []byte("0000")...)
						body = append(body, encodeGitPacket([]byte(f.commit+" refs/heads/main\x00multi_ack_detailed shallow deepen-since deepen-not filter agent=git/2.54.0\n"))...)
						body = append(body, []byte("0000")...)
					}
					response := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {content}}, Body: io.NopCloser(bytes.NewReader(body)), Request: r}
					if late == "redirect" {
						response.StatusCode = 302
						response.Header.Set("Location", "https://unrelated.invalid/")
					}
					return response, nil
				}
				response, err := base.RoundTrip(r)
				if err != nil {
					return response, err
				}
				if response.StatusCode == 200 && (r.URL.Path == "/api/v1/user" || r.URL.Path == "/api/v1/repos/alice/example") {
					var row map[string]any
					decoder := json.NewDecoder(response.Body)
					decoder.UseNumber()
					if decoder.Decode(&row) != nil {
						t.Fatal("native fixture JSON")
					}
					response.Body.Close()
					if r.URL.Path == "/api/v1/user" {
						row["is_admin"] = false
					} else {
						row["has_actions"] = false
						row["permissions"] = map[string]bool{"pull": true, "push": true, "admin": true}
					}
					body, _ := json.Marshal(row)
					response.Body = io.NopCloser(bytes.NewReader(body))
					response.ContentLength = int64(len(body))
				}
				return response, nil
			})
			request := runnerGitRequest(lease.AttemptID, "git-upload-pack", runnerGitFetch(f.commit))
			request.Header.Set("Golf-Attempt-Token", lease.AttemptToken)
			response := httptest.NewRecorder()
			f.server.ServeHTTP(response, request)
			if forwards != 1 {
				t.Fatal("unexpected native Git effect count", forwards, "response", response.Code, response.Body.String())
			}
			if late == "" {
				if response.Code != 200 || response.Body.String() != "private bounded pack fixture" || response.Header().Get("Golf-Source-Commit") != f.commit || response.Header().Get("Golf-Workflow-Blob") != workflowTestBlob(f.workflow) {
					t.Fatal("exact preparation receipt", response.Code)
				}
				request := runnerGitRequest(lease.AttemptID, "info/refs?service=git-upload-pack", nil)
				request.Header.Set("Golf-Attempt-Token", lease.AttemptToken)
				advertisement := httptest.NewRecorder()
				f.server.ServeHTTP(advertisement, request)
				if advertisement.Code != 200 || forwards != 2 || strings.Contains(advertisement.Body.String(), "deepen-since") || strings.Contains(advertisement.Body.String(), "filter") || !strings.Contains(advertisement.Body.String(), f.commit+" refs/heads/main") {
					t.Fatal("exact bounded native advertisement", advertisement.Code)
				}
			} else if response.Code == 200 || strings.Contains(response.Body.String(), "private bounded pack") || response.Header().Get("Golf-Source-Commit") != "" {
				t.Fatal("private native bytes escaped late refusal", response.Code)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("private preparation response cacheable")
			}
		})
	}
}

package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

func jobGitFixture(t *testing.T) (*Server, workflowRunRecord, string, time.Time) {
	t.Helper()
	now := time.Unix(1800000000, 0)
	worker := sha256.Sum256([]byte("worker-control-credential"))
	lease := sha256.Sum256([]byte("attempt-control-credential"))
	s := &Server{config: Config{PublicURL: "https://golf.invalid", GiteaURL: "https://forge.invalid"}, keyring: parseTestKeys(t, "", map[string]string{"job": keyFixture(9)}, "job"), runnerKeys: map[string][32]byte{"worker": worker}}
	run := workflowRunRecord{ID: originalDispatchKey, AttemptID: strings.Repeat("a", 32), RunnerID: "worker", LeaseTokenHash: lease[:], LeaseExpiresAt: sql.NullTime{Time: now.Add(45 * time.Second), Valid: true}, RepositoryID: 17, OwnerID: 18, RepositoryOwner: "alice", RepositoryName: "example", CommitID: strings.Repeat("b", 40), BlobID: strings.Repeat("c", 40), WorkflowPath: ".github/workflows/lint.yml", SourceSHA256: strings.Repeat("d", 64), EngineCatalog: runner.ActionsCatalog, State: "running"}
	return s, run, strings.Repeat("e", 32), now
}

// Two real managed identities and a supported source approval distinguish the
// dispatcher from the administrator approving execution values. Native API/Git
// responses remain controlled fixtures; this does not qualify an actual forge.
func TestJobGitIndependentApproverLateRevocationPostgres(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		t.Run(map[bool]string{false: "unchanged", true: "approver-lost"}[revoke], func(t *testing.T) {
			f, target := executionEngineFixture(t)
			valueID, bindingID := executionEngineApproval(t, f, target)
			bob := User{ID: 43, Login: "bob"}
			bobSession, err := f.server.createSession(t.Context(), bob, "pat", "approver-fixture", "")
			if err != nil {
				t.Fatal(err)
			}
			bobCtx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "approver-fixture"})
			bobRequest := func(m *golfv1.SaveRepositoryExecutionBindingRequest) *connect.Request[golfv1.SaveRepositoryExecutionBindingRequest] {
				r := connect.NewRequest(m)
				r.Header().Set("Cookie", cookieName+"="+bobSession.Value)
				return r
			}
			var bobAdmin atomic.Bool
			bobAdmin.Store(true)
			var forwards atomic.Int64
			base := f.server.client.Transport
			f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
				isBob := r.Header.Get("Authorization") == "token approver-fixture" || r.Header.Get("Authorization") == "Bearer approver-fixture"
				if r.URL.Path == "/alice/example.git/git-upload-pack" {
					deadline, ok := r.Context().Deadline()
					if !ok || deadline.After(time.Now().Add(15*time.Second)) {
						t.Fatal("ordinary router deadline was extended")
					}
					forwards.Add(1)
					username, password, ok := r.BasicAuth()
					if !ok || username != "alice" || password != "run-fixture" || isBob {
						t.Fatal("Git read did not use original dispatcher")
					}
					if revoke {
						bobAdmin.Store(false)
					}
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/x-git-upload-pack-result"}}, Body: io.NopCloser(strings.NewReader("private independently-approved pack")), Request: r}, nil
				}
				if isBob && r.URL.Path == "/api/v1/repos/alice/example/collaborators/bob/permission" {
					permission := "admin"
					if !bobAdmin.Load() {
						permission = "read"
					}
					data, _ := json.Marshal(map[string]any{"permission": permission, "user": bob})
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(bytes.NewReader(data)), Request: r}, nil
				}
				if isBob && r.URL.Path == "/api/v1/repos/alice/example/collaborators/bob" {
					return &http.Response{StatusCode: 204, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				request := r.Clone(r.Context())
				request.Header = r.Header.Clone()
				if isBob {
					request.Header.Set("Authorization", "token run-fixture")
				}
				response, err := base.RoundTrip(request)
				if err != nil || response.StatusCode != 200 || (r.URL.Path != "/api/v1/user" && r.URL.Path != "/api/v1/repos/alice/example" && !strings.HasPrefix(r.URL.Path, "/api/v1/repositories/")) {
					return response, err
				}
				var row map[string]any
				decoder := json.NewDecoder(response.Body)
				decoder.UseNumber()
				if decoder.Decode(&row) != nil {
					t.Fatal("independent native fixture JSON")
				}
				response.Body.Close()
				if r.URL.Path == "/api/v1/user" {
					row["is_admin"] = false
					if isBob {
						row["id"] = bob.ID
						row["login"] = bob.Login
					}
				} else {
					row["has_actions"] = false
					row["permissions"] = map[string]bool{"pull": true, "push": true, "admin": !isBob || bobAdmin.Load()}
				}
				data, _ := json.Marshal(row)
				response.Body = io.NopCloser(bytes.NewReader(data))
				response.ContentLength = int64(len(data))
				return response, nil
			})
			// Supported replacement binds the second approver's genuine managed
			// session while retaining the original source/value identities.
			approved, err := f.server.SaveRepositoryExecutionBinding(bobCtx, bobRequest(&golfv1.SaveRepositoryExecutionBindingRequest{Target: target, Id: bindingID, ExpectedVersion: "1", ExpectedBrokerRevision: "2", OperationId: uuid.NewString(), WorkflowPath: runWorkflowPath, CommitId: f.commit, Event: golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_MANUAL, ExpiresAt: time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339Nano), Values: []*golfv1.RepositoryExecutionValueReference{{Id: valueID, Version: "1"}}}))
			if err != nil || approved.Msg.Operation.AcceptedVersion != "2" {
				t.Fatal("independent supported approval", err)
			}
			executionDispatch(t, f)
			lease := executionLease(t, f)
			f.server.config.PublicURL = "https://golf.invalid"
			job := lease.ActionsPlan.Jobs[0]
			started := executionWorkerCall(f, lease, "graph", map[string]any{"sequence": 1, "jobInstanceId": job.InstanceID, "kind": "job_started"}, tls.VersionTLS13)
			if started.Code != 204 {
				t.Fatal("genuine approved job", started.Code)
			}
			issued := jobGitIssue(t, f, lease, job.InstanceID)
			var credential jobGitCredentialResponse
			if issued.Code != 200 || json.Unmarshal(issued.Body.Bytes(), &credential) != nil {
				t.Fatal("approved job credential", issued.Code)
			}
			claims, err := f.server.openJobGitCredential(credential.GitToken)
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			f.server.ServeHTTP(response, jobGitRequest(credential.GitToken, "git-upload-pack", runnerGitFetch(f.commit)))
			if forwards.Load() != 1 {
				t.Fatal("expected genuine upstream read", forwards.Load(), response.Code)
			}
			run, err := scanWorkflowRun(f.server.db.QueryRowContext(t.Context(), "SELECT "+workflowRunColumns+" FROM golf_workflow_runs WHERE id=$1", lease.RunID))
			if err != nil {
				t.Fatal(err)
			}
			binding, err := storedExecutionRunBinding(t.Context(), f.server.db, run)
			if err != nil || binding == nil || binding.approverNative != bob.ID || run.UserID == binding.approverUser {
				t.Fatal("fixture did not retain independent identities", err)
			}
			if err := f.server.runnerRunAuthority(t.Context(), run); err != nil {
				t.Fatal("original dispatcher lost write authority", err)
			}
			// All Golf rows and current job/attempt resources still pass. Native
			// administrator revocation must be observed independently after reads.
			tx, err := f.server.db.BeginTx(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			err = f.server.jobGitFinalFence(t.Context(), tx, run, claims)
			tx.Rollback()
			if err != nil {
				t.Fatal("SQL lifecycle changed in native-only scenario", err)
			}
			if revoke {
				if f.server.executionApprovalAuthority(t.Context(), run, binding) == nil {
					t.Fatal("native approver still had admin rights")
				}
				if response.Code == 200 || strings.Contains(response.Body.String(), "private independently-approved pack") || response.Header().Get("Golf-Source-Commit") != "" || response.Header().Get("Golf-Job-Instance") != "" {
					t.Fatal("independent approver revocation released buffered private bytes", response.Code)
				}
			} else if response.Code != 200 || response.Body.String() != "private independently-approved pack" {
				t.Fatal("unchanged independent approval denied", response.Code)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("approval result caching")
			}
		})
	}
}

func TestJobGitSealedScopeAndLifecycle(t *testing.T) {
	s, run, job, now := jobGitFixture(t)
	credential, err := s.mintJobGitCredential(run, job, now)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := s.openJobGitCredential(credential.GitToken)
	if err != nil || s.jobGitCurrentClaims(claims, run, now) != nil || claims.Expires != now.Add(45*time.Second).Unix() || credential.RepositoryURL != "https://golf.invalid/alice/example" || credential.JobInstanceID != job {
		t.Fatal("exact job/origin/lease binding", err)
	}
	if strings.Contains(credential.GitToken, "worker-control-credential") || strings.Contains(credential.GitToken, "attempt-control-credential") || strings.Contains(credential.GitToken, run.CommitID) {
		t.Fatal("credential disclosure")
	}
	for _, name := range []string{"expiry", "future", "overlong", "attempt", "lease", "worker", "cancel", "finished", "source", "blob", "repository", "owner", "archive", "catalog", "job", "workflow"} {
		t.Run(name, func(t *testing.T) {
			c, r, clock := claims, run, now
			switch name {
			case "expiry":
				clock = now.Add(45 * time.Second)
			case "future":
				c.Issued = now.Unix() + 1
			case "overlong":
				c.Expires = c.Issued + 301
			case "attempt":
				r.AttemptID = strings.Repeat("f", 32)
			case "lease":
				r.LeaseTokenHash = bytes.Repeat([]byte{3}, 32)
			case "worker":
				r.RunnerID = "unknown"
			case "cancel":
				r.CancelRequested = true
			case "finished":
				r.State = "succeeded"
			case "source":
				r.CommitID = strings.Repeat("f", 40)
			case "blob":
				r.BlobID = strings.Repeat("f", 40)
			case "repository":
				r.RepositoryID++
			case "owner":
				r.OwnerID++
			case "archive":
				r.SourceSHA256 = strings.Repeat("f", 64)
			case "catalog":
				r.EngineCatalog = workflowExecutionCatalog
			case "job":
				c.Job = "build"
			case "workflow":
				c.Workflow = "../workflow.yml"
			}
			if s.jobGitCurrentClaims(c, r, clock) == nil {
				t.Fatal("stale or malformed scope survived")
			}
		})
	}
	worker := s.runnerKeys[run.RunnerID]
	s.runnerKeys[run.RunnerID] = sha256.Sum256([]byte("rotated"))
	if s.jobGitCurrentClaims(claims, run, now) == nil {
		t.Fatal("rotated worker survived")
	}
	s.runnerKeys[run.RunnerID] = worker
	for _, token := range []string{"worker-control-credential", "attempt-control-credential", "golf_git_human", credential.GitToken + "=", strings.Replace(credential.GitToken, run.ID, "12345678-1234-4234-8234-123456789aaa", 1)} {
		if _, err := s.openJobGitCredential(token); err == nil {
			t.Fatal("foreign or malformed credential accepted")
		}
	}
	parts := strings.Split(strings.TrimPrefix(credential.GitToken, jobGitPrefix), ":")
	cipher, _ := base64.RawURLEncoding.DecodeString(parts[2])
	cipher[len(cipher)-1] ^= 1
	if _, err := s.openJobGitCredential(jobGitPrefix + parts[0] + ":" + parts[1] + ":" + base64.RawURLEncoding.EncodeToString(cipher)); err == nil {
		t.Fatal("tampered capsule accepted")
	}
	binding, _ := s.jobGitBinding(run.ID)
	for _, domain := range []string{sessionDomain, oauthAttemptDomain, executionValueDomain} {
		plain, _ := json.Marshal(claims)
		sealed, key, err := s.keyring.seal(domain, string(plain), binding)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.openJobGitCredential(jobGitPrefix + key + ":" + run.ID + ":" + base64.RawURLEncoding.EncodeToString(sealed)); err == nil {
			t.Fatal("seal domain confused")
		}
	}
	s.config.PublicURL = "https://other.invalid"
	if _, err := s.openJobGitCredential(credential.GitToken); err == nil {
		t.Fatal("origin drift survived")
	}
	s.config.PublicURL = "https://golf.invalid"
	run.LeaseExpiresAt.Time = now.Add(10 * time.Minute)
	long, err := s.mintJobGitCredential(run, job, now)
	if err != nil {
		t.Fatal(err)
	}
	longClaims, _ := s.openJobGitCredential(long.GitToken)
	if longClaims.Expires != now.Add(5*time.Minute).Unix() {
		t.Fatal("five minute ceiling was extended")
	}
	s.keyring = parseTestKeys(t, "", map[string]string{"job": keyFixture(9), "next": keyFixture(10)}, "next")
	if _, err := s.openJobGitCredential(credential.GitToken); err != nil {
		t.Fatal("retained decrypt key", err)
	}
	s.keyring = parseTestKeys(t, "", map[string]string{"next": keyFixture(10)}, "next")
	if _, err := s.openJobGitCredential(credential.GitToken); err == nil {
		t.Fatal("retired key still authorizes")
	}
}

func jobGitRequest(token, suffix string, body []byte) *http.Request {
	method := http.MethodGet
	if body != nil {
		method = http.MethodPost
	}
	r := httptest.NewRequest(method, "https://golf.invalid/alice/example/"+suffix, bytes.NewReader(body))
	r.TLS = &tls.ConnectionState{Version: tls.VersionTLS13}
	r.SetBasicAuth("x-access-token", token)
	if body != nil {
		r.Header.Set("Content-Type", "application/x-git-upload-pack-request")
	}
	return r
}

func TestJobGitCanonicalReadOnlyRoute(t *testing.T) {
	s, run, job, now := jobGitFixture(t)
	credential, _ := s.mintJobGitCredential(run, job, now)
	claims, _ := s.openJobGitCredential(credential.GitToken)
	for _, suffix := range []string{"info/refs?service=git-upload-pack", "git-upload-pack"} {
		var body []byte
		if suffix == "git-upload-pack" {
			body = runnerGitFetch(run.CommitID)
		}
		if route, err := s.jobGitRoute(jobGitRequest(credential.GitToken, suffix, body), claims); err != nil || route.Service != "git-upload-pack" {
			t.Fatal("canonical route", err)
		}
	}
	for _, name := range []string{"tls", "host", "rawpath", "query", "userinfo", "force-query", "receive", "wiki", "other-repo", "v2", "gzip", "cookie", "origin", "runner", "attempt", "duplicate-auth", "duplicate-mime", "human-user", "method"} {
		t.Run(name, func(t *testing.T) {
			r := jobGitRequest(credential.GitToken, "git-upload-pack", runnerGitFetch(run.CommitID))
			switch name {
			case "tls":
				r.TLS.Version = tls.VersionTLS12
			case "host":
				r.Host = "other.invalid"
			case "rawpath":
				r.URL.RawPath = "/alice/example/git%2dupload-pack"
			case "query":
				r.URL.RawQuery = "service=git-upload-pack"
			case "userinfo":
				r.URL.User = url.User("injected")
			case "force-query":
				r.URL.ForceQuery = true
			case "receive":
				r.URL.Path = "/alice/example/git-receive-pack"
			case "wiki":
				r.URL.Path = "/alice/example.wiki/git-upload-pack"
			case "other-repo":
				r.URL.Path = "/alice/other/git-upload-pack"
			case "v2":
				r.Header.Set("Git-Protocol", "version=2")
			case "gzip":
				r.Header.Set("Content-Encoding", "gzip")
			case "cookie":
				r.Header["Cookie"] = []string{""}
			case "origin":
				r.Header.Set("Origin", "https://golf.invalid")
			case "runner":
				r.Header.Set("Golf-Runner-ID", "worker")
			case "attempt":
				r.Header.Set("Golf-Attempt-Token", "attempt-control-credential")
			case "duplicate-auth":
				r.Header.Add("Authorization", r.Header.Get("Authorization"))
			case "duplicate-mime":
				r.Header.Add("Content-Type", r.Header.Get("Content-Type"))
			case "human-user":
				r.SetBasicAuth("alice", credential.GitToken)
			case "method":
				r.Method = http.MethodPut
			}
			if _, err := s.jobGitRoute(r, claims); err == nil {
				t.Fatal("route alias or authority confusion accepted")
			}
		})
	}
	for _, origin := range []string{"http://localhost:8080", "https://golf.invalid/", "https://user@golf.invalid", "https://golf.invalid/path", "https://golf.invalid?x=1", "https://golf.invalid#fragment"} {
		s.config.PublicURL = origin
		if _, err := s.jobGitOrigin(); err == nil {
			t.Fatal("noncanonical origin accepted", origin)
		}
	}
}

func TestJobGitIssuerCanonicalBoundary(t *testing.T) {
	s, run, _, _ := jobGitFixture(t)
	makeRequest := func() *http.Request {
		r := httptest.NewRequest(http.MethodPost, "https://golf.invalid/internal/ci/attempt/"+run.AttemptID+"/job-git-credential", strings.NewReader("{}"))
		r.TLS = &tls.ConnectionState{Version: tls.VersionTLS13}
		r.Header.Set("Authorization", "Bearer control-fixture")
		r.Header.Set("Golf-Runner-ID", run.RunnerID)
		r.Header.Set("Golf-Attempt-Token", "attempt-fixture")
		return r
	}
	if !s.jobGitIssuerRoute(makeRequest(), run.AttemptID) {
		t.Fatal("canonical issuer rejected")
	}
	for _, name := range []string{"userinfo", "opaque", "tls", "host", "method", "rawpath", "query", "forced-query", "cookie", "origin", "duplicate-worker", "duplicate-attempt", "duplicate-auth"} {
		t.Run(name, func(t *testing.T) {
			r := makeRequest()
			switch name {
			case "userinfo":
				r.URL.User = url.User("injected")
			case "opaque":
				r.URL.Opaque = "opaque"
			case "tls":
				r.TLS.Version = tls.VersionTLS12
			case "host":
				r.Host = "other.invalid"
			case "method":
				r.Method = http.MethodGet
			case "rawpath":
				r.URL.RawPath = r.URL.Path
			case "query":
				r.URL.RawQuery = "jobInstanceId=forged"
			case "forced-query":
				r.URL.ForceQuery = true
			case "cookie":
				r.Header["Cookie"] = []string{""}
			case "origin":
				r.Header.Set("Origin", s.config.PublicURL)
			case "duplicate-worker":
				r.Header.Add("Golf-Runner-ID", run.RunnerID)
			case "duplicate-attempt":
				r.Header.Add("Golf-Attempt-Token", "attempt-fixture")
			case "duplicate-auth":
				r.Header.Add("Authorization", "Bearer control-fixture")
			}
			if s.jobGitIssuerRoute(r, run.AttemptID) {
				t.Fatal("issuer transport alias accepted")
			}
		})
	}
}

func jobGitIssue(t *testing.T, f *workflowRunFixture, lease engineLease, job string) *httptest.ResponseRecorder {
	t.Helper()
	data, _ := json.Marshal(map[string]string{"jobInstanceId": job})
	r := httptest.NewRequest(http.MethodPost, "https://golf.invalid/internal/ci/attempt/"+lease.AttemptID+"/job-git-credential", bytes.NewReader(data))
	r.TLS = &tls.ConnectionState{Version: tls.VersionTLS13}
	r.Header.Set("Golf-Runner-ID", "fixture")
	r.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	r.Header.Set("Golf-Attempt-Token", lease.AttemptToken)
	w := httptest.NewRecorder()
	f.server.ServeHTTP(w, r)
	return w
}

// Real PostgreSQL/real admitted planner graph, with a controlled supported native
// API/Git transport. No Docker engine, enrolled local worker or checkout proof.
func TestJobGitCurrentGraphAndLateRevocationPostgres(t *testing.T) {
	for _, scenario := range []string{"success", "job-finish", "attempt-revoke", "policy-revision", "native-denial", "workflow-drift", "redirect"} {
		t.Run(scenario, func(t *testing.T) {
			f := engineRunFixture(t)
			if _, err := f.dispatch(t, originalDispatchKey); err != nil {
				t.Fatal(err)
			}
			lease := engineAssigned(t, f)
			f.server.config.PublicURL = "https://golf.invalid"
			job := lease.ActionsPlan.Jobs[0]
			if w := jobGitIssue(t, f, lease, job.InstanceID); w.Code != 403 {
				t.Fatal("pending job issued capability", w.Code)
			}
			if w := jobGitIssue(t, f, lease, strings.Repeat("f", 32)); w.Code != 403 {
				t.Fatal("caller invented job", w.Code)
			}
			if w := engineWorkerCall(f, lease, "graph", map[string]any{"sequence": 1, "jobInstanceId": job.InstanceID, "kind": "job_started"}); w.Code != 204 {
				t.Fatal("genuine graph", w.Code)
			}
			issued := jobGitIssue(t, f, lease, job.InstanceID)
			var credential jobGitCredentialResponse
			if issued.Code != 200 || json.Unmarshal(issued.Body.Bytes(), &credential) != nil || credential.GitToken == "" || issued.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("current job issuance", issued.Code)
			}
			base := f.server.client.Transport
			if base == nil {
				base = http.DefaultTransport
			}
			forwards := 0
			f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path != "/alice/example.git/git-upload-pack" && r.URL.Path != "/alice/example.git/info/refs" {
					response, err := base.RoundTrip(r)
					if err != nil || response.StatusCode != 200 || (r.URL.Path != "/api/v1/user" && r.URL.Path != "/api/v1/repos/alice/example") {
						return response, err
					}
					var row map[string]any
					decoder := json.NewDecoder(response.Body)
					decoder.UseNumber()
					if decoder.Decode(&row) != nil {
						t.Fatal("native JSON fixture")
					}
					response.Body.Close()
					if r.URL.Path == "/api/v1/user" {
						row["is_admin"] = false
					} else {
						row["has_actions"] = false
						row["permissions"] = map[string]bool{"pull": true, "push": true, "admin": true}
					}
					data, _ := json.Marshal(row)
					response.Body = io.NopCloser(bytes.NewReader(data))
					response.ContentLength = int64(len(data))
					return response, nil
				}
				forwards++
				user, pass, ok := r.BasicAuth()
				if !ok || user != "alice" || pass != "run-fixture" || strings.Contains(r.Header.Get("Authorization"), credential.GitToken) || r.Header.Get("Golf-Attempt-Token") != "" || r.Header.Get("Golf-Runner-ID") != "" || r.Header.Get("Cookie") != "" {
					t.Fatal("credential namespace leak")
				}
				body, _ := io.ReadAll(r.Body)
				if r.Method == http.MethodPost && !bytes.Equal(body, runnerGitFetch(f.commit)) {
					t.Fatal("request changed")
				}
				switch scenario {
				case "job-finish":
					for index, event := range []map[string]any{
						{"stepId": job.Steps[0].ID, "kind": "step_started"},
						{"stepId": job.Steps[0].ID, "kind": "step_finished", "state": "failure"},
						{"kind": "job_finished", "state": "failure"},
					} {
						event["sequence"] = index + 2
						event["jobInstanceId"] = job.InstanceID
						if w := engineWorkerCall(f, lease, "graph", event); w.Code != 204 {
							t.Fatal("genuine job terminal receipt", w.Code, w.Body.String())
						}
					}
				case "attempt-revoke":
					if _, err := f.server.db.ExecContext(t.Context(), `UPDATE golf_workflow_runs SET cancel_requested=true WHERE id=$1`, lease.RunID); err != nil {
						t.Fatal(err)
					}
				case "policy-revision":
					if _, err := f.server.db.ExecContext(t.Context(), `UPDATE golf_execution_policies SET revision=revision+1 WHERE forge_url=$1 AND scope='instance'`, f.server.config.GiteaURL); err != nil {
						t.Fatal(err)
					}
				case "native-denial":
					f.mu.Lock()
					f.denied = true
					f.mu.Unlock()
				case "workflow-drift":
					f.mu.Lock()
					f.workflow = []byte("different workflow")
					f.mu.Unlock()
				}
				response := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/x-git-upload-pack-result"}}, Body: io.NopCloser(strings.NewReader("private job pack")), Request: r}
				if r.Method == http.MethodGet {
					data := append(encodeGitPacket([]byte("# service=git-upload-pack\n")), []byte("0000")...)
					data = append(data, encodeGitPacket([]byte(f.commit+" refs/heads/main\x00shallow ofs-delta no-progress\n"))...)
					data = append(data, encodeGitPacket([]byte(strings.Repeat("f", 40)+" refs/heads/other-private-branch\n"))...)
					data = append(data, []byte("0000")...)
					response.Header.Set("Content-Type", "application/x-git-upload-pack-advertisement")
					response.Body = io.NopCloser(bytes.NewReader(data))
				}
				if scenario == "redirect" {
					response.StatusCode = 302
					response.Header.Set("Location", "https://other.invalid/")
				}
				return response, nil
			})
			w := httptest.NewRecorder()
			f.server.ServeHTTP(w, jobGitRequest(credential.GitToken, "git-upload-pack", runnerGitFetch(f.commit)))
			if forwards != 1 {
				t.Fatal("native effects", forwards, w.Code, w.Body.String())
			}
			if scenario == "success" {
				if w.Code != 200 || w.Body.String() != "private job pack" || w.Header().Get("Golf-Job-Instance") != job.InstanceID || w.Header().Get("Golf-Source-Commit") != f.commit {
					t.Fatal("job read receipt", w.Code, w.Body.String())
				}
				// The initial capability explicitly includes native repository ref
				// discovery. Seeing a different object ID does not grant its fetch.
				discovery := httptest.NewRecorder()
				f.server.ServeHTTP(discovery, jobGitRequest(credential.GitToken, "info/refs?service=git-upload-pack", nil))
				foreign := strings.Repeat("f", 40)
				if discovery.Code != 200 || !strings.Contains(discovery.Body.String(), foreign+" refs/heads/other-private-branch") || forwards != 2 {
					t.Fatal("native ref discovery scope", discovery.Code, forwards)
				}
				wrong := httptest.NewRecorder()
				f.server.ServeHTTP(wrong, jobGitRequest(credential.GitToken, "git-upload-pack", runnerGitFetch(foreign)))
				if wrong.Code != 400 || forwards != 2 || strings.Contains(wrong.Body.String(), "private job pack") {
					t.Fatal("foreign object fetch escaped admitted H", wrong.Code, forwards)
				}
				other := jobGitRequest(credential.GitToken, "info/refs?service=git-upload-pack", nil)
				other.URL.Path = "/alice/other/info/refs"
				cross := httptest.NewRecorder()
				f.server.ServeHTTP(cross, other)
				if cross.Code != 400 || forwards != 2 || strings.Contains(cross.Body.String(), "other-private-branch") {
					t.Fatal("cross repository discovery", cross.Code, forwards)
				}
				// Read-only credential never authenticates enrolled-worker control.
				r := httptest.NewRequest(http.MethodPost, "/internal/ci/attempt/"+lease.AttemptID+"/heartbeat", strings.NewReader("{}"))
				r.SetBasicAuth("x-access-token", credential.GitToken)
				denied := httptest.NewRecorder()
				f.server.ServeHTTP(denied, r)
				if denied.Code != 401 {
					t.Fatal("job token authorized worker control", denied.Code)
				}
			} else if w.Code == 200 || strings.Contains(w.Body.String(), "private job pack") || w.Header().Get("Golf-Source-Commit") != "" {
				t.Fatal("revoked private output released", w.Code, w.Body.String())
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("failure caching")
			}
			if scenario == "job-finish" {
				if refused := jobGitIssue(t, f, lease, job.InstanceID); refused.Code != 403 {
					t.Fatal("finished job reissued", refused.Code)
				}
				refused := httptest.NewRecorder()
				f.server.ServeHTTP(refused, jobGitRequest(credential.GitToken, "git-upload-pack", runnerGitFetch(f.commit)))
				if refused.Code != 401 || forwards != 1 || strings.Contains(refused.Body.String(), "private job pack") {
					t.Fatal("finished job reached native Git", refused.Code, forwards)
				}
			}
		})
	}
}

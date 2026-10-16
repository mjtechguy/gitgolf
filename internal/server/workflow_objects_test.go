package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/objectstore"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// This is an HTTP S3 boundary fixture with real SDK signing and real PostgreSQL.
// Native conditional-provider behavior is independently tested against RustFS in
// internal/objectstore; this fixture makes private waits and corruption precise.
type workflowObjectFixture struct {
	server     *httptest.Server
	mu         sync.Mutex
	objects    map[string][]byte
	gets, puts int
	readMode   string
	before     func(string)
}

func newWorkflowObjectFixture(t *testing.T) *workflowObjectFixture {
	t.Helper()
	f := &workflowObjectFixture{objects: map[string][]byte{}}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=object-test-access/") {
			t.Error("object request did not use signed operator credentials")
			w.WriteHeader(403)
			return
		}
		f.mu.Lock()
		before := f.before
		f.mu.Unlock()
		if before != nil {
			before(r.Method)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.Method {
		case "HEAD":
			w.WriteHeader(200)
		case "PUT":
			f.puts++
			if r.Header.Get("If-None-Match") != "*" {
				t.Error("source upload lost conditional-create header")
				w.WriteHeader(400)
				return
			}
			if _, ok := f.objects[r.URL.Path]; ok {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(412)
				io.WriteString(w, "<Error><Code>PreconditionFailed</Code></Error>")
				return
			}
			data, e := io.ReadAll(io.LimitReader(r.Body, objectstore.MaxSourceBytes+1))
			if e != nil || int64(len(data)) > objectstore.MaxSourceBytes {
				w.WriteHeader(400)
				return
			}
			f.objects[r.URL.Path] = data
			w.WriteHeader(200)
		case "GET":
			f.gets++
			data, ok := f.objects[r.URL.Path]
			if !ok {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(404)
				io.WriteString(w, "<Error><Code>NoSuchKey</Code></Error>")
				return
			}
			switch f.readMode {
			case "hash":
				data = []byte("tampered private source")
			case "truncated":
				w.Header().Set("Content-Length", strconv.Itoa(len(data)+5))
			}
			w.Write(data)
		default:
			w.WriteHeader(405)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}
func (f *workflowObjectFixture) config(bucket string) objectstore.Config {
	return objectstore.Config{Endpoint: f.server.URL, Bucket: bucket, Region: "us-east-1", Prefix: "golf", PathStyle: true, AllowHTTP: true, AccessKeyID: "object-test-access", SecretAccessKey: "object-test-secret"}
}
func bindWorkflowObjectFixture(t *testing.T, f *workflowRunFixture, objects *workflowObjectFixture) {
	t.Helper()
	f.server.config.ObjectStoreConfig = objects.config("golf-sources")
	if err := f.server.configureObjectStore(t.Context()); err != nil {
		t.Fatal(err)
	}
}
func objectRunnerCall(s *Server, method, route, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, route, strings.NewReader(body))
	req.Header.Set("Golf-Runner-ID", "fixture")
	req.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	if token != "" {
		req.Header.Set("Golf-Attempt-Token", token)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}
func objectLease(t *testing.T, f *workflowRunFixture) (string, string) {
	t.Helper()
	rec := objectRunnerCall(f.server, "POST", "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`)
	if rec.Code != 200 {
		t.Fatal("runner assignment failed", rec.Code)
	}
	var value struct {
		AttemptID    string `json:"attemptId"`
		AttemptToken string `json:"attemptToken"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &value) != nil || value.AttemptID == "" {
		t.Fatal("invalid assignment")
	}
	for _, secret := range []string{"object-test-secret", "object-test-access", "golf-sources", "encrypted_credential"} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatal("object credentials or storage internals leaked into assignment")
		}
	}
	return "/internal/ci/attempt/" + value.AttemptID + "/source", value.AttemptToken
}
func objectDigest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func TestWorkflowObjectBindingAndRunnerReadPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	objects := newWorkflowObjectFixture(t)
	bindWorkflowObjectFixture(t, f, objects)
	f.enable(t)
	dispatched, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.server.loadWorkflowRun(t.Context(), dispatched.Msg.Run.Id)
	if err != nil {
		t.Fatal(err)
	}
	if run.SourceStorage != "env_s3" || run.SourceKey != "ci-sources/"+run.SourceSHA256+".tar" || run.SourceFingerprint != objectStoreFingerprint(f.server.config.ObjectStoreConfig) || run.SourceProfileID.Valid {
		t.Fatal("durable source binding missing")
	}
	var absent bool
	var plan []byte
	if err = f.server.db.QueryRowContext(t.Context(), `SELECT source_archive IS NULL,plan FROM golf_workflow_runs WHERE id=$1`, run.ID).Scan(&absent, &plan); err != nil || !absent {
		t.Fatal("object source retained a PostgreSQL archive copy", err)
	}
	if bytes.Contains(plan, []byte("object-test-secret")) || bytes.Contains(plan, []byte("object-test-access")) {
		t.Fatal("operator credentials embedded in plan")
	}
	original, err := f.server.workflowSourceObject(t.Context(), run)
	if err != nil || objectDigest(original) != run.SourceSHA256 {
		t.Fatal("source binding failed", err)
	}
	changed := f.server.config.ObjectStoreConfig
	changed.SecretAccessKey = "replacement-credential"
	if objectStoreFingerprint(changed) != run.SourceFingerprint {
		t.Fatal("credential rotation stranded object locator")
	}
	changed.Bucket = "another-bucket"
	f.server.config.ObjectStoreConfig = changed
	if err = f.server.configureObjectStore(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err = f.server.workflowSourceObject(t.Context(), run); !errors.Is(err, errInfrastructureConflict) {
		t.Fatal("environment destination change silently rebound old source")
	}
	bindWorkflowObjectFixture(t, f, objects)
	route, token := objectLease(t, f)
	objects.mu.Lock()
	before := objects.gets
	objects.mu.Unlock()
	response := objectRunnerCall(f.server, "GET", route, token, "")
	if response.Code != 200 || !bytes.Equal(response.Body.Bytes(), original) || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("verified private source failed", response.Code)
	}
	objects.mu.Lock()
	count := objects.gets - before
	objects.mu.Unlock()
	if count != 1 {
		t.Fatal("source was fetched more than once, possibly under SQL locks", count)
	}
	for _, mode := range []string{"hash", "truncated"} {
		objects.mu.Lock()
		objects.readMode = mode
		objects.mu.Unlock()
		response = objectRunnerCall(f.server, "GET", route, token, "")
		if response.Code != 503 || bytes.Contains(response.Body.Bytes(), []byte("ordinary source")) || bytes.Contains(response.Body.Bytes(), []byte("tampered private")) {
			t.Fatal("invalid object reached runner", mode, response.Code)
		}
	}
}

func TestWorkflowObjectWaitAllowsRevocationPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	objects := newWorkflowObjectFixture(t)
	bindWorkflowObjectFixture(t, f, objects)
	f.enable(t)
	dispatched, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	route, token := objectLease(t, f)
	entered, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(resume) }) })
	objects.mu.Lock()
	objects.before = func(method string) {
		if method == "GET" {
			select {
			case entered <- struct{}{}:
			case <-resume:
				return
			}
			<-resume
		}
	}
	objects.mu.Unlock()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- objectRunnerCall(f.server, "GET", route, token, "") }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("source did not enter bounded object wait")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	tx, err := f.server.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	// These locks must remain obtainable while object storage is waiting.
	for _, query := range []string{`SELECT id FROM golf_users FOR UPDATE NOWAIT`, `SELECT session_id FROM golf_sessions FOR UPDATE NOWAIT`, `SELECT id FROM golf_workflow_runs FOR UPDATE NOWAIT`, `SELECT revision FROM golf_execution_policies FOR UPDATE NOWAIT`} {
		if _, e := tx.ExecContext(ctx, query); e != nil {
			tx.Rollback()
			t.Fatal("object wait held authority locks", e)
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE golf_execution_policies SET manual_dispatch_enabled=false,revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE scope='repository'`); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	once.Do(func() { close(resume) })
	select {
	case response := <-done:
		if response.Code != 403 || bytes.Contains(response.Body.Bytes(), []byte("ordinary source")) {
			t.Fatal("revoked policy disclosed source after wait", response.Code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("revoked source read did not finish")
	}
	run, err := f.server.loadWorkflowRun(t.Context(), dispatched.Msg.Run.Id)
	if err != nil || run.State != "cancelled" {
		t.Fatal("late policy revocation failed to fence attempt", err)
	}
}

func TestWorkflowObjectDispatchPostWaitAuthorityPostgres(t *testing.T) {
	for _, kind := range []string{"repository", "policy", "session"} {
		t.Run(kind, func(t *testing.T) {
			f := newWorkflowRunFixture(t)
			objects := newWorkflowObjectFixture(t)
			bindWorkflowObjectFixture(t, f, objects)
			f.enable(t)
			entered, resume := make(chan struct{}), make(chan struct{})
			var once sync.Once
			t.Cleanup(func() { once.Do(func() { close(resume) }) })
			objects.mu.Lock()
			objects.before = func(method string) {
				if method == "PUT" {
					select {
					case entered <- struct{}{}:
					case <-resume:
						return
					}
					<-resume
				}
			}
			objects.mu.Unlock()
			done := make(chan error, 1)
			go func() { _, e := f.dispatch(t, "12345678-1234-4234-8234-123456789abc"); done <- e }()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("dispatch did not reach source upload")
			}
			switch kind {
			case "repository":
				f.mu.Lock()
				f.permission = "read"
				f.mu.Unlock()
			case "policy":
				_, err := f.server.db.ExecContext(t.Context(), `UPDATE golf_execution_policies SET manual_dispatch_enabled=false,revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE scope='repository'`)
				if err != nil {
					t.Fatal(err)
				}
			case "session":
				if err := f.server.logoutSession(t.Context(), f.session.Value); err != nil {
					t.Fatal(err)
				}
			}
			once.Do(func() { close(resume) })
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("late authority change admitted execution")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("dispatch did not finish")
			}
			var runs int
			if err := f.server.db.QueryRowContext(t.Context(), `SELECT count(*) FROM golf_workflow_runs`).Scan(&runs); err != nil || runs != 0 {
				t.Fatal("denied upload created runnable SQL state", err)
			}
		})
	}
}

func objectProfile(objects *workflowObjectFixture, bucket string) *golfv1.InfrastructureConnection {
	return &golfv1.InfrastructureConnection{Label: "Private source bucket", Kind: "OBJECT_STORAGE", Backend: "RUSTFS", Endpoint: objects.server.URL, Region: "us-east-1", Bucket: bucket, Prefix: "golf", PathStyle: true, AllowInsecure: true}
}
func saveObjectProfile(t *testing.T, f *managementFixture, session loginResult, profile *golfv1.InfrastructureConnection, version string) *golfv1.InfrastructureConnection {
	t.Helper()
	rec := infrastructureRequest(f.s, session, "SaveInfrastructureConnection", &golfv1.SaveInfrastructureConnectionRequest{Connection: profile, ExpectedVersion: version, Credential: &golfv1.InfrastructureConnectionCredential{AccessKeyId: "object-test-access", SecretAccessKey: "object-test-secret"}, PasswordConfirmation: localTestPassword})
	if rec.Code != 200 {
		t.Fatal("object profile save failed", rec.Code, rec.Body.String())
	}
	var result golfv1.SaveInfrastructureConnectionResponse
	if protojson.Unmarshal(rec.Body.Bytes(), &result) != nil {
		t.Fatal("invalid profile response")
	}
	return result.Connection
}
func activateObjectProfile(f *managementFixture, session loginResult, profile *golfv1.InfrastructureConnection, revision, password string) *httptest.ResponseRecorder {
	return infrastructureRequest(f.s, session, "ActivateInfrastructureConnection", &golfv1.ActivateInfrastructureConnectionRequest{Id: profile.Id, ExpectedVersion: profile.Version, ExpectedActiveRevision: revision, PasswordConfirmation: password})
}
func bindingRecord(binding objectStorageBinding, source []byte) workflowRunRecord {
	return workflowRunRecord{SourceStorage: binding.Storage, SourceKey: binding.Key, SourceFingerprint: binding.Fingerprint, SourceProfileID: binding.ProfileID, SourceProfileVersion: binding.ProfileVersion, SourceSHA256: objectDigest(source)}
}

func TestWorkflowObjectProfileActivationHistoryPostgres(t *testing.T) {
	f := newManagementFixture(t)
	objects := newWorkflowObjectFixture(t)
	enrollLocal(t, f, "alice", true)
	enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	member := localLogin(t, f, "bob")
	original := saveObjectProfile(t, f, admin, objectProfile(objects, "original-bucket"), "0")
	for _, session := range []loginResult{member, f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")} {
		if rec := activateObjectProfile(f, session, original, "0", localTestPassword); rec.Code != 403 {
			t.Fatal("native or member authority changed global storage", rec.Code)
		}
	}
	if rec := activateObjectProfile(f, admin, original, "0", "Wrong independent password 42!"); rec.Code == 200 {
		t.Fatal("activation skipped own-password confirmation")
	}
	if rec := activateObjectProfile(f, admin, original, "0", localTestPassword); rec.Code != 200 {
		t.Fatal("activation failed", rec.Code, rec.Body.String())
	}
	source := []byte("historical workflow source")
	binding, err := f.s.storeWorkflowSource(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	if binding.Storage != "profile_s3" || binding.ProfileID.String != original.Id || binding.ProfileVersion.Int64 != 1 || len(binding.Archive) != 0 {
		t.Fatal("profile source binding not pinned")
	}
	changed := proto.Clone(original).(*golfv1.InfrastructureConnection)
	changed.Bucket = "new-bucket"
	updated := saveObjectProfile(t, f, admin, changed, "1")
	if rec := activateObjectProfile(f, admin, original, "1", localTestPassword); rec.Code == 200 {
		t.Fatal("stale profile version activated")
	}
	if rec := activateObjectProfile(f, admin, updated, "0", localTestPassword); rec.Code == 200 {
		t.Fatal("stale active-revision CAS replaced current destination")
	}
	if rec := activateObjectProfile(f, admin, updated, "1", localTestPassword); rec.Code != 200 {
		t.Fatal("updated profile activation failed", rec.Code)
	}
	got, err := f.s.workflowSourceObject(t.Context(), bindingRecord(binding, source))
	if err != nil || !bytes.Equal(got, source) {
		t.Fatal("new active bucket reinterpreted historical profile locator", err)
	}
	next, err := f.s.storeWorkflowSource(t.Context(), source)
	if err != nil || next.ProfileVersion.Int64 != 2 {
		t.Fatal("new source failed to use active profile version", err)
	}
	var revision, events int64
	if err = f.db.QueryRow(`SELECT revision,(SELECT count(*) FROM golf_infrastructure_activation_events) FROM golf_active_object_connection WHERE singleton`).Scan(&revision, &events); err != nil || revision != 2 || events != 2 {
		t.Fatal("activation CAS/audit count diverged", err)
	}
	sessionID, userID, _ := f.id(t, admin)
	var actorSession, actorUser int64
	if err = f.db.QueryRow(`SELECT actor_session_id,actor_user_id FROM golf_infrastructure_activation_events WHERE revision=2`).Scan(&actorSession, &actorUser); err != nil || actorSession != sessionID || actorUser != userID {
		t.Fatal("activation evidence lost initiating local admin")
	}
	rows, err := f.db.Query(`SELECT config,encrypted_credential FROM golf_infrastructure_connection_versions`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var metadata, cipher []byte
		if rows.Scan(&metadata, &cipher) != nil {
			t.Fatal("credential storage read failed")
		}
		for _, secret := range []string{"object-test-secret", "object-test-access"} {
			if bytes.Contains(metadata, []byte(secret)) || bytes.Contains(cipher, []byte(secret)) {
				t.Fatal("profile persisted plaintext credentials")
			}
		}
	}
	if rows.Err() != nil {
		t.Fatal(rows.Err())
	}
	if _, err = f.db.Exec(`UPDATE golf_infrastructure_activation_events SET revision=revision WHERE revision=1`); err == nil {
		t.Fatal("activation audit history mutable")
	}
}

func TestWorkflowObjectActivationAtomicAuditPostgres(t *testing.T) {
	f := newManagementFixture(t)
	objects := newWorkflowObjectFixture(t)
	enrollLocal(t, f, "alice", true)
	admin := localLogin(t, f, "alice")
	profile := saveObjectProfile(t, f, admin, objectProfile(objects, "atomic-bucket"), "0")
	_, err := f.db.Exec(`CREATE FUNCTION golf_test_reject_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejects activation evidence'; END $$; CREATE TRIGGER golf_test_reject_activation BEFORE INSERT ON golf_infrastructure_activation_events FOR EACH STATEMENT EXECUTE FUNCTION golf_test_reject_activation()`)
	if err != nil {
		t.Fatal(err)
	}
	if rec := activateObjectProfile(f, admin, profile, "0", localTestPassword); rec.Code == 200 {
		t.Fatal("pointer activation survived evidence failure")
	}
	var revision, count int64
	var unbound bool
	if err = f.db.QueryRow(`SELECT revision,profile_id IS NULL,(SELECT count(*) FROM golf_infrastructure_activation_events) FROM golf_active_object_connection WHERE singleton`).Scan(&revision, &unbound, &count); err != nil || revision != 0 || !unbound || count != 0 {
		t.Fatal("activation and evidence did not roll back together", err)
	}
}

func TestWorkflowObjectActivationPostWaitAdminPostgres(t *testing.T) {
	f := newManagementFixture(t)
	objects := newWorkflowObjectFixture(t)
	enrollLocal(t, f, "alice", true)
	admin := localLogin(t, f, "alice")
	profile := saveObjectProfile(t, f, admin, objectProfile(objects, "admin-bucket"), "0")
	entered, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(resume) }) })
	objects.mu.Lock()
	objects.before = func(method string) {
		if method == "PUT" {
			select {
			case entered <- struct{}{}:
			case <-resume:
				return
			}
			<-resume
		}
	}
	objects.mu.Unlock()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- activateObjectProfile(f, admin, profile, "0", localTestPassword) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("activation did not reach remote probe")
	}
	// The supported operator disable invalidates this local administrator session.
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "disable", LocalAccountInput{Username: "alice"}); err != nil {
		t.Fatal("remote probe blocked local administrator disable", err)
	}
	once.Do(func() { close(resume) })
	select {
	case rec := <-done:
		if rec.Code == 200 {
			t.Fatal("revoked global admin activated destination")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("activation did not finish")
	}
	var revision int64
	if err := f.db.QueryRow(`SELECT revision FROM golf_active_object_connection WHERE singleton`).Scan(&revision); err != nil || revision != 0 {
		t.Fatal("late admin denial changed pointer", err)
	}
}

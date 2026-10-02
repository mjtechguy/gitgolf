package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func infrastructureRequest(s *Server, session loginResult, method string, body proto.Message) *httptest.ResponseRecorder {
	data, _ := protojson.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/rpc/golf.v1.InfrastructureConnectionService/"+method, bytes.NewReader(data))
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
func testInfrastructureDatabase() *golfv1.InfrastructureConnection {
	return &golfv1.InfrastructureConnection{Label: "Remote Golf database", Kind: "DATABASE", DatabaseRole: "GOLF", Backend: "POSTGRESQL", Endpoint: "127.0.0.1:1", TlsMode: "disable", AllowInsecure: true, DatabaseName: "golf", DatabaseUser: "golf"}
}
func TestInfrastructureValidation(t *testing.T) {
	if _, err := validateInfrastructureConnection(testInfrastructureDatabase()); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"credential-url", "insecure", "unknown-backend", "object-fields"} {
		p := testInfrastructureDatabase()
		switch field {
		case "credential-url":
			p.Endpoint = "postgres://private:secret@host/golf"
		case "insecure":
			p.AllowInsecure = false
		case "unknown-backend":
			p.Backend = "SQLITE"
		case "object-fields":
			p.Bucket = "golf"
		}
		if _, err := validateInfrastructureConnection(p); err == nil {
			t.Fatal("invalid connection accepted", field)
		}
	}
	c, err := validateInfrastructureConnection(&golfv1.InfrastructureConnection{Label: "Local RustFS", Kind: "OBJECT_STORAGE", Backend: "RUSTFS", Endpoint: "http://rustfs:9000", Region: "us-east-1", Bucket: "golf", Prefix: "golf/", AllowInsecure: true, PathStyle: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = validateInfrastructureSecret(c, &golfv1.InfrastructureConnectionCredential{AccessKeyId: "private-access", SecretAccessKey: "private-secret"}); err != nil {
		t.Fatal(err)
	}
	if _, err = validateInfrastructureSecret(c, &golfv1.InfrastructureConnectionCredential{DatabasePassword: "wrong-kind"}); err == nil {
		t.Fatal("mixed credentials accepted")
	}
	keys, err := ParseKeyring(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{5}, 32)), "", "")
	if err != nil {
		t.Fatal(err)
	}
	binding := infrastructureBinding("12345678-1234-4234-8234-123456789abc", 1)
	encrypted, keyID, err := keys.seal(infrastructureConnectionDomain, "private-secret", binding)
	if err != nil {
		t.Fatal(err)
	}
	for _, other := range [][]byte{infrastructureBinding("12345678-1234-4234-8234-123456789abc", 2), infrastructureBinding("12345678-1234-4234-8234-123456789abd", 1)} {
		if _, err := keys.open(keyID, infrastructureConnectionDomain, encrypted, other); err == nil {
			t.Fatal("credential transplanted across immutable versions")
		}
	}
	if _, err := keys.open(keyID, sessionDomain, encrypted, binding); err == nil {
		t.Fatal("credential domain downgrade accepted")
	}
}
func TestInfrastructureProfileHistoryPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	member := localLogin(t, f, "bob")
	save := &golfv1.SaveInfrastructureConnectionRequest{Connection: testInfrastructureDatabase(), ExpectedVersion: "0", Credential: &golfv1.InfrastructureConnectionCredential{DatabasePassword: "private-database-password"}, PasswordConfirmation: localTestPassword}
	for _, session := range []loginResult{member, f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")} {
		if r := infrastructureRequest(f.s, session, "SaveInfrastructureConnection", save); r.Code != 403 {
			t.Fatal("foreign admin authority accepted", r.Code, r.Body.String())
		}
	}
	r := infrastructureRequest(f.s, admin, "SaveInfrastructureConnection", save)
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	var created golfv1.SaveInfrastructureConnectionResponse
	if err := protojson.Unmarshal(r.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Connection.ActivationState != "saved_not_active" || created.Connection.Version != "1" || !created.Connection.HasCredential || strings.Contains(r.Body.String(), "private-database-password") {
		t.Fatal("saved profile misrepresented activation or exposed secret")
	}
	first, err := f.s.loadInfrastructureConnection(t.Context(), created.Connection.Id, 1)
	if err != nil {
		t.Fatal(err)
	}
	replacement := proto.Clone(save).(*golfv1.SaveInfrastructureConnectionRequest)
	replacement.Connection.Id = created.Connection.Id
	replacement.Connection.Endpoint = "localhost:2"
	replacement.ExpectedVersion = "1"
	replacement.Credential = nil
	replacement.RetainCredential = true
	r = infrastructureRequest(f.s, admin, "SaveInfrastructureConnection", replacement)
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	latest, err := f.s.loadInfrastructureConnection(t.Context(), created.Connection.Id, 2)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := f.s.keyring.open(latest.CredentialKeyID, infrastructureConnectionDomain, latest.EncryptedCredential, latest.CredentialBinding)
	if err != nil || !strings.Contains(plain, "private-database-password") {
		t.Fatal("credential retention lost version binding", err)
	}
	preserved, err := f.s.loadInfrastructureConnection(t.Context(), first.ID, 1)
	if err != nil || preserved.Config.Endpoint != first.Config.Endpoint || !bytes.Equal(preserved.EncryptedCredential, first.EncryptedCredential) {
		t.Fatal("save rewrote original immutable source configuration", err)
	}
	if r = infrastructureRequest(f.s, admin, "SaveInfrastructureConnection", replacement); r.Code == 200 {
		t.Fatal("stale CAS created a version")
	}
	if _, err := f.db.Exec(`UPDATE golf_infrastructure_connection_versions SET config='{}' WHERE profile_id=$1`, first.ID); err == nil {
		t.Fatal("historical configuration mutation accepted")
	}
	r = infrastructureRequest(f.s, admin, "ListInfrastructureConnections", &golfv1.ListInfrastructureConnectionsRequest{})
	if r.Code != 200 || strings.Contains(r.Body.String(), "private-database-password") || strings.Contains(r.Body.String(), "encryptedCredential") {
		t.Fatal("list disclosed private credential", r.Code)
	}
	r = infrastructureRequest(f.s, admin, "TestInfrastructureConnection", &golfv1.TestInfrastructureConnectionRequest{Id: first.ID, ExpectedVersion: "2", PasswordConfirmation: localTestPassword})
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	var probe golfv1.TestInfrastructureConnectionResponse
	if err := protojson.Unmarshal(r.Body.Bytes(), &probe); err != nil {
		t.Fatal(err)
	}
	if probe.Accessible || probe.ResultCode != "connection_failed" || probe.QualificationScope != "postgresql_ping_no_migrations" || strings.Contains(r.Body.String(), "localhost") {
		t.Fatal("failed connection leaked provider details or fabricated success")
	}
	material := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	keys, err := ParseKeyring(f.s.config.EncryptionKey, `{"next":"`+material+`"}`, "next")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ActivateKey(t.Context(), f.db, keys); err != nil {
		t.Fatal(err)
	}
	result, err := RotateCredentials(t.Context(), f.db, keys, 100, 10)
	if err != nil || !result.Complete || result.RotatedInfrastructureConnections != 2 {
		t.Fatal("historical infrastructure credentials missed rotation", err)
	}
	rotated, err := f.s.loadInfrastructureConnection(t.Context(), first.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := keys.open(rotated.CredentialKeyID, infrastructureConnectionDomain, rotated.EncryptedCredential, rotated.CredentialBinding); err != nil {
		t.Fatal("rotation changed immutable credential binding", err)
	}
	var credentials map[string]string
	if json.Unmarshal([]byte(plain), &credentials) != nil {
		t.Fatal("invalid stored credential JSON")
	}
	if _, err = KeyStatus(context.Background(), f.db, keys); err != nil {
		t.Fatal(err)
	}
}

func TestInfrastructureDatabasePingPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	admin := localLogin(t, f, "alice")
	source, err := url.Parse(os.Getenv("GOLF_TEST_DATABASE_URL"))
	if err != nil || source.User == nil {
		t.Fatal("isolated qualification database URI required")
	}
	password, _ := source.User.Password()
	config := testInfrastructureDatabase()
	config.Endpoint = source.Host
	config.DatabaseName = strings.TrimPrefix(source.Path, "/")
	config.DatabaseUser = source.User.Username()
	save := infrastructureRequest(f.s, admin, "SaveInfrastructureConnection", &golfv1.SaveInfrastructureConnectionRequest{Connection: config, ExpectedVersion: "0", Credential: &golfv1.InfrastructureConnectionCredential{DatabasePassword: password}, PasswordConfirmation: localTestPassword})
	if save.Code != 200 {
		t.Fatal("isolated database profile save failed", save.Code)
	}
	var result golfv1.SaveInfrastructureConnectionResponse
	if err := protojson.Unmarshal(save.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	check := infrastructureRequest(f.s, admin, "TestInfrastructureConnection", &golfv1.TestInfrastructureConnectionRequest{Id: result.Connection.Id, ExpectedVersion: "1", PasswordConfirmation: localTestPassword})
	if check.Code != 200 {
		t.Fatal("isolated database test failed", check.Code)
	}
	var tested golfv1.TestInfrastructureConnectionResponse
	if err := protojson.Unmarshal(check.Body.Bytes(), &tested); err != nil {
		t.Fatal(err)
	}
	if !tested.Accessible || tested.ResultCode != "accessible" || tested.QualificationScope != "postgresql_ping_no_migrations" {
		t.Fatal("actual PostgreSQL Ping was not confirmed")
	}
	if bytes.Contains(check.Body.Bytes(), []byte(password)) || bytes.Contains(save.Body.Bytes(), []byte(password)) {
		t.Fatal("database password disclosed")
	}
}

func TestInfrastructureBrowserBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"ListInfrastructureConnections", "SaveInfrastructureConnection", "TestInfrastructureConnection", "ActivateInfrastructureConnection"} {
		route := "/golf.v1.InfrastructureConnectionService/" + method
		request := httptest.NewRequest("POST", "/rpc"+route, strings.NewReader("{}"))
		request.Header.Set("Origin", s.config.PublicURL)
		request.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, request)
		if rec.Code != 401 || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("missing cookie boundary", method, rec.Code)
		}
		request = httptest.NewRequest("POST", "/rpc"+route, strings.NewReader("{}"))
		request.Header.Set("Origin", "https://other.invalid")
		request.Header.Set("Content-Type", "application/json")
		rec = httptest.NewRecorder()
		s.ServeHTTP(rec, request)
		if rec.Code != 403 {
			t.Fatal("origin boundary", method, rec.Code)
		}
		if rec := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), route, "{}"); rec.Code != 403 {
			t.Fatal("delegated infrastructure authority", method, rec.Code)
		}
	}
}

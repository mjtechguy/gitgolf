package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Exercise the public /rpc routing boundary as well as the generated handlers.
// Direct RPC calls alone cannot detect an omitted outer allowlist entry.
func positiveSettingsTransport(t *testing.T, s *Server, cookie, procedure string, input, output proto.Message, status int, code string) []byte {
	t.Helper()
	body, err := protojson.Marshal(input)
	if err != nil {
		t.Fatal("encode owned settings request")
	}
	r := httptest.NewRequest(http.MethodPost, "/rpc"+procedure, bytes.NewReader(body))
	r.Header.Set("Cookie", cookie)
	r.Header.Set("Origin", s.config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != status || w.Header().Get("Cache-Control") != "no-store" || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("settings transport %s: status %d, expected %d with private JSON", procedure, w.Code, status)
	}
	if status == http.StatusOK {
		if output == nil || protojson.Unmarshal(w.Body.Bytes(), output) != nil {
			t.Fatal("decode exact settings transport receipt")
		}
	} else {
		var failure struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(w.Body.Bytes(), &failure) != nil || failure.Code != code {
			t.Fatal("missing closed settings error code")
		}
	}
	return bytes.Clone(w.Body.Bytes())
}

func TestSettingsPositiveManagedGitOuterTransportPostgres(t *testing.T) {
	f := newGitTransportFixture(t)
	cookie := f.server.sessionCookie(f.session.Value, f.session.Expires, 3600).String()
	key := &golfv1.RepositoryKey{Owner: "alice", Name: "example"}
	info := &golfv1.GetGitTransportResponse{}
	positiveSettingsTransport(t, f.server, cookie, golfv1connect.GitTransportServiceGetGitTransportProcedure, &golfv1.GetGitTransportRequest{Repository: key, RepositoryId: "91", OwnerId: "42"}, info, 200, "")
	if !info.Enabled || !info.ReadCredentialAvailable || info.WriteCredentialAvailable || info.RepositoryId != "91" || info.OwnerId != "42" || !proto.Equal(info.Repository, key) || info.CloneUrl != "http://127.0.0.1:8080/git/alice/example.git" {
		t.Fatal("managed transport observation is not exact or READ-only")
	}
	list := &golfv1.ListGitCredentialsResponse{}
	listRequest := &golfv1.ListGitCredentialsRequest{Repository: key, RepositoryId: "91", OwnerId: "42", Page: &golfv1.PageRequest{Page: 1, Limit: 20}}
	positiveSettingsTransport(t, f.server, cookie, golfv1connect.GitTransportServiceListGitCredentialsProcedure, listRequest, list, 200, "")
	if len(list.Credentials) != 0 || list.Page == nil || list.Page.NextPage != 0 {
		t.Fatal("fresh own credential inventory is not empty and complete")
	}
	created := &golfv1.CreateGitCredentialResponse{}
	positiveSettingsTransport(t, f.server, cookie, golfv1connect.GitTransportServiceCreateGitCredentialProcedure, &golfv1.CreateGitCredentialRequest{Repository: key, RepositoryId: "91", OwnerId: "42", Label: "HTTP-bound READ", Mode: golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_READ, LifetimeSeconds: 3600}, created, 200, "")
	if created.Credential == nil || created.Credential.Id == "" || created.Credential.RepositoryId != "91" || created.Credential.OwnerId != "42" || created.Credential.Mode != golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_READ || !created.Credential.SourceSessionActive || created.Credential.SourceSessionId == "" {
		t.Fatal("created READ credential lacks the original repository/session receipt")
	}
	if _, err := gitTokenHash(created.Secret); err != nil {
		t.Fatal("wrong opaque capability namespace")
	}
	list = &golfv1.ListGitCredentialsResponse{}
	inventory := positiveSettingsTransport(t, f.server, cookie, golfv1connect.GitTransportServiceListGitCredentialsProcedure, listRequest, list, 200, "")
	if len(list.Credentials) != 1 || list.Credentials[0].Id != created.Credential.Id || bytes.Contains(inventory, []byte(created.Secret)) || bytes.Contains(inventory, []byte(f.credential.Token)) {
		t.Fatal("own inventory identity or credential privacy failed")
	}
	// The outer smart-HTTP route must also reach its supported native consumer.
	advertise := func(status int) []byte {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/git/alice/example.git/info/refs?service=git-upload-pack", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.SetBasicAuth("golf", created.Secret)
		w := httptest.NewRecorder()
		f.server.ServeHTTP(w, r)
		if w.Code != status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("outer READ Git transport or private-cache boundary failed")
		}
		return bytes.Clone(w.Body.Bytes())
	}
	if !bytes.Equal(advertise(200), append(managedPacket("# service=git-upload-pack\n"), []byte("0000")...)) || f.forwards.Load() != 1 {
		t.Fatal("authorized advertisement did not reach exactly one supported native read")
	}
	revoked := &golfv1.RevokeGitCredentialResponse{}
	positiveSettingsTransport(t, f.server, cookie, golfv1connect.GitTransportServiceRevokeGitCredentialProcedure, &golfv1.RevokeGitCredentialRequest{Repository: key, RepositoryId: "91", OwnerId: "42", CredentialId: created.Credential.Id}, revoked, 200, "")
	if !revoked.Revoked || revoked.CredentialId != created.Credential.Id {
		t.Fatal("revocation response did not bind the original credential")
	}
	gone := advertise(401)
	if f.forwards.Load() != 1 || bytes.Contains(gone, []byte(created.Secret)) || bytes.Contains(gone, []byte(f.credential.Token)) || bytes.Contains(gone, []byte("private fixture")) {
		t.Fatal("revoked capability forwarded or leaked private data")
	}
	list = &golfv1.ListGitCredentialsResponse{}
	retained := positiveSettingsTransport(t, f.server, cookie, golfv1connect.GitTransportServiceListGitCredentialsProcedure, listRequest, list, 200, "")
	if len(list.Credentials) != 1 || list.Credentials[0].Id != created.Credential.Id || list.Credentials[0].RevokedAt == "" || bytes.Contains(retained, []byte(created.Secret)) {
		t.Fatal("revocation was not retained in own metadata inventory")
	}
	missing := positiveSettingsTransport(t, f.server, cookie, golfv1connect.GitTransportServiceGetGitReceiveOutcomeProcedure, &golfv1.GetGitReceiveOutcomeRequest{Repository: key, RepositoryId: "91", OwnerId: "42", OperationId: uuid.NewString()}, nil, 404, "not_found")
	if bytes.Contains(missing, []byte(created.Secret)) || bytes.Contains(missing, []byte(f.credential.Token)) || f.posts.Load() != 0 {
		t.Fatal("missing original receive outcome leaked credentials or dispatched a native write")
	}
}

func TestSettingsPositiveOrganizationValuesOuterTransportPostgres(t *testing.T) {
	f := newOrganizationExecutionFixture(t)
	list := &golfv1.ListOrganizationExecutionValuesResponse{}
	listRequest := &golfv1.ListOrganizationExecutionValuesRequest{Target: f.target}
	positiveSettingsTransport(t, f.s, f.cookie, golfv1connect.OrganizationExecutionValueServiceListOrganizationExecutionValuesProcedure, listRequest, list, 200, "")
	if !proto.Equal(list.Target, f.target) || len(list.Values) != 0 || list.BrokerRevision != "0" || list.MaximumValues != 64 || list.MaximumSelectedRepositories != 20 {
		t.Fatal("fresh organization metadata inventory is not exact")
	}
	id := uuid.NewString()
	value := "private-variable-http-fixture"
	saveRequest := organizationExecutionSave(f, id, "0", "0", "BUILD_REGION", value)
	saveRequest.Kind = golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE
	saved := &golfv1.SaveOrganizationExecutionValueResponse{}
	mutation := positiveSettingsTransport(t, f.s, f.cookie, golfv1connect.OrganizationExecutionValueServiceSaveOrganizationExecutionValueProcedure, saveRequest, saved, 200, "")
	if saved.Operation == nil || !proto.Equal(saved.Operation.Target, f.target) || saved.Operation.OperationId != saveRequest.OperationId || saved.Operation.ItemId != id || saved.Operation.AcceptedVersion != "1" || saved.Operation.AcceptedBrokerRevision != "1" || saved.Operation.Action != "save_value" || bytes.Contains(mutation, []byte(value)) {
		t.Fatal("organization save lost exact identity or returned private content")
	}
	list = &golfv1.ListOrganizationExecutionValuesResponse{}
	inventory := positiveSettingsTransport(t, f.s, f.cookie, golfv1connect.OrganizationExecutionValueServiceListOrganizationExecutionValuesProcedure, listRequest, list, 200, "")
	if !proto.Equal(list.Target, f.target) || list.BrokerRevision != "1" || len(list.Values) != 1 || list.Values[0].Value == nil || list.Values[0].Value.Id != id || list.Values[0].Value.Version != "1" || len(list.Values[0].SelectedRepositories) != 1 || list.Values[0].SelectedRepositories[0].RepositoryId != "9007199254740993" || bytes.Contains(inventory, []byte(value)) {
		t.Fatal("saved metadata inventory changed exact IDs or revealed private value")
	}
	variable := &golfv1.GetOrganizationExecutionVariableResponse{}
	positiveSettingsTransport(t, f.s, f.cookie, golfv1connect.OrganizationExecutionValueServiceGetOrganizationExecutionVariableProcedure, &golfv1.GetOrganizationExecutionVariableRequest{Target: f.target, Id: id, Version: "1"}, variable, 200, "")
	if !proto.Equal(variable.Target, f.target) || variable.Value != value || variable.Variable == nil || variable.Variable.Value == nil || variable.Variable.Value.Id != id || variable.Variable.Value.Version != "1" {
		t.Fatal("explicit exact variable read failed")
	}
	operation := &golfv1.GetOrganizationExecutionValueOperationResponse{}
	inspection := positiveSettingsTransport(t, f.s, f.cookie, golfv1connect.OrganizationExecutionValueServiceGetOrganizationExecutionValueOperationProcedure, &golfv1.GetOrganizationExecutionValueOperationRequest{Target: f.target, OperationId: saveRequest.OperationId}, operation, 200, "")
	if operation.Operation == nil || operation.Operation.ItemId != id || operation.Operation.OperationId != saveRequest.OperationId || operation.Operation.AcceptedVersion != "1" || bytes.Contains(inspection, []byte(value)) {
		t.Fatal("original operation inspection lost identity or leaked private value")
	}
	deleted := &golfv1.DeleteOrganizationExecutionValueResponse{}
	deleteRequest := &golfv1.DeleteOrganizationExecutionValueRequest{Target: f.target, Id: id, ExpectedVersion: "1", ExpectedBrokerRevision: "1", OperationId: uuid.NewString()}
	removal := positiveSettingsTransport(t, f.s, f.cookie, golfv1connect.OrganizationExecutionValueServiceDeleteOrganizationExecutionValueProcedure, deleteRequest, deleted, 200, "")
	if deleted.Operation == nil || deleted.Operation.OperationId != deleteRequest.OperationId || deleted.Operation.Action != "delete_value" || deleted.Operation.ItemId != id || deleted.Operation.AcceptedVersion != "2" || deleted.Operation.AcceptedBrokerRevision != "2" || bytes.Contains(removal, []byte(value)) {
		t.Fatal("removal did not preserve exact immutable outcome")
	}
	list = &golfv1.ListOrganizationExecutionValuesResponse{}
	tombstone := positiveSettingsTransport(t, f.s, f.cookie, golfv1connect.OrganizationExecutionValueServiceListOrganizationExecutionValuesProcedure, listRequest, list, 200, "")
	if list.BrokerRevision != "2" || len(list.Values) != 1 || list.Values[0].Value == nil || list.Values[0].Value.Id != id || !list.Values[0].Value.Deleted || list.Values[0].Value.Version != "2" || bytes.Contains(tombstone, []byte(value)) {
		t.Fatal("deleted organization value lost retained metadata or revealed content")
	}
	gone := positiveSettingsTransport(t, f.s, f.cookie, golfv1connect.OrganizationExecutionValueServiceGetOrganizationExecutionVariableProcedure, &golfv1.GetOrganizationExecutionVariableRequest{Target: f.target, Id: id, Version: "1"}, nil, 404, "not_found")
	unknown := positiveSettingsTransport(t, f.s, f.cookie, golfv1connect.OrganizationExecutionValueServiceGetOrganizationExecutionValueOperationProcedure, &golfv1.GetOrganizationExecutionValueOperationRequest{Target: f.target, OperationId: uuid.NewString()}, nil, 404, "not_found")
	if bytes.Contains(gone, []byte(value)) || bytes.Contains(unknown, []byte(value)) || bytes.Contains(gone, []byte("organization-source-only")) || bytes.Contains(unknown, []byte("organization-source-only")) {
		t.Fatal("gone variable or missing operation returned sensitive data")
	}
}

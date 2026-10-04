package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type organizationExecutionFixture struct {
	s                                           *Server
	db                                          *sql.DB
	ctx                                         context.Context
	cookie                                      string
	owner, replaceOrg, replaceRepo, foreignRepo atomic.Bool
	target                                      *golfv1.OrganizationExecutionValueTarget
}

func newOrganizationExecutionFixture(t *testing.T) *organizationExecutionFixture {
	t.Helper()
	f := &organizationExecutionFixture{db: testDatabase(t), target: &golfv1.OrganizationExecutionValueTarget{Organization: "club", OrganizationId: "73"}}
	f.owner.Store(true)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != "GET" {
			t.Error("organization broker attempted native write")
			w.WriteHeader(405)
			return
		}
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/user":
			json.NewEncoder(w).Encode(User{ID: 42, Login: "alice"})
		case "/api/v1/orgs/club/members/alice":
			w.WriteHeader(204)
		case "/api/v1/orgs/club":
			id := int64(73)
			if f.replaceOrg.Load() {
				id = 75
			}
			json.NewEncoder(w).Encode(forgeOrganization{ID: id, Name: "club", Visibility: "private"})
		case "/api/v1/users/alice/orgs/club/permissions":
			json.NewEncoder(w).Encode(map[string]bool{"is_owner": f.owner.Load()})
		case "/api/v1/users/search":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{}})
		case "/api/v1/repos/club/example/collaborators/alice/permission":
			json.NewEncoder(w).Encode(map[string]any{"permission": "owner", "user": User{ID: 42, Login: "alice"}})
		case "/api/v1/repos/club/example", "/api/v1/repositories/9007199254740993":
			row := settingsFixtureRow()
			row.Owner = &User{ID: 73, Login: "club"}
			row.FullName = "club/example"
			if f.replaceRepo.Load() {
				row.ID++
			}
			if f.foreignRepo.Load() {
				row.Owner = &User{ID: 75, Login: "elsewhere"}
			}
			data, _ := json.Marshal(row)
			var object map[string]any
			json.Unmarshal(data, &object)
			object["fork"] = false
			json.NewEncoder(w).Encode(object)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(provider.Close)
	var e error
	cfg := testConfig(provider.URL)
	f.s, e = New(cfg, f.db)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = ManageLocalAccount(t.Context(), f.db, f.s.keyring, cfg.GiteaURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "organization-source-only"}); e != nil {
		t.Fatal(e)
	}
	login, e := f.s.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	f.cookie = f.s.sessionCookie(login.Value, login.Expires, 3600).String()
	f.ctx = context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "organization-source-only", Local: true})
	return f
}
func organizationExecutionRequest[T any](f *organizationExecutionFixture, m *T) *connect.Request[T] {
	r := connect.NewRequest(m)
	r.Header().Set("Origin", f.s.config.PublicURL)
	r.Header().Set("Cookie", f.cookie)
	return r
}
func organizationExecutionSave(f *organizationExecutionFixture, id, version, broker, name, value string) *golfv1.SaveOrganizationExecutionValueRequest {
	return &golfv1.SaveOrganizationExecutionValueRequest{Target: f.target, Id: id, ExpectedVersion: version, ExpectedBrokerRevision: broker, OperationId: uuid.NewString(), Name: name, Kind: golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET, Value: &value, SelectedRepositories: []*golfv1.OrganizationExecutionRepository{{Repository: &golfv1.RepositoryKey{Owner: "club", Name: "example"}, RepositoryId: "9007199254740993"}}, ExpiresAt: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano)}
}
func TestOrganizationExecutionCRUDReceiptAndPrivacyPostgres(t *testing.T) {
	f := newOrganizationExecutionFixture(t)
	id := uuid.NewString()
	m := organizationExecutionSave(f, id, "0", "0", "BUILD_CREDENTIAL", "organization-private-secret")
	save, e := f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m))
	if e != nil || save.Msg.Operation.AcceptedVersion != "1" || save.Msg.Operation.AcceptedBrokerRevision != "1" {
		t.Fatal("create", e)
	}
	replay, e := f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m))
	if e != nil || !replay.Msg.Operation.Replayed {
		t.Fatal("exact original-key receipt", e)
	}
	changed := proto.Clone(m).(*golfv1.SaveOrganizationExecutionValueRequest)
	*changed.Value = "different-private-secret"
	if _, e = f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, changed)); e == nil {
		t.Fatal("changed same-key body accepted")
	}
	changed = proto.Clone(m).(*golfv1.SaveOrganizationExecutionValueRequest)
	changed.Value = nil
	if _, e = f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, changed)); e == nil {
		t.Fatal("same-key optional body presence changed")
	}
	changed = proto.Clone(m).(*golfv1.SaveOrganizationExecutionValueRequest)
	changed.ExpiresAt = time.Now().Add(6 * time.Minute).UTC().Format(time.RFC3339Nano)
	if _, e = f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, changed)); e == nil {
		t.Fatal("same-key share expiry changed")
	}
	inv, e := f.s.ListOrganizationExecutionValues(f.ctx, organizationExecutionRequest(f, &golfv1.ListOrganizationExecutionValuesRequest{Target: f.target}))
	if e != nil || len(inv.Msg.Values) != 1 || inv.Msg.BrokerRevision != "1" {
		t.Fatal("inventory", e)
	}
	encoded, _ := json.Marshal(inv.Msg)
	var cipher, metadata []byte
	if e = f.db.QueryRow(`SELECT encrypted_content FROM golf_organization_execution_versions WHERE id=$1`, id).Scan(&cipher); e != nil {
		t.Fatal(e)
	}
	if e = f.db.QueryRow(`SELECT request_metadata::text FROM golf_organization_execution_operations WHERE operation_id=$1`, m.OperationId).Scan(&metadata); e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(cipher, []byte(*m.Value)) || bytes.Contains(encoded, []byte(*m.Value)) || bytes.Contains(metadata, []byte(*m.Value)) {
		t.Fatal("secret escaped ciphertext/inventory/journal")
	}
	if _, e = f.s.GetOrganizationExecutionVariable(f.ctx, organizationExecutionRequest(f, &golfv1.GetOrganizationExecutionVariableRequest{Target: f.target, Id: id, Version: "1"})); e == nil {
		t.Fatal("secret revealed as variable")
	}
	empty := proto.Clone(m).(*golfv1.SaveOrganizationExecutionValueRequest)
	blank := ""
	empty.Value = &blank
	empty.OperationId = uuid.NewString()
	empty.ExpectedVersion = "1"
	empty.ExpectedBrokerRevision = "1"
	if _, e = f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, empty)); e == nil {
		t.Fatal("explicit empty replacement was treated as omitted unchanged content")
	}
	var storedExpiry time.Time
	if e = f.db.QueryRow(`SELECT expires_at FROM golf_organization_execution_versions WHERE id=$1 AND version=1`, id).Scan(&storedExpiry); e != nil {
		t.Fatal(e)
	}
	parsedExpiry, _ := time.Parse(time.RFC3339Nano, m.ExpiresAt)
	if !storedExpiry.Equal(parsedExpiry.UTC().Truncate(time.Microsecond)) {
		t.Fatal("ciphertext expiry differs from normalized stored policy")
	}
	policy := proto.Clone(m).(*golfv1.SaveOrganizationExecutionValueRequest)
	policy.OperationId = uuid.NewString()
	policy.ExpectedVersion = "1"
	policy.ExpectedBrokerRevision = "1"
	policy.Value = nil
	policy.SelectedRepositories = nil
	updated, e := f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, policy))
	if e != nil || updated.Msg.Operation.AcceptedVersion != "2" {
		t.Fatal("policy-only edit", e)
	}
	_, value, e := f.s.openOrganizationExecutionValue(f.ctx, f.db, organizationExecutionTarget{"club", 73}, id, 2)
	if e != nil || value != *m.Value {
		t.Fatal("policy edit did not retain encrypted body", e)
	}
	if _, e = f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m)); e != nil {
		t.Fatal("historic original-key replay after policy change", e)
	}
	del := &golfv1.DeleteOrganizationExecutionValueRequest{Target: f.target, Id: id, ExpectedVersion: "2", ExpectedBrokerRevision: "2", OperationId: uuid.NewString()}
	deleted, e := f.s.DeleteOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, del))
	if e != nil || deleted.Msg.Operation.AcceptedVersion != "3" {
		t.Fatal("delete", e)
	}
	if _, e = f.s.DeleteOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, del)); e != nil {
		t.Fatal("delete replay", e)
	}
	if _, e = f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m)); e != nil {
		t.Fatal("historic original-key replay after tombstone", e)
	}
	var versions, operations int
	f.db.QueryRow(`SELECT count(*) FROM golf_organization_execution_versions WHERE id=$1`, id).Scan(&versions)
	f.db.QueryRow(`SELECT count(*) FROM golf_organization_execution_operations`).Scan(&operations)
	if versions != 2 || operations != 3 {
		t.Fatal("replay or delete created extra immutable content/intent", versions, operations)
	}
	status, e := f.s.GetOrganizationExecutionValueOperation(f.ctx, organizationExecutionRequest(f, &golfv1.GetOrganizationExecutionValueOperationRequest{Target: f.target, OperationId: m.OperationId}))
	if e != nil || status.Msg.Operation.AcceptedVersion != "1" {
		t.Fatal("historic status", e)
	}
	f.owner.Store(false)
	if got, e := f.s.GetOrganizationExecutionValueOperation(f.ctx, organizationExecutionRequest(f, &golfv1.GetOrganizationExecutionValueOperationRequest{Target: f.target, OperationId: m.OperationId})); e == nil || got != nil {
		t.Fatal("private receipt after org authority loss")
	}
	if got, e := f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m)); e == nil || got != nil {
		t.Fatal("replay bypassed current org authority")
	}
}
func TestOrganizationExecutionTargetAndBoundaryPostgres(t *testing.T) {
	for _, mode := range []string{"nonowner", "replaced org", "replaced repository", "foreign repository", "origin", "bearer", "missing create body"} {
		t.Run(mode, func(t *testing.T) {
			f := newOrganizationExecutionFixture(t)
			m := organizationExecutionSave(f, uuid.NewString(), "0", "0", "BUILD_CREDENTIAL", "organization-private-secret")
			r := organizationExecutionRequest(f, m)
			switch mode {
			case "nonowner":
				f.owner.Store(false)
			case "replaced org":
				f.replaceOrg.Store(true)
			case "replaced repository":
				f.replaceRepo.Store(true)
			case "foreign repository":
				f.foreignRepo.Store(true)
			case "origin":
				r.Header().Set("Origin", "https://foreign.invalid")
			case "bearer":
				r.Header().Set("Authorization", "Bearer unsupported")
			case "missing create body":
				m.Value = nil
			}
			if got, e := f.s.SaveOrganizationExecutionValue(f.ctx, r); e == nil || got != nil {
				t.Fatal("denied save accepted", mode)
			}
			var count int
			if e := f.db.QueryRow(`SELECT count(*) FROM golf_organization_execution_values`).Scan(&count); e != nil || count != 0 {
				t.Fatal("denied request persisted value", e, count)
			}
		})
	}
}

func TestOrganizationExecutionAuthorityAfterBrokerWaitPostgres(t *testing.T) {
	f := newOrganizationExecutionFixture(t)
	blocker, e := f.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer blocker.Rollback()
	if _, e = blocker.Exec(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, f.s.config.GiteaURL+":organization-execution:73"); e != nil {
		t.Fatal(e)
	}
	m := organizationExecutionSave(f, uuid.NewString(), "0", "0", "BUILD_CREDENTIAL", "organization-private-secret")
	done := make(chan error, 1)
	go func() {
		_, e := f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m))
		done <- e
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var count int
		if e = f.db.QueryRow(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'`).Scan(&count); e != nil {
			t.Fatal(e)
		}
		if count > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("save did not reach held broker lock")
		}
		time.Sleep(5 * time.Millisecond)
	}
	f.owner.Store(false)
	if e = blocker.Rollback(); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("stale pre-wait organization ownership admitted")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("blocked save did not terminate")
	}
	var values, operations int
	f.db.QueryRow(`SELECT count(*) FROM golf_organization_execution_values`).Scan(&values)
	f.db.QueryRow(`SELECT count(*) FROM golf_organization_execution_operations`).Scan(&operations)
	if values != 0 || operations != 0 {
		t.Fatal("lost authority persisted content or accepted operation", values, operations)
	}
}

func TestOrganizationExecutionVariableCurrentVersionPostgres(t *testing.T) {
	f := newOrganizationExecutionFixture(t)
	id := uuid.NewString()
	m := organizationExecutionSave(f, id, "0", "0", "BUILD_REGION", "region-one")
	m.Kind = golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE
	if _, e := f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m)); e != nil {
		t.Fatal(e)
	}
	get := &golfv1.GetOrganizationExecutionVariableRequest{Target: f.target, Id: id, Version: "1"}
	observed, e := f.s.GetOrganizationExecutionVariable(f.ctx, organizationExecutionRequest(f, get))
	if e != nil || observed.Msg.Value != "region-one" {
		t.Fatal("current variable", e)
	}
	changed := proto.Clone(m).(*golfv1.SaveOrganizationExecutionValueRequest)
	changed.ExpectedVersion = "1"
	changed.ExpectedBrokerRevision = "1"
	changed.OperationId = uuid.NewString()
	*changed.Value = "region-two"
	if _, e = f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, changed)); e != nil {
		t.Fatal(e)
	}
	if r, e := f.s.GetOrganizationExecutionVariable(f.ctx, organizationExecutionRequest(f, get)); e == nil || r != nil {
		t.Fatal("historic variable exposed through current edit endpoint")
	}
	f.owner.Store(false)
	get.Version = "2"
	if r, e := f.s.GetOrganizationExecutionVariable(f.ctx, organizationExecutionRequest(f, get)); e == nil || r != nil {
		t.Fatal("variable exposed after actual owner loss")
	}
}

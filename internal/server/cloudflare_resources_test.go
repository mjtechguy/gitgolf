package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type cfResourceAPI struct {
	mu              sync.Mutex
	databases       map[string]string
	buckets         map[string]string
	writes, deletes int
	failD1          bool
	afterD1         func()
}

func (a *cfResourceAPI) serve(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if r.Host != "api.cloudflare.com" || r.Header.Get("Authorization") != "Bearer private-management-token" {
		w.WriteHeader(403)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/client/v4/accounts/0123456789abcdef0123456789abcdef")
	result := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": v}) }
	switch {
	case path == "/d1/database" && r.Method == "GET":
		rows := []map[string]string{}
		for id, name := range a.databases {
			if name == r.URL.Query().Get("name") {
				rows = append(rows, map[string]string{"uuid": id, "name": name})
			}
		}
		result(rows)
	case path == "/d1/database" && r.Method == "POST":
		var input struct{ Name string }
		_ = json.NewDecoder(r.Body).Decode(&input)
		id := uuid.NewString()
		a.databases[id] = input.Name
		a.writes++
		if a.afterD1 != nil {
			a.afterD1()
		}
		if a.failD1 {
			w.WriteHeader(502)
			return
		}
		result(map[string]string{"uuid": id, "name": input.Name})
	case strings.HasPrefix(path, "/d1/database/"):
		id := strings.TrimPrefix(path, "/d1/database/")
		name, ok := a.databases[id]
		if !ok {
			w.WriteHeader(404)
			return
		}
		if r.Method == "GET" {
			result(map[string]string{"uuid": id, "name": name})
		} else if r.Method == "DELETE" {
			delete(a.databases, id)
			a.deletes++
			result(nil)
		} else {
			w.WriteHeader(405)
		}
	case path == "/r2/buckets" && r.Method == "POST":
		var input struct{ Name string }
		_ = json.NewDecoder(r.Body).Decode(&input)
		stamp := time.Now().UTC().Format(time.RFC3339Nano)
		a.buckets[input.Name] = stamp
		a.writes++
		result(map[string]string{"name": input.Name, "creation_date": stamp})
	case strings.HasPrefix(path, "/r2/buckets/"):
		name := strings.TrimPrefix(path, "/r2/buckets/")
		if r.Method == "GET" && strings.HasSuffix(name, "/domains/managed") {
			result(map[string]any{"enabled": false})
			return
		}
		if r.Method == "GET" && strings.HasSuffix(name, "/domains/custom") {
			result(map[string]any{"domains": []any{}})
			return
		}
		stamp, ok := a.buckets[name]
		if !ok {
			w.WriteHeader(404)
			return
		}
		if r.Method == "GET" {
			result(map[string]string{"name": name, "creation_date": stamp})
		} else if r.Method == "DELETE" {
			delete(a.buckets, name)
			a.deletes++
			result(nil)
		} else {
			w.WriteHeader(405)
		}
	default:
		w.WriteHeader(403)
	}
}
func (a *cfResourceAPI) writeCount() int  { a.mu.Lock(); defer a.mu.Unlock(); return a.writes }
func (a *cfResourceAPI) deleteCount() int { a.mu.Lock(); defer a.mu.Unlock(); return a.deletes }
func (a *cfResourceAPI) bucketCount() int { a.mu.Lock(); defer a.mu.Unlock(); return len(a.buckets) }
func (a *cfResourceAPI) databaseCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.databases)
}
func (a *cfResourceAPI) hasBucket(name string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := a.buckets[name]
	return ok
}
func (a *cfResourceAPI) setBucket(name, stamp string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.buckets[name] = stamp
}
func (a *cfResourceAPI) setFailure(value bool) { a.mu.Lock(); defer a.mu.Unlock(); a.failD1 = value }
func (a *cfResourceAPI) setAfterD1(fn func())  { a.mu.Lock(); defer a.mu.Unlock(); a.afterD1 = fn }
func controlledCFResources(t *testing.T) *cfResourceAPI {
	t.Helper()
	a := &cfResourceAPI{databases: map[string]string{}, buckets: map[string]string{}}
	endpoint := httptest.NewTLSServer(http.HandlerFunc(a.serve))
	t.Cleanup(endpoint.Close)
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	roots, e := x509.SystemCertPool()
	if e != nil {
		t.Fatal(e)
	}
	roots.AddCert(endpoint.Certificate())
	// This transport trusts only the controlled TLS fixture for example.com;
	// only api.cloudflare.com's dial is replaced. Production has no override.
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12}
	dial := transport.DialContext
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address == "api.cloudflare.com:443" {
			address = endpoint.Listener.Addr().String()
		}
		return dial(ctx, network, address)
	}
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = original; transport.CloseIdleConnections() })
	return a
}
func cfResourceFixture(t *testing.T, account, token string) (*workflowRunFixture, loginResult, *golfv1.ProvisionCloudflareEnvironmentResourcesRequest) {
	t.Helper()
	f, l, target := environmentFixture(t)
	saved, e := environmentSave(t, f, l, environmentInput(target))
	if e != nil {
		t.Fatal("environment setup", e)
	}
	p := cloudflareProfile()
	p.CloudflareAccountId = account
	response := infrastructureRequest(f.server, l, "SaveInfrastructureConnection", &golfv1.SaveInfrastructureConnectionRequest{Connection: p, ExpectedVersion: "0", Credential: &golfv1.InfrastructureConnectionCredential{CloudflareApiToken: token}, PasswordConfirmation: localTestPassword})
	var profile golfv1.SaveInfrastructureConnectionResponse
	if response.Code != 200 || protojson.Unmarshal(response.Body.Bytes(), &profile) != nil {
		t.Fatal("encrypted management connection setup failed", response.Code)
	}
	return f, l, &golfv1.ProvisionCloudflareEnvironmentResourcesRequest{Target: target, EnvironmentId: saved.Environment.Id, EnvironmentVersion: saved.Environment.Version, ConnectionId: profile.Connection.Id, ConnectionVersion: profile.Connection.Version, OperationId: uuid.NewString(), PasswordConfirmation: localTestPassword}
}
func provisionCF(t *testing.T, f *workflowRunFixture, l loginResult, input *golfv1.ProvisionCloudflareEnvironmentResourcesRequest) *golfv1.CloudflareEnvironmentResources {
	t.Helper()
	response := infrastructureRequest(f.server, l, "ProvisionCloudflareEnvironmentResources", input)
	var result golfv1.ProvisionCloudflareEnvironmentResourcesResponse
	if response.Code != 200 || protojson.Unmarshal(response.Body.Bytes(), &result) != nil || result.Resources == nil {
		t.Fatal("resource admission failed", response.Code, response.Body.String())
	}
	return result.Resources
}
func removeCF(t *testing.T, f *workflowRunFixture, l loginResult, id string) *golfv1.CloudflareEnvironmentResources {
	t.Helper()
	response := infrastructureRequest(f.server, l, "RemoveCloudflareEnvironmentResources", &golfv1.RemoveCloudflareEnvironmentResourcesRequest{OperationId: id, PasswordConfirmation: localTestPassword})
	var result golfv1.RemoveCloudflareEnvironmentResourcesResponse
	if response.Code != 200 || protojson.Unmarshal(response.Body.Bytes(), &result) != nil || result.Resources == nil {
		t.Fatal("owned resource cleanup failed", response.Code)
	}
	return result.Resources
}
func TestCloudflareResourceOperationsPostgres(t *testing.T) {
	t.Run("original ownership replay and cleanup", func(t *testing.T) {
		a := controlledCFResources(t)
		f, l, input := cfResourceFixture(t, "0123456789abcdef0123456789abcdef", "private-management-token")
		owner, err := f.server.cfResourceOwner(t.Context(), input.OperationId)
		if err != nil {
			t.Fatal(err)
		}
		blocked := infrastructureRequest(f.server, l, "ProvisionCloudflareEnvironmentResources", input)
		releaseCodexOwner(owner.conn, owner.ownerID)
		if blocked.Code != http.StatusConflict || a.writeCount() != 0 {
			t.Fatal("concurrent owner admitted provider effects", blocked.Code)
		}
		created := provisionCF(t, f, l, input)
		if created.State != "READY" || created.D1Id == "" || created.R2CreatedAt == "" || a.writeCount() != 2 {
			t.Fatal("unverified resource allocation")
		}
		if replay := provisionCF(t, f, l, input); !proto.Equal(created, replay) || a.writeCount() != 2 {
			t.Fatal("original request dispatched again")
		}
		different := proto.Clone(input).(*golfv1.ProvisionCloudflareEnvironmentResourcesRequest)
		different.EnvironmentVersion = "2"
		if r := infrastructureRequest(f.server, l, "ProvisionCloudflareEnvironmentResources", different); r.Code == 200 || a.writeCount() != 2 {
			t.Fatal("changed input adopted original operation")
		}
		foreign := f.server.config.ForgeURL
		var count int
		if e := f.server.db.QueryRow(`SELECT count(*) FROM golf_cloudflare_resource_events`).Scan(&count); e != nil || count < 6 {
			t.Fatal("dispatch or acknowledgement omitted from journal")
		}
		if _, e := f.server.db.Exec(`UPDATE golf_cloudflare_resource_operations SET forge_url=$1 WHERE id=$2`, foreign+"/other", input.OperationId); e == nil {
			t.Fatal("ownership retargeted")
		}
		snapshot := proto.Clone(created).(*golfv1.CloudflareEnvironmentResources)
		snapshot.D1Id = uuid.NewString()
		if e := f.server.saveCFResource(t.Context(), snapshot, "READY"); e == nil {
			t.Fatal("acknowledged provider identity replaced")
		}
		missing := &golfv1.GetCloudflareEnvironmentResourcesRequest{OperationId: uuid.NewString()}
		if r := infrastructureRequest(f.server, l, "GetCloudflareEnvironmentResources", missing); r.Code != 404 {
			t.Fatal("unadmitted operation fabricated")
		}
		// An account policy edit cannot retarget existing resources or permit a
		// stale new allocation. Cleanup retains the original encrypted version.
		profile := cloudflareProfile()
		profile.Id = input.ConnectionId
		update := infrastructureRequest(f.server, l, "SaveInfrastructureConnection", &golfv1.SaveInfrastructureConnectionRequest{Connection: profile, ExpectedVersion: "1", RetainCredential: true, PasswordConfirmation: localTestPassword})
		if update.Code != 200 {
			t.Fatal("connection edit failed")
		}
		stale := proto.Clone(input).(*golfv1.ProvisionCloudflareEnvironmentResourcesRequest)
		stale.OperationId = uuid.NewString()
		if r := infrastructureRequest(f.server, l, "ProvisionCloudflareEnvironmentResources", stale); r.Code == 200 || a.writeCount() != 2 {
			t.Fatal("stale connection allocated resources")
		}
		removed := removeCF(t, f, l, input.OperationId)
		if removed.State != "REMOVED" || a.deleteCount() != 2 || a.bucketCount() != 0 || a.databaseCount() != 0 {
			t.Fatal("exact-owned cleanup unconfirmed")
		}
		if r := removeCF(t, f, l, input.OperationId); r.State != "REMOVED" || a.deleteCount() != 2 {
			t.Fatal("terminal cleanup dispatched again")
		}
		if response := infrastructureRequest(f.server, l, "ListCloudflareEnvironmentResources", &golfv1.ListCloudflareEnvironmentResourcesRequest{Target: input.Target, EnvironmentId: input.EnvironmentId, Page: &golfv1.PageRequest{Limit: 20, Page: 1}}); response.Code != 200 || strings.Contains(response.Body.String(), "private-management-token") {
			t.Fatal("owned inventory failed or disclosed token")
		}
	})
	t.Run("collision never adopted and partial authority loss never continued", func(t *testing.T) {
		a := controlledCFResources(t)
		f, l, input := cfResourceFixture(t, "0123456789abcdef0123456789abcdef", "private-management-token")
		name := cfResourceName(input.OperationId)
		a.setBucket(name, "2026-10-08T00:00:00Z")
		if v := provisionCF(t, f, l, input); v.State != "REFUSED" || a.writeCount() != 0 {
			t.Fatal("foreign preexisting bucket adopted")
		}
		if v := removeCF(t, f, l, input.OperationId); v.State != "REFUSED" || a.deleteCount() != 0 || !a.hasBucket(name) {
			t.Fatal("foreign bucket removed")
		}
		input.OperationId = uuid.NewString()
		a.setAfterD1(func() { f.mu.Lock(); f.denied = true; f.mu.Unlock() })
		if r := infrastructureRequest(f.server, l, "ProvisionCloudflareEnvironmentResources", input); r.Code == 200 {
			t.Fatal("revoked authority received successful allocation")
		}
		f.mu.Lock()
		f.denied = false
		f.mu.Unlock()
		a.setAfterD1(nil)
		if v := provisionCF(t, f, l, input); v.State != "UNKNOWN" || v.D1Id == "" || v.R2State != "PLANNED" || a.writeCount() != 1 {
			t.Fatal("partial allocation replayed or advanced")
		}
		// Original cleanup remains possible after the repository itself disappears.
		f.mu.Lock()
		f.repositoryStatus = 404
		f.mu.Unlock()
		if v := removeCF(t, f, l, input.OperationId); v.State != "REMOVED" || a.deleteCount() != 1 || !a.hasBucket(name) {
			t.Fatal("original cleanup widened or lost after repository deletion")
		}
	})
	t.Run("uncertain create and changed bucket identity remain fenced", func(t *testing.T) {
		a := controlledCFResources(t)
		f, l, input := cfResourceFixture(t, "0123456789abcdef0123456789abcdef", "private-management-token")
		a.setFailure(true)
		if v := provisionCF(t, f, l, input); v.State != "UNKNOWN" || v.D1Id != "" || a.writeCount() != 1 {
			t.Fatal("ambiguous D1 create adopted an ID")
		}
		if v := provisionCF(t, f, l, input); v.State != "UNKNOWN" || a.writeCount() != 1 {
			t.Fatal("ambiguous create retried")
		}
		if v := removeCF(t, f, l, input.OperationId); v.State == "REMOVED" || a.deleteCount() != 0 {
			t.Fatal("unknown identity deleted by discovery")
		}
		// A distinct environment proves that an external R2 replacement with the
		// same name cannot acquire the old operation's deletion authority.
		next := environmentInput(input.Target)
		next.Name = "Second preview"
		env, e := environmentSave(t, f, l, next)
		if e != nil {
			t.Fatal(e)
		}
		input.EnvironmentId, input.EnvironmentVersion, input.OperationId = env.Environment.Id, env.Environment.Version, uuid.NewString()
		a.setFailure(false)
		v := provisionCF(t, f, l, input)
		a.setBucket(v.R2Bucket, "2026-10-08T01:00:00Z")
		if removed := removeCF(t, f, l, input.OperationId); removed.State == "REMOVED" || !a.hasBucket(v.R2Bucket) || a.deleteCount() != 1 {
			t.Fatal("replacement R2 bucket deleted")
		}
	})
}

// Real Cloudflare D1/R2 calls through Golf's authenticated encrypted-profile and
// native repository/environment consumer. Native identity is controlled, not a
// real native forge deployment. The wrapper owns account-scoped credentials and checks
// independent provider absence; no Workers/AI/preview capability is implied.
func TestCloudflareResourceLive(t *testing.T) {
	if os.Getenv("GOLF_CF_PRODUCT_LIVE") != "1" {
		t.Skip("explicit owned Cloudflare product qualification required")
	}
	account, token, receipt := os.Getenv("GOLF_CF_PRODUCT_LIVE_ACCOUNT"), os.Getenv("GOLF_CF_PRODUCT_LIVE_API_TOKEN"), os.Getenv("GOLF_CF_PRODUCT_LIVE_RECEIPT")
	if len(account) != 32 || token == "" || receipt == "" || !filepath.IsAbs(receipt) {
		t.Fatal("private owned live qualification configuration required")
	}
	f, l, input := cfResourceFixture(t, account, token)
	v := &golfv1.CloudflareEnvironmentResources{OperationId: input.OperationId, D1Name: cfResourceName(input.OperationId), R2Bucket: cfResourceName(input.OperationId), AccountId: account}
	write := func() {
		raw, e := protojson.Marshal(v)
		if e != nil || strings.Contains(string(raw), token) {
			t.Fatal("unsafe receipt")
		}
		if e = os.WriteFile(receipt, raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	write()
	t.Cleanup(func() {
		original := infrastructureRequest(f.server, l, "GetCloudflareEnvironmentResources", &golfv1.GetCloudflareEnvironmentResourcesRequest{OperationId: input.OperationId})
		var observed golfv1.GetCloudflareEnvironmentResourcesResponse
		if original.Code == 200 && protojson.Unmarshal(original.Body.Bytes(), &observed) == nil && observed.Resources != nil {
			v = observed.Resources
			write()
		}
		response := infrastructureRequest(f.server, l, "RemoveCloudflareEnvironmentResources", &golfv1.RemoveCloudflareEnvironmentResourcesRequest{OperationId: input.OperationId, PasswordConfirmation: localTestPassword})
		var result golfv1.RemoveCloudflareEnvironmentResourcesResponse
		if response.Code == 200 && protojson.Unmarshal(response.Body.Bytes(), &result) == nil && result.Resources != nil {
			v = result.Resources
			write()
		}
		if v.State != "REMOVED" {
			t.Error("live owned cleanup unconfirmed; inspect private receipt")
		}
	})
	v = provisionCF(t, f, l, input)
	write()
	if v.State != "READY" || v.D1Id == "" || v.R2CreatedAt == "" {
		t.Fatal("live exact resources not qualified")
	}
	replay := provisionCF(t, f, l, input)
	if !proto.Equal(v, replay) {
		t.Fatal("live original operation changed on replay")
	}
	t.Log("PASS: real Cloudflare D1/R2 identities, encrypted account profile, current repository/environment authority, immutable original replay; cleanup runs immediately")
}

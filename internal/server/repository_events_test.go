package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func eventFixtureConnection() repositoryEventConnection {
	return repositoryEventConnection{ID: "46e3f1d3-3c06-4fb2-82c3-91ce5d739c11", RepositoryID: "101", OwnerID: "42", Repository: "alice/project", Secret: strings.Repeat("fixture", 8)}
}

func eventFixtureConfig(connections ...repositoryEventConnection) Config {
	config := testConfig("http://forgejo.invalid")
	encoded, _ := json.Marshal(connections)
	config.RepositoryEventConnectionsJSON = string(encoded)
	return config
}

func eventFixturePayload() map[string]any {
	return map[string]any{"ref": "refs/heads/main", "before": strings.Repeat("0", 40), "after": strings.Repeat("a", 40),
		"repository": map[string]any{"id": 101, "name": "project", "full_name": "alice/project", "owner": map[string]any{"id": 42, "login": "alice"}},
		"sender":     map[string]any{"id": 84, "email": "private-sender@example.invalid"},
		"commits":    []any{map[string]any{"message": "private commit text", "added": []string{"private/file"}}}}
}

func eventFixtureBody() []byte {
	body, _ := json.Marshal(eventFixturePayload())
	return body
}

func eventRequest(connection repositoryEventConnection, delivery string, body []byte) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/hooks/forgejo/"+connection.ID, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Forgejo-Delivery", delivery)
	r.Header.Set("X-Forgejo-Event", "push")
	r.Header.Set("X-Forgejo-Event-Type", "push")
	mac := hmac.New(sha256.New, []byte(connection.Secret))
	mac.Write(body)
	r.Header.Set("X-Forgejo-Signature", hex.EncodeToString(mac.Sum(nil)))
	route := chi.NewRouteContext()
	route.URLParams.Add("connectionID", connection.ID)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, route))
}

func eventResponse(s *Server, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.repositoryEventWebhook(w, r)
	return w
}

func TestRepositoryEventConfiguration(t *testing.T) {
	connection := eventFixtureConnection()
	for _, input := range []struct {
		name string
		edit func(*repositoryEventConnection)
	}{
		{"uuid", func(c *repositoryEventConnection) { c.ID = strings.ToUpper(c.ID) }},
		{"repository id", func(c *repositoryEventConnection) { c.RepositoryID = "0101" }},
		{"owner id", func(c *repositoryEventConnection) { c.OwnerID = "0" }},
		{"name", func(c *repositoryEventConnection) { c.Repository = "alice/../project" }},
		{"weak secret", func(c *repositoryEventConnection) { c.Secret = "short" }},
	} {
		t.Run(input.name, func(t *testing.T) {
			changed := connection
			input.edit(&changed)
			if _, err := New(eventFixtureConfig(changed), nil); err == nil || strings.Contains(err.Error(), changed.Secret) {
				t.Fatal("invalid/secret-disclosing connection configuration")
			}
		})
	}
	for _, input := range []string{"null", "{}", "[] []", `[{"id":"x","id":"y"}]`, strings.Repeat(" ", 128<<10+1), `[{"unexpected":"private"}]`} {
		config := testConfig("http://forgejo.invalid")
		config.RepositoryEventConnectionsJSON = input
		if _, err := New(config, nil); err == nil {
			t.Fatal("ambiguous/unbounded configuration accepted")
		}
	}
	for _, duplicate := range []string{"id", "repository", "secret"} {
		other := connection
		other.ID, other.RepositoryID, other.Repository, other.Secret = uuid.NewString(), "102", "alice/other", strings.Repeat("different", 8)
		switch duplicate {
		case "id":
			other.ID = connection.ID
		case "repository":
			other.RepositoryID = connection.RepositoryID
		case "secret":
			other.Secret = connection.Secret
		}
		if _, err := New(eventFixtureConfig(connection, other), nil); err == nil {
			t.Fatal("duplicate configuration accepted", duplicate)
		}
	}
	// The command validates before opening the database. No receipt may be
	// acknowledged by that parse-only server instance.
	s, err := New(eventFixtureConfig(connection), nil)
	if err != nil {
		t.Fatal("pre-database validation", err)
	}
	if response := eventResponse(s, eventRequest(connection, uuid.NewString(), eventFixtureBody())); response.Code != 503 {
		t.Fatal("receipt acknowledged without durable store", response.Code)
	}
	config := eventFixtureConfig()
	config.RepositoryEventConnectionsJSON = "[]"
	if _, err := New(config, nil); err != nil {
		t.Fatal("empty explicit configuration must disable intake", err)
	}
}

func TestRepositoryEventHTTPRejections(t *testing.T) {
	connection := eventFixtureConnection()
	s, err := New(eventFixtureConfig(connection), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		edit   func(*http.Request)
		status int
	}{
		{"method", func(r *http.Request) { r.Method = "GET" }, 405},
		{"missing signature", func(r *http.Request) { r.Header.Del("X-Forgejo-Signature") }, 400},
		{"bad signature", func(r *http.Request) { r.Header.Set("X-Forgejo-Signature", strings.Repeat("0", 64)) }, 401},
		{"uppercase signature", func(r *http.Request) { r.Header.Set("X-Forgejo-Signature", strings.Repeat("A", 64)) }, 401},
		{"duplicate signature", func(r *http.Request) { r.Header.Add("X-Forgejo-Signature", r.Header.Get("X-Forgejo-Signature")) }, 400},
		{"duplicate delivery", func(r *http.Request) { r.Header.Add("X-Forgejo-Delivery", uuid.NewString()) }, 400},
		{"unknown event", func(r *http.Request) { r.Header.Set("X-Forgejo-Event", "pull_request") }, 400},
		{"unknown type", func(r *http.Request) { r.Header.Set("X-Forgejo-Event-Type", "create") }, 400},
		{"delivery uuid", func(r *http.Request) { r.Header.Set("X-Forgejo-Delivery", "not-a-delivery") }, 400},
		{"form", func(r *http.Request) { r.Header.Set("Content-Type", "application/x-www-form-urlencoded") }, 415},
		{"charset", func(r *http.Request) { r.Header.Set("Content-Type", "application/json;charset=latin1") }, 415},
		{"encoding", func(r *http.Request) { r.Header.Set("Content-Encoding", "gzip") }, 400},
		{"cookie", func(r *http.Request) { r.Header.Set("Cookie", "golf_session=private") }, 400},
		{"bearer", func(r *http.Request) { r.Header.Set("Authorization", "Bearer private") }, 400},
		{"query", func(r *http.Request) { r.URL.RawQuery = "secret=private" }, 400},
		{"escaped path", func(r *http.Request) { r.URL.RawPath = strings.Replace(r.URL.Path, "4", "%34", 1) }, 400},
		{"headers", func(r *http.Request) { r.Header.Set("X-Oversize", strings.Repeat("x", 16<<10)) }, 431},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := eventRequest(connection, uuid.NewString(), eventFixtureBody())
			test.edit(request)
			response := eventResponse(s, request)
			if response.Code != test.status || response.Header().Get("Cache-Control") != "no-store" || response.Body.String() != "{\"status\":\"rejected\"}\n" {
				t.Fatal("unsafe or incorrect rejection", response.Code)
			}
		})
	}
	for _, body := range [][]byte{[]byte(`{"ref":"first","ref":"second"}`), []byte(`{"bad":"` + string([]byte{255}) + `"}`),
		[]byte(strings.Repeat("[", 34) + "0" + strings.Repeat("]", 34)), []byte(`{"items":[` + strings.Repeat("0,", 65536) + `0]}`), []byte(`{} {}`), []byte(`null`)} {
		if response := eventResponse(s, eventRequest(connection, uuid.NewString(), body)); response.Code != 400 {
			t.Fatal("unbounded or ambiguous JSON accepted", response.Code)
		}
	}
	if response := eventResponse(s, eventRequest(connection, uuid.NewString(), bytes.Repeat([]byte("x"), maxRepositoryEventBytes+1))); response.Code != 413 {
		t.Fatal("oversized body accepted", response.Code)
	}
	other := connection
	other.ID = uuid.NewString()
	if response := eventResponse(s, eventRequest(other, uuid.NewString(), eventFixtureBody())); response.Code != 404 {
		t.Fatal("unconfigured connection accepted", response.Code)
	}
}

func TestRepositoryEventPayloadBinding(t *testing.T) {
	connection := eventFixtureConnection()
	s, err := New(eventFixtureConfig(connection), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, edit := range []func(map[string]any){
		func(p map[string]any) { p["repository"].(map[string]any)["id"] = 102 },
		func(p map[string]any) { p["repository"].(map[string]any)["owner"].(map[string]any)["id"] = 43 },
		func(p map[string]any) { p["repository"].(map[string]any)["owner"].(map[string]any)["login"] = "other" },
		func(p map[string]any) { p["repository"].(map[string]any)["full_name"] = "other/project" },
		func(p map[string]any) { p["repository"].(map[string]any)["name"] = "renamed" },
		func(p map[string]any) { p["sender"].(map[string]any)["id"] = 0 },
		func(p map[string]any) { p["ref"] = "refs/heads/../private" },
		func(p map[string]any) { p["ref"] = "refs/heads/" },
		func(p map[string]any) { p["ref"] = "refs/pull/1/head" },
		func(p map[string]any) { p["after"] = strings.Repeat("a", 41) },
		func(p map[string]any) { p["after"] = strings.Repeat("a", 64) },
		func(p map[string]any) { p["after"] = strings.Repeat("0", 40) },
	} {
		payload := eventFixturePayload()
		edit(payload)
		body, _ := json.Marshal(payload)
		if response := eventResponse(s, eventRequest(connection, uuid.NewString(), body)); response.Code != 400 {
			t.Fatal("unbound/invalid event accepted", response.Code)
		}
	}
	for _, ref := range []string{"refs/heads/main", "refs/tags/v1"} {
		payload := eventFixturePayload()
		payload["ref"], payload["before"], payload["after"] = ref, strings.Repeat("a", 64), strings.Repeat("0", 64)
		body, _ := json.Marshal(payload)
		if response := eventResponse(s, eventRequest(connection, uuid.NewString(), body)); response.Code != 503 {
			t.Fatal("valid deletion should reach unavailable storage", response.Code)
		}
	}
}

func eventFixtureServer(t *testing.T, db *sql.DB, connections ...repositoryEventConnection) *Server {
	t.Helper()
	s, err := New(eventFixtureConfig(connections...), db)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestRepositoryEventDeduplicationPostgres(t *testing.T) {
	db := testDatabase(t)
	connection := eventFixtureConnection()
	s := eventFixtureServer(t, db, connection)
	delivery, body := uuid.NewString(), eventFixtureBody()
	var workers sync.WaitGroup
	results := make(chan int, 12)
	for range 12 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			results <- eventResponse(s, eventRequest(connection, delivery, body)).Code
		}()
	}
	workers.Wait()
	close(results)
	counts := map[int]int{}
	for result := range results {
		counts[result]++
	}
	if counts[202] != 1 || counts[204] != 11 {
		t.Fatal("concurrent delivery was not deduplicated", counts)
	}
	var count int
	var recorded, state, execution string
	if err := db.QueryRow(`SELECT count(*),min(state),min(execution_state),min(row_to_json(e)::text) FROM golf_repository_events e`).Scan(&count, &state, &execution, &recorded); err != nil || count != 1 || state != "RECORDED" || execution != "UNAVAILABLE" {
		t.Fatal("incorrect durable ledger", err)
	}
	for _, private := range []string{connection.Secret, "private commit text", "private-sender", "private/file"} {
		if strings.Contains(recorded, private) {
			t.Fatal("private payload or secret retained")
		}
	}
	restarted := eventFixtureServer(t, db, connection)
	if response := eventResponse(restarted, eventRequest(connection, delivery, body)); response.Code != 204 {
		t.Fatal("restart lost delivery identity", response.Code)
	}
	changed := bytes.Replace(body, []byte(strings.Repeat("a", 40)), []byte(strings.Repeat("b", 40)), 1)
	if response := eventResponse(restarted, eventRequest(connection, delivery, changed)); response.Code != 409 {
		t.Fatal("delivery ID accepted different payload", response.Code)
	}
	// Native delivery IDs are unsigned. The canonical signed-payload ledger
	// prevents relabeled redelivery from appending another receipt.
	if response := eventResponse(restarted, eventRequest(connection, uuid.NewString(), body)); response.Code != 204 {
		t.Fatal("relabeled payload was not deduplicated", response.Code)
	}
	if err := db.QueryRow(`SELECT count(*) FROM golf_repository_events`).Scan(&count); err != nil || count != 1 {
		t.Fatal("relabeled payload appended another receipt", err)
	}
	connection.Secret = strings.Repeat("rotated", 8)
	rotated := eventFixtureServer(t, db, connection)
	if response := eventResponse(rotated, eventRequest(eventFixtureConnection(), delivery, body)); response.Code != 401 {
		t.Fatal("restarted receiver retained old secret", response.Code)
	}
	if response := eventResponse(rotated, eventRequest(connection, delivery, body)); response.Code != 204 {
		t.Fatal("secret rotation discarded deduplication", response.Code)
	}
	for _, query := range []string{"UPDATE golf_repository_event_payloads SET push_admission_requested=true", "DELETE FROM golf_repository_event_payloads", "TRUNCATE golf_repository_event_payloads", "UPDATE golf_repository_events SET sender_id=99", "DELETE FROM golf_repository_events", "TRUNCATE golf_repository_events", "UPDATE golf_repository_event_connections SET repository='other/name'", "DELETE FROM golf_repository_event_connections", "TRUNCATE golf_repository_event_connections CASCADE"} {
		if _, err := db.Exec(query); err == nil {
			t.Fatal("append-only binding/ledger guard absent")
		}
	}
}

func TestRepositoryEventConnectionBindingPostgres(t *testing.T) {
	db := testDatabase(t)
	connection := eventFixtureConnection()
	eventFixtureServer(t, db, connection)
	for _, edit := range []func(*repositoryEventConnection){
		func(c *repositoryEventConnection) { c.RepositoryID = "102" },
		func(c *repositoryEventConnection) { c.OwnerID = "43" },
		func(c *repositoryEventConnection) { c.Repository = "alice/renamed" },
	} {
		changed := connection
		edit(&changed)
		if _, err := New(eventFixtureConfig(changed), db); err == nil {
			t.Fatal("durable connection silently rebound")
		}
	}
	config := eventFixtureConfig(connection)
	config.ForgeURL = "http://other.invalid"
	if _, err := New(config, db); err == nil {
		t.Fatal("durable connection rebound to other forge")
	}
	other := connection
	other.ID, other.RepositoryID, other.Repository, other.Secret = "00000000-0000-4000-8000-000000000001", "102", "alice/other", strings.Repeat("other", 8)
	changed := connection
	changed.OwnerID = "43"
	if _, err := New(eventFixtureConfig(other, changed), db); err == nil {
		t.Fatal("conflicting configuration accepted")
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM golf_repository_event_connections").Scan(&count); err != nil || count != 1 {
		t.Fatal("failed configuration partially registered", err)
	}
	s := eventFixtureServer(t, db, connection, other)
	payload := eventFixturePayload()
	payload["repository"].(map[string]any)["id"], payload["repository"].(map[string]any)["name"], payload["repository"].(map[string]any)["full_name"] = 102, "other", "alice/other"
	body, _ := json.Marshal(payload)
	delivery := uuid.NewString()
	for _, fixture := range []struct {
		connection repositoryEventConnection
		body       []byte
	}{{connection, eventFixtureBody()}, {other, body}} {
		if response := eventResponse(s, eventRequest(fixture.connection, delivery, fixture.body)); response.Code != 202 {
			t.Fatal("independent connection delivery scope collided", response.Code)
		}
	}
}

func TestRepositoryEventFailureBeforeAcknowledgmentPostgres(t *testing.T) {
	for _, deferred := range []bool{false, true} {
		t.Run(map[bool]string{false: "insert", true: "commit"}[deferred], func(t *testing.T) {
			db := testDatabase(t)
			connection := eventFixtureConnection()
			s := eventFixtureServer(t, db, connection)
			function := `CREATE FUNCTION reject_event_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; `
			trigger := `CREATE TRIGGER reject_event_fixture BEFORE INSERT ON golf_repository_events FOR EACH ROW EXECUTE FUNCTION reject_event_fixture()`
			if deferred {
				trigger = `CREATE CONSTRAINT TRIGGER reject_event_fixture AFTER INSERT ON golf_repository_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_event_fixture()`
			}
			if _, err := db.Exec(function + trigger); err != nil {
				t.Fatal(err)
			}
			delivery, body := uuid.NewString(), eventFixtureBody()
			if response := eventResponse(s, eventRequest(connection, delivery, body)); response.Code != 503 {
				t.Fatal("failed transaction acknowledged", response.Code)
			}
			var count int
			if err := db.QueryRow("SELECT count(*) FROM golf_repository_events").Scan(&count); err != nil || count != 0 {
				t.Fatal("transaction failure retained partial event", err)
			}
			if _, err := db.Exec("DROP TRIGGER reject_event_fixture ON golf_repository_events"); err != nil {
				t.Fatal(err)
			}
			if response := eventResponse(s, eventRequest(connection, delivery, body)); response.Code != 202 {
				t.Fatal("retry after storage recovery lost event", response.Code)
			}
		})
	}
}

func TestForgejoRepositoryEventHeaders(t *testing.T) {
	connection := eventFixtureConnection()
	config := eventFixtureConfig(connection)
	config.ForgeKind = "forgejo"
	config.ForgeInstanceID = uuid.NewString()
	s, err := New(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		edit   func(*http.Request)
		status int
	}{
		{"pinned Forgejo headers", func(r *http.Request) {}, 503},
		{"missing native signature", func(r *http.Request) { r.Header.Del("X-Forgejo-Signature") }, 400},
		{"duplicate native event", func(r *http.Request) { r.Header.Add("X-Forgejo-Event", "push") }, 400},
		{"invalid signature", func(r *http.Request) { r.Header.Set("X-Forgejo-Signature", strings.Repeat("0", 64)) }, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := eventRequest(connection, uuid.NewString(), eventFixtureBody())
			tc.edit(r)
			if response := eventResponse(s, r); response.Code != tc.status {
				t.Fatalf("status %d, want %d", response.Code, tc.status)
			}
		})
	}
	for _, field := range []string{"id", "full_name"} {
		payload := eventFixturePayload()
		if field == "id" {
			payload["repository"].(map[string]any)[field] = 102
		} else {
			payload["repository"].(map[string]any)[field] = "other/project"
		}
		body, _ := json.Marshal(payload)
		r := eventRequest(connection, uuid.NewString(), body)
		if response := eventResponse(s, r); response.Code != 400 {
			t.Fatal("signed Forgejo payload escaped repository binding", field, response.Code)
		}
	}
	forge, err := New(eventFixtureConfig(connection), nil)
	if err != nil {
		t.Fatal(err)
	}
	r := eventRequest(connection, uuid.NewString(), eventFixtureBody())
	r.Header.Del("X-Forgejo-Signature")
	if response := eventResponse(forge, r); response.Code != 400 {
		t.Fatal("Forgejo signature header missing", response.Code)
	}
}

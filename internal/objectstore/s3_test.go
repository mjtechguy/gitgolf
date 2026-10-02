package objectstore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testConfig(endpoint string) Config {
	return Config{Endpoint: endpoint, Bucket: "golf-test", Region: "us-east-1", AccessKeyID: "fixture-access", SecretAccessKey: "fixture-secret", PathStyle: true, AllowHTTP: true, Prefix: "installation-one"}
}
func sourceKey(data []byte) string { return "ci-sources/" + digest(data) + ".tar" }
func newTestStore(t *testing.T, handler http.HandlerFunc) (*Store, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	store, err := New(context.Background(), testConfig(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	return store, server
}
func TestConfigAndInputValidation(t *testing.T) {
	base := testConfig("https://storage.example")
	cases := []Config{base, base, base, base, base, base, base, base, base, base, base, base, base}
	cases[0].Endpoint = "http://storage.example"
	cases[0].AllowHTTP = false
	cases[1].Endpoint = "https://name:secret@storage.example"
	cases[2].Endpoint = "https://storage.example/path"
	cases[3].Endpoint = "https://storage.example?secret=secret"
	cases[4].Endpoint = "https://storage.example/#fragment"
	cases[5].SecretAccessKey = ""
	cases[6].AccessKeyID = ""
	cases[6].SecretAccessKey = ""
	cases[6].SessionToken = "orphan"
	cases[7].Bucket = "../bucket"
	cases[8].Prefix = "a/../b"
	cases[9].Prefix = "a//b"
	cases[10].Prefix = "a/"
	cases[11].Region = "wrong\nregion"
	cases[12].Bucket = "127.0.0.1"
	for i, c := range cases {
		if _, err := New(context.Background(), c); !errors.Is(err, ErrConfiguration) {
			t.Fatalf("case%d accepted", i)
		}
	}
	var calls atomic.Int32
	store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) })
	for _, key := range []string{"../escape", "/ci-sources/" + strings.Repeat("a", 64) + ".tar", "ci-sources/" + strings.Repeat("A", 64) + ".tar", "ci-sources/a.tar", "ci-sources/" + strings.Repeat("a", 64) + ".tar?secret"} {
		if err := store.PutImmutable(context.Background(), key, []byte("x"), digest([]byte("x"))); !errors.Is(err, ErrConfiguration) {
			t.Fatal("unsafe key accepted")
		}
	}
	if err := store.PutImmutable(context.Background(), sourceKey([]byte("x")), []byte("wrong"), digest([]byte("x"))); !errors.Is(err, ErrIntegrity) {
		t.Fatal(err)
	}
	if _, err := store.GetVerified(context.Background(), sourceKey([]byte("x")), digest([]byte("x")), MaxSourceBytes+1); !errors.Is(err, ErrConfiguration) {
		t.Fatal(err)
	}
	if calls.Load() != 0 {
		t.Fatal("invalid input reached provider")
	}
}

func TestConditionalCreationReconciliationAndVerifiedReads(t *testing.T) {
	var mu sync.Mutex
	objects := map[string][]byte{}
	var writes int
	loseAcknowledgment := true
	store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Error("SDK did not sign request")
		}
		if r.Header.Get("X-Amz-Sdk-Checksum-Algorithm") != "" || r.Header.Get("X-Amz-Checksum-Crc32") != "" {
			t.Error("unexpected optional AWS checksum")
		}
		if !strings.HasPrefix(r.URL.Path, "/golf-test/installation-one/ci-sources/") {
			t.Error("wrong bounded namespace")
		}
		switch r.Method {
		case "PUT":
			if r.Header.Get("If-None-Match") != "*" {
				t.Error("unconditional upload")
			}
			if _, exists := objects[r.URL.Path]; exists {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(412)
				_, _ = io.WriteString(w, "<Error><Code>PreconditionFailed</Code></Error>")
				return
			}
			objects[r.URL.Path], _ = io.ReadAll(r.Body)
			writes++
			if loseAcknowledgment {
				loseAcknowledgment = false
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(500)
				_, _ = io.WriteString(w, "<Error><Code>InternalError</Code><Message>SECRET</Message></Error>")
				return
			}
			w.WriteHeader(200)
		case "GET":
			data, ok := objects[r.URL.Path]
			if !ok {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(404)
				_, _ = io.WriteString(w, "<Error><Code>NoSuchKey</Code></Error>")
				return
			}
			_, _ = w.Write(data)
		}
	})
	data := []byte("snapshot bytes")
	key := sourceKey(data)
	if err := store.PutImmutable(context.Background(), key, data, digest(data)); err != nil {
		t.Fatal(err)
	}
	if err := store.PutImmutable(context.Background(), key, data, digest(data)); err != nil {
		t.Fatal(err)
	}
	if err := store.PutImmutable(context.Background(), key, []byte("replacement"), digest([]byte("replacement"))); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if writes != 1 {
		t.Fatal("existing content was replaced")
	}
	got, err := store.GetVerified(context.Background(), key, digest(data), 100)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("verified read failed")
	}
	if _, err = store.GetVerified(context.Background(), key, digest(data), 1); !errors.Is(err, ErrTooLarge) {
		t.Fatal(err)
	}
	mu.Lock()
	objects["/golf-test/installation-one/"+key] = []byte("tampered")
	mu.Unlock()
	if _, err = store.GetVerified(context.Background(), key, digest(data), 100); !errors.Is(err, ErrIntegrity) {
		t.Fatal(err)
	}
	if _, err = store.GetVerified(context.Background(), sourceKey([]byte("missing")), digest([]byte("missing")), 100); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestSDKFailuresAreSanitizedAndRedirectsNeverFollowed(t *testing.T) {
	var forwarded atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1) }))
	defer destination.Close()
	store, server := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", destination.URL)
		w.WriteHeader(307)
	})
	if err := store.ProbeBucket(context.Background()); err != ErrUnavailable || strings.Contains(err.Error(), server.URL) {
		t.Fatal("redirect failure not sanitized")
	}
	if forwarded.Load() != 0 {
		t.Fatal("credentials redirected")
	}
	denied, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(403)
		_, _ = io.WriteString(w, "<Error><Code>AccessDenied</Code><Message>fixture-secret</Message></Error>")
	})
	if _, err := denied.GetVerified(context.Background(), sourceKey(nil), digest(nil), 100); err != ErrDenied {
		t.Fatal("denial not sanitized")
	}
	cancelStore, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := cancelStore.GetVerified(ctx, sourceKey(nil), digest(nil), 100); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("deadline not preserved")
	}
}

func TestDefaultChainAndExplicitEndpointPolicy(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "environment-fixture-access")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "environment-fixture-secret")
	t.Setenv("AWS_ENDPOINT_URL_S3", "http://must-not-be-used.invalid")
	var reached atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached.Store(true)
		if !strings.Contains(r.Header.Get("Authorization"), "environment-fixture-access/") {
			t.Error("default credential chain not used")
		}
	}))
	defer server.Close()
	c := testConfig(server.URL)
	c.AccessKeyID = ""
	c.SecretAccessKey = ""
	store, err := New(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.ProbeBucket(context.Background()); err != nil || !reached.Load() {
		t.Fatal("explicit endpoint was not used")
	}
	c.Endpoint = ""
	store, err = New(context.Background(), c)
	if err != nil || store.client.Options().BaseEndpoint != nil {
		t.Fatal("unvalidated endpoint override accepted")
	}
}

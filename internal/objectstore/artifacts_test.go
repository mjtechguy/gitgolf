package objectstore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func artifactTestKey(data []byte) string {
	return "ci-artifacts/12345678-1234-4234-8234-123456789abc/" + strings.Repeat("a", 32) + "/" + digest(data) + ".tar"
}
func TestArtifactNamespaceCapsAndConditionalReadback(t *testing.T) {
	var mu sync.Mutex
	objects := map[string][]byte{}
	var creates int
	store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if !strings.HasPrefix(r.URL.Path, "/golf-test/installation-one/ci-artifacts/") || !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Error("artifact namespace/signature invalid")
		}
		if r.Method == "PUT" {
			if r.Header.Get("If-None-Match") != "*" {
				t.Error("unconditional artifact replacement")
			}
			if _, ok := objects[r.URL.Path]; ok {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(412)
				io.WriteString(w, "<Error><Code>PreconditionFailed</Code></Error>")
				return
			}
			objects[r.URL.Path], _ = io.ReadAll(r.Body)
			creates++
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(500)
			io.WriteString(w, "<Error><Code>InternalError</Code><Message>PRIVATE</Message></Error>")
			return
		}
		if r.Method == "GET" {
			data, ok := objects[r.URL.Path]
			if !ok {
				w.WriteHeader(404)
				return
			}
			w.Write(data)
			return
		}
		w.WriteHeader(405)
	})
	data := []byte("owned artifact archive")
	key := artifactTestKey(data)
	if err := store.PutArtifactImmutable(t.Context(), key, data, digest(data)); err != nil {
		t.Fatal(err)
	}
	if err := store.PutArtifactImmutable(t.Context(), key, data, digest(data)); err != nil {
		t.Fatal(err)
	}
	if creates != 1 {
		t.Fatal("artifact overwritten")
	}
	got, err := store.GetArtifactVerified(t.Context(), key, digest(data), 100)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("artifact readback failed", err)
	}
	mu.Lock()
	objects["/golf-test/installation-one/"+key] = []byte("different")
	mu.Unlock()
	if err = store.PutArtifactImmutable(t.Context(), key, data, digest(data)); !errors.Is(err, ErrConflict) {
		t.Fatal("different original accepted", err)
	}
	if _, err = store.GetArtifactVerified(t.Context(), key, digest(data), 100); !errors.Is(err, ErrIntegrity) {
		t.Fatal("corruption released", err)
	}
}
func TestArtifactNamespaceInvalidNeverReachesProvider(t *testing.T) {
	var calls atomic.Int32
	store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) })
	data := []byte("safe")
	key := artifactTestKey(data)
	invalid := []string{sourceKey(data), "/" + key, key + "?credential", strings.Replace(key, "/aaaa", "/AAAA", 1), strings.Replace(key, "4234", "1234", 1), strings.Replace(key, "ci-artifacts/", "ci-artifacts/../", 1), strings.Replace(key, digest(data), strings.Repeat("b", 64), 1)}
	for _, value := range invalid {
		if err := store.PutArtifactImmutable(context.Background(), value, data, digest(data)); !errors.Is(err, ErrConfiguration) {
			t.Fatal("invalid artifact key admitted", value)
		}
		if _, err := store.GetArtifactVerified(t.Context(), value, digest(data), 10); !errors.Is(err, ErrConfiguration) {
			t.Fatal("invalid read admitted")
		}
	}
	if err := store.PutImmutable(t.Context(), key, data, digest(data)); !errors.Is(err, ErrConfiguration) {
		t.Fatal("source namespace widened")
	}
	if _, err := store.GetVerified(t.Context(), key, digest(data), 10); !errors.Is(err, ErrConfiguration) {
		t.Fatal("source read namespace widened")
	}
	if _, err := store.GetArtifactVerified(t.Context(), key, digest(data), MaxArtifactBytes+1); !errors.Is(err, ErrConfiguration) {
		t.Fatal("read cap lost")
	}
	large := make([]byte, MaxArtifactBytes+1)
	if err := store.PutArtifactImmutable(t.Context(), artifactTestKey(large), large, digest(large)); !errors.Is(err, ErrTooLarge) {
		t.Fatal("upload cap lost")
	}
	if err := store.PutArtifactImmutable(t.Context(), key, []byte("wrong"), digest(data)); !errors.Is(err, ErrIntegrity) {
		t.Fatal("input digest ignored")
	}
	if calls.Load() != 0 {
		t.Fatal("invalid input reached provider")
	}
}

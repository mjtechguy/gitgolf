package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestCoordinatorOrigin(t *testing.T) {
	for _, value := range []string{"https://golf.example", "http://127.0.0.1:8080/", "http://localhost:8080", "http://[::1]:8080"} {
		if _, err := coordinatorURL(value); err != nil {
			t.Errorf("valid origin rejected %s", value)
		}
	}
	for _, value := range []string{"http://golf.example", "https://user:pass@golf.example", "https://golf.example/path", "https://golf.example?secret=x", "https://golf.example#x", "file:///tmp/socket", "//golf.example", "https://golf.example/%2f"} {
		if _, err := coordinatorURL(value); err == nil {
			t.Errorf("invalid origin accepted %s", value)
		}
	}
}
func TestPrivateBoundSourceAndCredentialHeaders(t *testing.T) {
	data := []byte("synthetic bounded source bytes")
	digest := sha256.Sum256(data)
	a := assignment{AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("b", 43), SourceSHA256: hex.EncodeToString(digest[:])}
	corrupt := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("k", 43) || r.Header.Get("Golf-Runner-ID") != "worker" || r.Header.Get("Golf-Attempt-Token") != a.AttemptToken || r.Header.Get("Cookie") != "" {
			t.Error("control-plane headers incorrect")
		}
		if corrupt {
			_, _ = w.Write([]byte("wrong"))
		} else {
			_, _ = w.Write(data)
		}
	}))
	defer server.Close()
	c := coordinator{origin: server.URL, id: "worker", key: strings.Repeat("k", 43), client: server.Client()}
	file, err := c.source(context.Background(), a, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(file)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("source file must be private")
	}
	got, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("source differs")
	}
	corrupt = true
	if _, err = c.source(context.Background(), a, t.TempDir()); err == nil {
		t.Fatal("wrong source hash accepted")
	}
}
func TestLogNormalizationSequenceAndJSONBounds(t *testing.T) {
	var combined strings.Builder
	sequence := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || len(body) > 32<<10 {
			t.Error("log JSON too large")
		}
		var value struct {
			Sequence int
			Text     string
		}
		if json.Unmarshal(body, &value) != nil || !utf8.ValidString(value.Text) || strings.ContainsRune(value.Text, 0) || len(value.Text) > 16<<10 || value.Sequence != sequence+1 {
			t.Error("log encoding/sequence invalid")
		}
		sequence = value.Sequence
		combined.WriteString(value.Text)
		w.WriteHeader(204)
	}))
	defer server.Close()
	c := coordinator{origin: server.URL, id: "worker", key: strings.Repeat("k", 43), client: server.Client()}
	a := assignment{AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("b", 43)}
	l := logForwarder{c: &c, a: a}
	ctx := context.Background()
	for _, data := range [][]byte{{0xf0, 0x9f}, {0x8c, 0x8d, ' ', 0xff, 0}, []byte(strings.Repeat("<\t>", 6000)), {0xe2, 0x82}} {
		if err := l.write(ctx, runner.LogChunk{Stream: "stdout", Data: data}, false); err != nil {
			t.Fatal(err)
		}
	}
	if err := l.write(ctx, runner.LogChunk{Stream: "stdout"}, true); err != nil {
		t.Fatal(err)
	}
	expected := "🌍 ��" + strings.Repeat("<\t>", 6000) + "�"
	if combined.String() != expected {
		t.Fatalf("normalization changed complete runes: length %d wanted %d", combined.Len(), len(expected))
	}
	if sequence < 2 {
		t.Fatal("expected bounded chunks")
	}
}
func TestPollValidationAndDenial(t *testing.T) {
	state := "valid"
	a := assignment{RunID: "17", AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("b", 43), JobID: "check", ImageDigest: "alpine@sha256:" + strings.Repeat("c", 64), CommitID: strings.Repeat("d", 40), SourceSHA256: strings.Repeat("e", 64), TimeoutSeconds: 900, LeaseSeconds: 45}
	a.Steps = append(a.Steps, struct {
		Name  string
		Run   string
		Shell string
	}{Name: "step", Run: "true", Shell: "sh"})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if state == "denied" {
			w.WriteHeader(403)
			return
		}
		if state == "empty" {
			w.WriteHeader(204)
			return
		}
		if state == "bad" {
			fmt.Fprint(w, `{"attemptId":"../bad"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(a)
	}))
	defer server.Close()
	c := coordinator{origin: server.URL, id: "worker", key: strings.Repeat("k", 43), client: server.Client()}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if result, err := c.poll(ctx); err != nil || result.AttemptID != a.AttemptID {
		t.Fatal("valid poll rejected")
	}
	state = "bad"
	if _, err := c.poll(ctx); err == nil {
		t.Fatal("malformed assignment accepted")
	}
	state = "empty"
	if result, err := c.poll(ctx); err != nil || result != nil {
		t.Fatal("empty poll differs")
	}
	state = "denied"
	if _, err := c.poll(ctx); err != errUnauthorized {
		t.Fatal("enrollment denial ignored")
	}
}

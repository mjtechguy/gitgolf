package server

import (
	"crypto/ed25519"
	"crypto/rand"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestSSHKeyValidation(t *testing.T) {
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	canonical := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	normalized, fingerprint, err := normalizeSSHKey(canonical + " my laptop\n")
	if err != nil || normalized != canonical || fingerprint != ssh.FingerprintSHA256(key) {
		t.Fatal("valid public key normalization failed")
	}
	for _, input := range []string{"", "-----BEGIN OPENSSH PRIVATE KEY-----", "command=\"echo unsafe\" " + canonical, canonical + "\n" + canonical, strings.Repeat("x", 8193), "ssh-ed25519 not-base64"} {
		if _, _, err := normalizeSSHKey(input); err == nil {
			t.Fatal("accepted invalid SSH key")
		}
	}
	row := forgeSSHKey{ID: 1, Title: "Laptop", Key: canonical, Fingerprint: fingerprint, CreatedAt: "2026-10-02T12:00:00Z", LastUsedAt: "2026-10-02T12:00:00Z", KeyType: "user", User: &User{ID: 42}}
	if _, err := wireSSHKey(row, User{ID: 42}); err != nil {
		t.Fatal(err)
	}
	if _, err := wireSSHKey(row, User{ID: 43}); err == nil {
		t.Fatal("accepted other owner")
	}
	row.Fingerprint = "SHA256:wrong"
	if _, err := wireSSHKey(row, User{ID: 42}); err == nil {
		t.Fatal("accepted mismatched fingerprint")
	}
}

func TestSSHKeyRPCBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"ListSSHKeys", "AddSSHKey", "DeleteSSHKey"} {
		path := "/golf.v1.GitAccessService/" + method
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			r := httptest.NewRequest("POST", "/rpc"+path, strings.NewReader("malformed"))
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s authentication boundary: %d", method, w.Code)
			}
		}
		response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed")
		if response.Code != 403 {
			t.Fatalf("read-only credential reached key lifecycle: %d", response.Code)
		}
	}
}

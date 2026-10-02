package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// Existing migration/legacy fixture helpers deliberately preserve the old AAD.
// Runtime code always selects the exact key label persisted with the record.
func (s *Server) seal(value string, hash []byte) []byte {
	encrypted, _, err := s.keyring.seal(sessionDomain, value, hash)
	if err != nil {
		panic(err)
	}
	return encrypted
}
func (s *Server) unseal(value, hash []byte) (string, error) {
	return s.keyring.open("legacy", sessionDomain, value, hash)
}

func keyFixture(seed byte) string {
	return base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{seed}, 32))
}
func keyConfigJSON(values map[string]string) string {
	encoded, _ := json.Marshal(values)
	return string(encoded)
}
func parseTestKeys(t *testing.T, legacy string, values map[string]string, active string) *Keyring {
	t.Helper()
	encoded := ""
	if values != nil {
		encoded = keyConfigJSON(values)
	}
	keys, err := ParseKeyring(legacy, encoded, active)
	if err != nil {
		t.Fatal(err)
	}
	return keys
}

func TestKeyringConfigurationAndBinding(t *testing.T) {
	legacy := keyFixture(1)
	valid := keyConfigJSON(map[string]string{"next": keyFixture(2)})
	for _, test := range []struct{ legacy, json, active string }{
		{"", "", ""}, {legacy, valid, ""}, {legacy, valid, "missing"},
		{legacy, `{"next":"` + keyFixture(2) + `","next":"` + keyFixture(3) + `"}`, "next"},
		{legacy, `{"next":"` + keyFixture(2) + `","\u006eext":"` + keyFixture(2) + `"}`, "next"},
		{legacy, `{"bad/id":"` + keyFixture(2) + `"}`, "bad/id"},
		{legacy, valid + `{}`, "next"}, {legacy, `[]`, "next"}, {legacy, `null`, "next"},
		{legacy, `{"next":null}`, "next"}, {legacy, `{"next":3}`, "next"},
		{legacy, `{"next":"` + strings.TrimRight(keyFixture(2), "=") + `"}`, "next"},
		{legacy, keyConfigJSON(map[string]string{"legacy": keyFixture(3)}), "legacy"},
		{keyFixture(1) + "\n", "", ""},
	} {
		if _, err := ParseKeyring(test.legacy, test.json, test.active); err == nil || strings.Contains(err.Error(), keyFixture(2)) {
			t.Fatal("invalid/secret-bearing key configuration accepted")
		}
	}
	tooMany := map[string]string{}
	for i := 0; i < 17; i++ {
		tooMany[fmt.Sprintf("key%d", i)] = keyFixture(byte(i + 1))
	}
	if _, err := ParseKeyring("", keyConfigJSON(tooMany), "key1"); err == nil {
		t.Fatal("unbounded keyring accepted")
	}
	keys := parseTestKeys(t, legacy, map[string]string{"next": keyFixture(2), "same-material": keyFixture(2)}, "next")
	hash := bytes.Repeat([]byte{5}, 32)
	encrypted, id, err := keys.seal(sessionDomain, "private-token", hash)
	if err != nil || id != "next" || bytes.Contains(encrypted, []byte("private-token")) {
		t.Fatal("keyed seal", err)
	}
	if plain, err := keys.open("next", sessionDomain, encrypted, hash); err != nil || plain != "private-token" {
		t.Fatal("keyed open", err)
	}
	for _, test := range []struct {
		id, domain      string
		encrypted, hash []byte
	}{
		{"same-material", sessionDomain, encrypted, hash}, {"legacy", sessionDomain, encrypted, hash}, {"missing", sessionDomain, encrypted, hash},
		{"next", oauthAttemptDomain, encrypted, hash}, {"next", sessionDomain, encrypted, bytes.Repeat([]byte{6}, 32)},
		{"next", sessionDomain, encrypted[:5], hash},
		{"next", sessionDomain, append(append([]byte{}, encrypted[:len(encrypted)-1]...), encrypted[len(encrypted)-1]^1), hash},
	} {
		if _, err := keys.open(test.id, test.domain, test.encrypted, test.hash); !errors.Is(err, errCredentialUnavailable) {
			t.Fatal("key/domain/binding tamper accepted", err)
		}
	}
	// Independently reproduce the old AES-GCM format, not just a same-code roundtrip.
	raw, _ := base64.StdEncoding.DecodeString(legacy)
	block, _ := aes.NewCipher(raw)
	aead, _ := cipher.NewGCM(block)
	nonce := bytes.Repeat([]byte{7}, aead.NonceSize())
	old := aead.Seal(nonce, nonce, []byte("old-token"), hash)
	if plain, err := keys.open("legacy", oauthAttemptDomain, old, hash); err != nil || plain != "old-token" {
		t.Fatal("legacy AAD compatibility", err)
	}
}

func TestKeyOperatorBoundsWithoutDatabase(t *testing.T) {
	keys := parseTestKeys(t, keyFixture(1), nil, "")
	for _, bounds := range [][2]int{{0, 1}, {1001, 1}, {1, 0}, {1, 101}} {
		if _, err := RotateCredentials(context.Background(), nil, keys, bounds[0], bounds[1]); err == nil {
			t.Fatal("invalid operator bounds accepted")
		}
	}
	if _, err := CheckKeyRetirement(context.Background(), nil, keys, "bad/key"); err == nil {
		t.Fatal("invalid retirement ID accepted")
	}
}

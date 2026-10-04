package server

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
)

const reviewContentDomain = "review_content"

const sessionDomain = "session"
const oauthAttemptDomain = "oauth-attempt"
const infrastructureConnectionDomain = "infrastructure_connection"

var keyIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
var errKeyConfiguration = errors.New("Encryption key configuration is invalid.")

// Keyring is the concrete AES-256-GCM credential codec shared by runtime and
// operator rotation. It contains no network/KMS integration. Do not serialize it.
type Keyring struct {
	active       string
	keys         map[string]cipher.AEAD
	fingerprints map[string][32]byte
}

func ValidKeyID(value string) bool     { return keyIDPattern.MatchString(value) }
func (k *Keyring) ActiveKeyID() string { return k.active }

// ParseKeyring accepts canonical padded base64 32-byte keys. Legacy ciphertext
// keeps its original associated data; every other key label binds domain+label.
// Duplicate JSON names are rejected before ordinary map decoding can hide them.
func ParseKeyring(legacyKeyBase64, keysJSON, activeKeyID string) (*Keyring, error) {
	if len(keysJSON) > 16<<10 {
		return nil, errKeyConfiguration
	}
	values := map[string][]byte{}
	decode := func(value string) ([]byte, error) {
		key, err := base64.StdEncoding.DecodeString(value)
		if err != nil || len(key) != 32 || base64.StdEncoding.EncodeToString(key) != value {
			return nil, errKeyConfiguration
		}
		return key, nil
	}
	if keysJSON != "" {
		decoder := json.NewDecoder(strings.NewReader(keysJSON))
		start, err := decoder.Token()
		if err != nil || start != json.Delim('{') || activeKeyID == "" {
			return nil, errKeyConfiguration
		}
		for decoder.More() {
			token, err := decoder.Token()
			id, ok := token.(string)
			if err != nil || !ok || !ValidKeyID(id) || values[id] != nil || len(values) == 16 {
				return nil, errKeyConfiguration
			}
			var value string
			if err := decoder.Decode(&value); err != nil {
				return nil, errKeyConfiguration
			}
			key, err := decode(value)
			if err != nil {
				return nil, err
			}
			values[id] = key
		}
		if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
			return nil, errKeyConfiguration
		}
		if _, err := decoder.Token(); err != io.EOF {
			return nil, errKeyConfiguration
		}
	}
	if legacyKeyBase64 != "" {
		key, err := decode(legacyKeyBase64)
		if err != nil {
			return nil, err
		}
		if existing := values["legacy"]; existing != nil && !bytes.Equal(existing, key) {
			return nil, errKeyConfiguration
		}
		values["legacy"] = key
	}
	if keysJSON == "" && activeKeyID == "" {
		activeKeyID = "legacy"
	}
	if len(values) == 0 || len(values) > 16 || !ValidKeyID(activeKeyID) || values[activeKeyID] == nil {
		return nil, errKeyConfiguration
	}
	result := &Keyring{active: activeKeyID, keys: map[string]cipher.AEAD{}, fingerprints: map[string][32]byte{}}
	for id, key := range values {
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, errKeyConfiguration
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, errKeyConfiguration
		}
		result.keys[id] = aead
		result.fingerprints[id] = sha256.Sum256(key)
	}
	return result, nil
}

func keyAAD(id, domain string, binding []byte) ([]byte, error) {
	if domain != sessionDomain && domain != oauthAttemptDomain && domain != localAccountDomain && domain != infrastructureConnectionDomain && domain != automationRepositoryDomain && domain != reviewContentDomain && domain != conversationContentDomain || len(binding) != 32 {
		return nil, errCredentialUnavailable
	}
	if id == "legacy" && (domain == sessionDomain || domain == oauthAttemptDomain) {
		return binding, nil
	}
	return append([]byte("golf:credential:v1\x00"+domain+"\x00"+id+"\x00"), binding...), nil
}

func (k *Keyring) seal(domain, value string, binding []byte) ([]byte, string, error) {
	if k == nil || k.keys[k.active] == nil {
		return nil, "", errCredentialUnavailable
	}
	aead := k.keys[k.active]
	aad, err := keyAAD(k.active, domain, binding)
	if err != nil {
		return nil, "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, "", errCredentialUnavailable
	}
	return aead.Seal(nonce, nonce, []byte(value), aad), k.active, nil
}

func (k *Keyring) open(id, domain string, value, binding []byte) (string, error) {
	if k == nil || k.keys[id] == nil {
		return "", errCredentialUnavailable
	}
	aead := k.keys[id]
	if len(value) < aead.NonceSize()+aead.Overhead() {
		return "", errCredentialUnavailable
	}
	aad, err := keyAAD(id, domain, binding)
	if err != nil {
		return "", err
	}
	plain, err := aead.Open(nil, value[:aead.NonceSize()], value[aead.NonceSize():], aad)
	if err != nil {
		return "", errCredentialUnavailable
	}
	return string(plain), nil
}

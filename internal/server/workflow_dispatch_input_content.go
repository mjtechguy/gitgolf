package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/url"
	"strings"
)

const workflowDispatchInputDomain = "workflow_dispatch_input"
const maxWorkflowDispatchPayloadBytes = 2*maxWorkflowDispatchInputsBytes + 128

// Identity is an original manual-run binding, not an authorization receipt.
// Callers must derive it from the exact run/source and current authenticated actor.
// No mutable lease, state, policy generation or encryption key enters this identity.
type workflowDispatchInputIdentity struct {
	RunID           string
	ForgeURL        string
	UserID          int64
	NativeActorID   int64
	RepositoryID    int64
	OwnerID         int64
	IdempotencyKey  string
	CommitID        string
	WorkflowPath    string
	BlobID          string
	SourceSHA256    string
	SchemaSHA256    string
	SubmittedSHA256 string
	EffectiveSHA256 string
}

type workflowDispatchInputContent struct {
	Identity         workflowDispatchInputIdentity
	PlainBytes       int
	PlainSHA256      string
	EncryptedContent []byte
	Binding          []byte
	KeyID            string
}

type workflowDispatchInputPayload struct {
	Version   int                          `json:"version"`
	Submitted []workflowDispatchInputValue `json:"submitted"`
	Effective []workflowDispatchInputValue `json:"effective"`
}

func workflowDispatchSHA256(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && hex.EncodeToString(decoded) == value
}

func validWorkflowDispatchInputIdentity(v workflowDispatchInputIdentity) bool {
	u, err := url.Parse(v.ForgeURL)
	return err == nil && len(v.ForgeURL) <= 2048 && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && strings.TrimRight(v.ForgeURL, "/") == v.ForgeURL &&
		creationKey.MatchString(v.RunID) && creationKey.MatchString(v.IdempotencyKey) && v.UserID > 0 && v.NativeActorID > 0 && v.RepositoryID > 0 && v.OwnerID > 0 &&
		objectID.MatchString(v.CommitID) && objectID.MatchString(v.BlobID) && executionWorkflowPath(v.WorkflowPath) &&
		workflowDispatchSHA256(v.SourceSHA256) && workflowDispatchSHA256(v.SchemaSHA256) && workflowDispatchSHA256(v.SubmittedSHA256) && workflowDispatchSHA256(v.EffectiveSHA256)
}

func workflowDispatchInputBinding(identity workflowDispatchInputIdentity, size int, plainSHA string) []byte {
	body, _ := json.Marshal(struct {
		Version     int
		Identity    workflowDispatchInputIdentity
		PlainBytes  int
		PlainSHA256 string
	}{1, identity, size, plainSHA})
	sum := sha256.Sum256(append([]byte("golf.workflow.dispatch.content.v1\x00"), body...))
	return sum[:]
}

// Rotation can validate this closed canonical payload without fetching native
// workflow source. Default/schema semantics are validated before sealing and must
// independently be rechecked against the exact workflow by the execution consumer.
func canonicalWorkflowDispatchPayload(payload workflowDispatchInputPayload) ([]byte, error) {
	if payload.Version != 1 || payload.Submitted == nil || payload.Effective == nil {
		return nil, errCredentialUnavailable
	}
	for _, values := range [][]workflowDispatchInputValue{payload.Submitted, payload.Effective} {
		if len(values) > maxWorkflowDispatchInputs {
			return nil, errCredentialUnavailable
		}
		names := map[string]bool{}
		for i, value := range values {
			if !workflowDispatchInputName.MatchString(value.Name) || names[strings.ToLower(value.Name)] || i > 0 && values[i-1].Name >= value.Name {
				return nil, errCredentialUnavailable
			}
			names[strings.ToLower(value.Name)] = true
			if value.Type == workflowDispatchChoice && (strings.TrimSpace(value.String) == "" || strings.Contains(value.String, "${{")) {
				return nil, errCredentialUnavailable
			}
			definition := workflowDispatchInputDefinition{Name: value.Name, Type: value.Type, Options: []string{value.String}}
			canonical, err := canonicalWorkflowDispatchInput(definition, value)
			if err != nil || canonical != value {
				return nil, errCredentialUnavailable
			}
		}
		body, err := json.Marshal(values)
		if err != nil || len(body) > maxWorkflowDispatchInputsBytes {
			return nil, errCredentialUnavailable
		}
	}
	effective := map[string]workflowDispatchInputValue{}
	for _, value := range payload.Effective {
		effective[value.Name] = value
	}
	for _, value := range payload.Submitted {
		if accepted, exists := effective[value.Name]; !exists || accepted != value {
			return nil, errCredentialUnavailable
		}
	}
	body, err := json.Marshal(payload)
	if err != nil || len(body) > maxWorkflowDispatchPayloadBytes {
		return nil, errCredentialUnavailable
	}
	return body, nil
}

func sealWorkflowDispatchInputContent(keys *Keyring, identity workflowDispatchInputIdentity, schema workflowDispatchInputSchema, values workflowDispatchInputValues) (workflowDispatchInputContent, error) {
	fail := func() (workflowDispatchInputContent, error) {
		return workflowDispatchInputContent{}, errCredentialUnavailable
	}
	if !validWorkflowDispatchInputIdentity(identity) || identity.SchemaSHA256 != schema.SHA256 {
		return fail()
	}
	validated, err := validateWorkflowDispatchInputs(schema, values.Submitted)
	if err != nil || values.SubmittedSHA256 != identity.SubmittedSHA256 || values.EffectiveSHA256 != identity.EffectiveSHA256 || validated.SubmittedSHA256 != identity.SubmittedSHA256 || validated.EffectiveSHA256 != identity.EffectiveSHA256 {
		return fail()
	}
	body, err := canonicalWorkflowDispatchPayload(workflowDispatchInputPayload{1, values.Submitted, values.Effective})
	if err != nil {
		return fail()
	}
	expected, err := canonicalWorkflowDispatchPayload(workflowDispatchInputPayload{1, validated.Submitted, validated.Effective})
	if err != nil || !bytes.Equal(body, expected) {
		return fail()
	}
	digest := sha256.Sum256(body)
	row := workflowDispatchInputContent{Identity: identity, PlainBytes: len(body), PlainSHA256: hex.EncodeToString(digest[:])}
	row.Binding = workflowDispatchInputBinding(identity, row.PlainBytes, row.PlainSHA256)
	row.EncryptedContent, row.KeyID, err = keys.seal(workflowDispatchInputDomain, string(body), row.Binding)
	if err != nil {
		return fail()
	}
	return row, nil
}

// expected must be the caller's exact immutable run/source observation, not an
// unchecked copy of the content row. This function grants no execution authority.
// Errors never include private values, source, identities or ciphertext.
func openWorkflowDispatchInputContent(keys *Keyring, expected workflowDispatchInputIdentity, row workflowDispatchInputContent) (workflowDispatchInputValues, error) {
	fail := func() (workflowDispatchInputValues, error) {
		return workflowDispatchInputValues{}, errCredentialUnavailable
	}
	if !validWorkflowDispatchInputIdentity(expected) || row.Identity != expected || row.PlainBytes < 1 || row.PlainBytes > maxWorkflowDispatchPayloadBytes || len(row.EncryptedContent) != row.PlainBytes+28 || !ValidKeyID(row.KeyID) || !workflowDispatchSHA256(row.PlainSHA256) ||
		!bytes.Equal(row.Binding, workflowDispatchInputBinding(expected, row.PlainBytes, row.PlainSHA256)) {
		return fail()
	}
	plain, err := keys.open(row.KeyID, workflowDispatchInputDomain, row.EncryptedContent, row.Binding)
	if err != nil || len(plain) != row.PlainBytes {
		return fail()
	}
	digest := sha256.Sum256([]byte(plain))
	if hex.EncodeToString(digest[:]) != row.PlainSHA256 {
		return fail()
	}
	var payload workflowDispatchInputPayload
	decoder := json.NewDecoder(strings.NewReader(plain))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil {
		return fail()
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return fail()
	}
	canonical, err := canonicalWorkflowDispatchPayload(payload)
	if err != nil || !bytes.Equal(canonical, []byte(plain)) {
		return fail()
	}
	result := workflowDispatchInputValues{Submitted: payload.Submitted, Effective: payload.Effective,
		SubmittedSHA256: workflowDispatchDigest("golf.workflow.dispatch.inputs.v1", payload.Submitted), EffectiveSHA256: workflowDispatchDigest("golf.workflow.dispatch.inputs.v1", payload.Effective)}
	if result.SubmittedSHA256 != expected.SubmittedSHA256 || result.EffectiveSHA256 != expected.EffectiveSHA256 {
		return fail()
	}
	return result, nil
}

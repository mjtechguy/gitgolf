package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func dispatchInputContentFixture(t *testing.T) (*Keyring, workflowDispatchInputIdentity, workflowDispatchInputSchema, workflowDispatchInputValues) {
	t.Helper()
	schema, err := parseWorkflowDispatchInputs([]byte(`on:
  workflow_dispatch:
    inputs:
      text: {type: string, required: true}
      flag: {type: boolean, default: false}
      count: {type: number, default: 1.25}
      choice: {type: choice, options: [a, b], default: a}
jobs:
  build:
    runs-on: linux
    steps: [{run: 'echo ok'}]
`))
	if err != nil {
		t.Fatal("declaration fixture refused")
	}
	values, err := validateWorkflowDispatchInputs(schema, []workflowDispatchInputValue{{Name: "text", Type: workflowDispatchString, String: "private <>& Unicode 世界\n"}, {Name: "flag", Type: workflowDispatchBoolean, Boolean: true}})
	if err != nil {
		t.Fatal("input fixture refused")
	}
	identity := workflowDispatchInputIdentity{RunID: uuid.NewString(), ForgeURL: "https://forge.invalid", UserID: 7, NativeActorID: 42, RepositoryID: 9007199254740993, OwnerID: 42, IdempotencyKey: uuid.NewString(), CommitID: strings.Repeat("a", 40), WorkflowPath: ".github/workflows/build.yml", BlobID: strings.Repeat("b", 40), SourceSHA256: strings.Repeat("c", 64), SchemaSHA256: schema.SHA256, SubmittedSHA256: values.SubmittedSHA256, EffectiveSHA256: values.EffectiveSHA256}
	return parseTestKeys(t, keyFixture(1), nil, ""), identity, schema, values
}

func TestWorkflowDispatchInputContentBinding(t *testing.T) {
	keys, identity, schema, values := dispatchInputContentFixture(t)
	row, err := sealWorkflowDispatchInputContent(keys, identity, schema, values)
	if err != nil {
		t.Fatal("canonical content refused")
	}
	opened, err := openWorkflowDispatchInputContent(keys, identity, row)
	if err != nil || opened.SubmittedSHA256 != values.SubmittedSHA256 || opened.EffectiveSHA256 != values.EffectiveSHA256 {
		t.Fatal("bound content did not open")
	}
	raw, _ := json.Marshal(values.Submitted)
	if bytes.Contains(row.EncryptedContent, raw) || bytes.Contains(row.EncryptedContent, []byte("private")) || len(row.Binding) != 32 {
		t.Fatal("content encryption/binding missing")
	}
	for name, change := range map[string]func(*workflowDispatchInputIdentity){
		"run":          func(v *workflowDispatchInputIdentity) { v.RunID = uuid.NewString() },
		"forge":        func(v *workflowDispatchInputIdentity) { v.ForgeURL = "https://another.invalid" },
		"golf_actor":   func(v *workflowDispatchInputIdentity) { v.UserID++ },
		"native_actor": func(v *workflowDispatchInputIdentity) { v.NativeActorID++ },
		"repository":   func(v *workflowDispatchInputIdentity) { v.RepositoryID++ },
		"owner":        func(v *workflowDispatchInputIdentity) { v.OwnerID++ },
		"operation":    func(v *workflowDispatchInputIdentity) { v.IdempotencyKey = uuid.NewString() },
		"commit":       func(v *workflowDispatchInputIdentity) { v.CommitID = strings.Repeat("d", 40) },
		"path":         func(v *workflowDispatchInputIdentity) { v.WorkflowPath = ".github/workflows/other.yml" },
		"blob":         func(v *workflowDispatchInputIdentity) { v.BlobID = strings.Repeat("d", 40) },
		"archive":      func(v *workflowDispatchInputIdentity) { v.SourceSHA256 = strings.Repeat("d", 64) },
		"schema":       func(v *workflowDispatchInputIdentity) { v.SchemaSHA256 = strings.Repeat("d", 64) },
		"submitted":    func(v *workflowDispatchInputIdentity) { v.SubmittedSHA256 = strings.Repeat("d", 64) },
		"effective":    func(v *workflowDispatchInputIdentity) { v.EffectiveSHA256 = strings.Repeat("d", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			expected := identity
			change(&expected)
			if _, err := openWorkflowDispatchInputContent(keys, expected, row); !errors.Is(err, errCredentialUnavailable) {
				t.Fatal("foreign expected identity accepted")
			}
			swapped := row
			swapped.Identity = expected
			swapped.Binding = workflowDispatchInputBinding(expected, row.PlainBytes, row.PlainSHA256)
			if _, err := openWorkflowDispatchInputContent(keys, expected, swapped); !errors.Is(err, errCredentialUnavailable) {
				t.Fatal("ciphertext identity swap accepted")
			}
		})
	}
	domainSwap := row
	plain, err := keys.open(row.KeyID, workflowDispatchInputDomain, row.EncryptedContent, row.Binding)
	if err != nil {
		t.Fatal("original codec fixture failed")
	}
	domainSwap.EncryptedContent, domainSwap.KeyID, err = keys.seal(reviewContentDomain, plain, row.Binding)
	if err != nil {
		t.Fatal("cross-domain fixture failed")
	}
	if _, err := openWorkflowDispatchInputContent(keys, identity, domainSwap); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("foreign content domain accepted")
	}
	for _, mutate := range []func(*workflowDispatchInputContent){
		func(v *workflowDispatchInputContent) { v.PlainBytes++ }, func(v *workflowDispatchInputContent) { v.PlainSHA256 = strings.Repeat("d", 64) }, func(v *workflowDispatchInputContent) { v.Binding = bytes.Repeat([]byte{1}, 32) }, func(v *workflowDispatchInputContent) { v.KeyID = "missing" }, func(v *workflowDispatchInputContent) {
			v.EncryptedContent = append([]byte{}, v.EncryptedContent...)
			v.EncryptedContent[0] ^= 1
		},
	} {
		damaged := row
		mutate(&damaged)
		if _, err := openWorkflowDispatchInputContent(keys, identity, damaged); !errors.Is(err, errCredentialUnavailable) {
			t.Fatal("damaged content accepted")
		}
	}
}

// Intentionally seal noncanonical plaintext to verify open independently refuses
// it; production seal only accepts parser-validated canonical submitted/effective.
func dispatchInputRawContent(t *testing.T, keys *Keyring, identity workflowDispatchInputIdentity, plain []byte) workflowDispatchInputContent {
	t.Helper()
	sum := sha256.Sum256(plain)
	row := workflowDispatchInputContent{Identity: identity, PlainBytes: len(plain), PlainSHA256: hex.EncodeToString(sum[:])}
	row.Binding = workflowDispatchInputBinding(identity, row.PlainBytes, row.PlainSHA256)
	var err error
	row.EncryptedContent, row.KeyID, err = keys.seal(workflowDispatchInputDomain, string(plain), row.Binding)
	if err != nil {
		t.Fatal("fixture encryption failed")
	}
	return row
}

func TestWorkflowDispatchInputContentStrictPayload(t *testing.T) {
	keys, identity, schema, values := dispatchInputContentFixture(t)
	canonical, _ := json.Marshal(workflowDispatchInputPayload{1, values.Submitted, values.Effective})
	for name, plain := range map[string][]byte{
		"whitespace": append([]byte(" "), canonical...), "trailing": append(append([]byte{}, canonical...), []byte("{}")...),
		"unknown":   bytes.Replace(canonical, []byte(`"version":1`), []byte(`"unknown":true,"version":1`), 1),
		"duplicate": bytes.Replace(canonical, []byte(`"version":1`), []byte(`"version":0,"version":1`), 1),
		"version":   bytes.Replace(canonical, []byte(`"version":1`), []byte(`"version":2`), 1),
		"unescaped": bytes.Replace(canonical, []byte(`\u003c`), []byte(`<`), 1),
		"null":      []byte(`{"version":1,"submitted":null,"effective":[]}`),
	} {
		t.Run(name, func(t *testing.T) {
			row := dispatchInputRawContent(t, keys, identity, plain)
			if _, err := openWorkflowDispatchInputContent(keys, identity, row); !errors.Is(err, errCredentialUnavailable) {
				t.Fatal("noncanonical plaintext accepted")
			}
		})
	}
	for name, mutate := range map[string]func(*workflowDispatchInputPayload){
		"unsorted":            func(v *workflowDispatchInputPayload) { v.Effective[0], v.Effective[1] = v.Effective[1], v.Effective[0] },
		"duplicate_name":      func(v *workflowDispatchInputPayload) { v.Effective[1].Name = v.Effective[0].Name },
		"fold_collision":      func(v *workflowDispatchInputPayload) { v.Effective[1].Name = "Choice" },
		"wrong_field":         func(v *workflowDispatchInputPayload) { v.Effective[0].Boolean = true },
		"blank_choice":        func(v *workflowDispatchInputPayload) { v.Effective[0].String = "" },
		"noncanonical_number": func(v *workflowDispatchInputPayload) { v.Effective[1].Number = "1.250" },
		"explicit_mismatch":   func(v *workflowDispatchInputPayload) { v.Submitted[0].Boolean = false },
		"missing_effective":   func(v *workflowDispatchInputPayload) { v.Effective = v.Effective[:2] },
	} {
		t.Run(name, func(t *testing.T) {
			var payload workflowDispatchInputPayload
			json.Unmarshal(canonical, &payload)
			mutate(&payload)
			plain, _ := json.Marshal(payload)
			row := dispatchInputRawContent(t, keys, identity, plain)
			if _, err := openWorkflowDispatchInputContent(keys, identity, row); !errors.Is(err, errCredentialUnavailable) {
				t.Fatal("invalid typed payload accepted")
			}
		})
	}
	changed := values
	changed.Effective = append([]workflowDispatchInputValue{}, values.Effective...)
	changed.Effective[0].String = "b"
	if _, err := sealWorkflowDispatchInputContent(keys, identity, schema, changed); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("unvalidated default accepted by seal")
	}
	invalid := identity
	invalid.UserID = 0
	if _, err := sealWorkflowDispatchInputContent(keys, invalid, schema, values); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("invalid actor accepted")
	}
	if _, err := sealWorkflowDispatchInputContent(nil, identity, schema, values); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("missing key accepted")
	}
}

func insertDispatchInputContent(ctx context.Context, tx *sql.Tx, row workflowDispatchInputContent) error {
	v := row.Identity
	_, err := tx.ExecContext(ctx, `INSERT INTO golf_workflow_dispatch_inputs(run_id,contract_version,forge_url,user_id,native_actor_id,repository_id,owner_id,idempotency_key,commit_id,workflow_path,blob_id,source_sha256,schema_sha256,submitted_sha256,effective_sha256,payload_bytes,payload_sha256,encrypted_content,content_binding,credential_key_id) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, v.RunID, v.ForgeURL, v.UserID, v.NativeActorID, v.RepositoryID, v.OwnerID, v.IdempotencyKey, v.CommitID, v.WorkflowPath, v.BlobID, v.SourceSHA256, v.SchemaSHA256, v.SubmittedSHA256, v.EffectiveSHA256, row.PlainBytes, row.PlainSHA256, row.EncryptedContent, row.Binding, row.KeyID)
	return err
}

func TestWorkflowDispatchInputContentPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	dispatched, err := f.dispatch(t, uuid.NewString())
	if err != nil {
		t.Fatal("manual run fixture failed", err)
	}
	run, err := f.server.loadWorkflowRun(t.Context(), dispatched.Msg.Run.Id)
	if err != nil {
		t.Fatal("run fixture unavailable")
	}
	_, identity, schema, values := dispatchInputContentFixture(t)
	identity.RunID = run.ID
	identity.ForgeURL = run.ForgeURL
	identity.UserID = run.UserID
	identity.NativeActorID = f.user.ID
	identity.RepositoryID = run.RepositoryID
	identity.OwnerID = run.OwnerID
	identity.IdempotencyKey = run.IdempotencyKey
	identity.CommitID = run.CommitID
	identity.WorkflowPath = run.WorkflowPath
	identity.BlobID = run.BlobID
	identity.SourceSHA256 = run.SourceSHA256
	row, err := sealWorkflowDispatchInputContent(f.server.keyring, identity, schema, values)
	if err != nil {
		t.Fatal("content fixture failed")
	}
	// A failed payload insert rolls back the newly reserved run in the SAME SQL tx.
	tx, err := f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	cloneID := uuid.NewString()
	patch, _ := json.Marshal(map[string]any{"id": cloneID, "idempotency_key": cloneID})
	if _, err = tx.Exec(`INSERT INTO golf_workflow_runs SELECT (jsonb_populate_record(NULL::golf_workflow_runs,to_jsonb(r)||$2::jsonb)).* FROM golf_workflow_runs r WHERE id=$1`, run.ID, string(patch)); err != nil {
		tx.Rollback()
		t.Fatal("run clone fixture failed", err)
	}
	bad := row
	bad.Identity.RunID = cloneID
	bad.Identity.IdempotencyKey = cloneID
	bad.Identity.NativeActorID++
	if err = insertDispatchInputContent(t.Context(), tx, bad); err == nil {
		tx.Rollback()
		t.Fatal("foreign native actor admitted")
	}
	tx.Rollback()
	var count int
	if f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_runs WHERE id=$1`, cloneID).Scan(&count) != nil || count != 0 {
		t.Fatal("run survived failed atomic admission")
	}
	tx, err = f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = insertDispatchInputContent(t.Context(), tx, row); err != nil {
		tx.Rollback()
		t.Fatal("bound content insert failed", err)
	}
	if tx.Commit() != nil {
		t.Fatal("content commit failed")
	}
	for _, statement := range []string{
		`UPDATE golf_workflow_dispatch_inputs SET owner_id=owner_id+1`,
		`UPDATE golf_workflow_dispatch_inputs SET payload_sha256=repeat('d',64)`,
		`UPDATE golf_workflow_dispatch_inputs SET content_binding=decode(repeat('dd',32),'hex')`,
		`UPDATE golf_workflow_dispatch_inputs SET schema_sha256=repeat('d',64)`,
		`UPDATE golf_workflow_dispatch_inputs SET native_actor_id=native_actor_id+1`,
		`DELETE FROM golf_workflow_dispatch_inputs`, `TRUNCATE golf_workflow_dispatch_inputs`,
	} {
		if _, err = f.server.db.Exec(statement); err == nil {
			t.Fatal("immutable input identity/history changed")
		}
	}
	// A ciphertext copied into another otherwise-valid SQL row authenticates for
	// neither identity. The read boundary must derive expected metadata from run.
	second, err := f.dispatch(t, uuid.NewString())
	if err != nil {
		t.Fatal("second manual fixture failed")
	}
	secondRun, err := f.server.loadWorkflowRun(t.Context(), second.Msg.Run.Id)
	if err != nil {
		t.Fatal("second run unavailable")
	}
	swapped := row
	swapped.Identity.RunID = secondRun.ID
	swapped.Identity.IdempotencyKey = secondRun.IdempotencyKey
	swapped.Binding = workflowDispatchInputBinding(swapped.Identity, swapped.PlainBytes, swapped.PlainSHA256)
	tx, err = f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = insertDispatchInputContent(t.Context(), tx, swapped); err != nil {
		tx.Rollback()
		t.Fatal("swap SQL fixture refused", err)
	}
	if tx.Commit() != nil {
		t.Fatal("swap fixture commit failed")
	}
	if _, err = openWorkflowDispatchInputContent(f.server.keyring, swapped.Identity, swapped); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("stored cross-run ciphertext swap accepted")
	}
	if _, err = f.server.db.Exec(`UPDATE golf_workflow_dispatch_inputs SET run_id=$2 WHERE run_id=$1`, run.ID, uuid.NewString()); err == nil {
		t.Fatal("run identity changed")
	}

	// Exact ciphertext rotation is allowed; stale active-key writes are refused.
	next := parseTestKeys(t, keyFixture(1), map[string]string{"next": keyFixture(2)}, "next")
	opened, err := openWorkflowDispatchInputContent(f.server.keyring, identity, row)
	if err != nil {
		t.Fatal("stored original unavailable")
	}
	rotated, err := sealWorkflowDispatchInputContent(next, identity, schema, opened)
	if err != nil {
		t.Fatal("rotation fixture failed")
	}
	if _, err = f.server.db.Exec(`UPDATE golf_workflow_dispatch_inputs SET encrypted_content=$2,credential_key_id=$3 WHERE run_id=$1`, run.ID, rotated.EncryptedContent, rotated.KeyID); err == nil {
		t.Fatal("inactive key update admitted")
	}
	if _, err = f.server.db.Exec(`UPDATE golf_encryption_policy SET active_key_id='next' WHERE singleton`); err != nil {
		t.Fatal("active policy fixture failed")
	}
	if _, err = f.server.db.Exec(`UPDATE golf_workflow_dispatch_inputs SET encrypted_content=$2,credential_key_id=$3 WHERE run_id=$1`, run.ID, rotated.EncryptedContent, rotated.KeyID); err != nil {
		t.Fatal("cipher-only rotation refused", err)
	}
	// Crypto changes neither the authenticated payload hash/binding nor identity.
	stored := row
	if err = f.server.db.QueryRow(`SELECT encrypted_content,credential_key_id,content_binding,payload_bytes,payload_sha256 FROM golf_workflow_dispatch_inputs WHERE run_id=$1`, run.ID).Scan(&stored.EncryptedContent, &stored.KeyID, &stored.Binding, &stored.PlainBytes, &stored.PlainSHA256); err != nil {
		t.Fatal("rotated row unavailable")
	}
	if _, err = openWorkflowDispatchInputContent(next, identity, stored); err != nil {
		t.Fatal("rotated row did not authenticate")
	}
	if _, err = openWorkflowDispatchInputContent(f.server.keyring, identity, stored); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("retired codec read rotated ciphertext")
	}
	if _, err = f.server.db.Exec(`UPDATE golf_workflow_dispatch_inputs SET encrypted_content=$2,credential_key_id=$3 WHERE run_id=$1`, run.ID, row.EncryptedContent, row.KeyID); err == nil {
		t.Fatal("stale-key writer admitted after activation")
	}
}

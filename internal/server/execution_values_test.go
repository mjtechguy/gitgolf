package server

import (
	"encoding/base64"
	"errors"
	"reflect"
	"strings"
	"testing"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestExecutionOutputRedactionCrossChunkAndOverlap(t *testing.T) {
	chunks := []string{"prefix abc", "defgh suffix abcdefgh", "abcdefgh"}
	got, e := redactExecutionOutput(chunks, map[string]string{"first": "abcdefgh", "overlap": "bcdefgha", "duplicate": "abcdefgh"})
	want := []string{"prefix ***", "***** suffix ********", "********"}
	if e != nil || !reflect.DeepEqual(got, want) {
		t.Fatal("cross-chunk/overlap receipt-preserving redaction failed")
	}
	if strings.Join(got, "") == strings.Join(chunks, "") {
		t.Fatal("source output was returned unchanged")
	}
	unicode := []string{"value 秘密", "凭证值abc done"}
	masked, e := redactExecutionOutput(unicode, map[string]string{"unicode": "秘密凭证值abc"})
	if e != nil || masked[0] != "value ******" || masked[1] != "************ done" {
		t.Fatal("UTF8 source output boundary changed or secret survived")
	}
	// Long repeated-byte matches are bounded linear work, including overlaps.
	repeated := strings.Repeat("x", runnerMaxLogBytes)
	masked, e = redactExecutionOutput([]string{repeated}, map[string]string{"repeat": strings.Repeat("x", 8192)})
	if e != nil || masked[0] != strings.Repeat("*", runnerMaxLogBytes) {
		t.Fatal("long overlapping secret was not covered")
	}
	if _, e = redactExecutionOutput([]string{repeated, "x"}, nil); e == nil {
		t.Fatal("aggregate output quota was bypassed")
	}
}
func TestExecutionRetainedContentIdentity(t *testing.T) {
	keys, e := ParseKeyring(base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32))), "", "")
	if e != nil {
		t.Fatal(e)
	}
	row := executionEncryptedContent{id: "2d40f2fd-c269-4acb-85ad-7acf4d71daaa", version: 1, forge: "https://native.example", repo: 9007199254740993, owner: 42, name: "BUILD_CREDENTIAL", kind: "secret", size: 12}
	row.binding = executionValueBinding(row.id, row.version, row.forge, row.repo, row.owner, row.name, row.kind, row.size)
	row.encrypted, row.key, e = keys.seal(executionValueDomain, "private-test", row.binding)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = openExecutionContent(keys, row, false); e != nil {
		t.Fatal(e)
	}
	wrong := row
	wrong.owner++
	if _, e = openExecutionContent(keys, wrong, false); !errors.Is(e, errCredentialUnavailable) {
		t.Fatal("cross-owner retained ciphertext admitted")
	}
	wrong = row
	wrong.version++
	if _, e = openExecutionContent(keys, wrong, false); !errors.Is(e, errCredentialUnavailable) {
		t.Fatal("replacement version reused retained ciphertext")
	}
	output := executionEncryptedContent{id: row.id, sequence: 1, forge: row.forge, repo: row.repo, owner: row.owner, attempt: strings.Repeat("a", 32), job: strings.Repeat("b", 32), step: "local", size: 12}
	output.binding = quarantineBinding(workflowRunRecord{ID: output.id, ForgeURL: output.forge, RepositoryID: output.repo, OwnerID: output.owner}, output.attempt, output.sequence, output.job, output.step, output.size)
	output.encrypted, output.key, e = keys.seal(quarantinedOutputDomain, "private-test", output.binding)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = openExecutionContent(keys, output, true); e != nil {
		t.Fatal(e)
	}
	output.step = "other"
	if _, e = openExecutionContent(keys, output, true); !errors.Is(e, errCredentialUnavailable) {
		t.Fatal("quarantined output crossed step identity")
	}
	status := CredentialKeyStatus{ActiveKeyID: "new", ConfiguredActiveKeyID: "new", Keys: []CredentialKeyUsage{{KeyID: "old", Configured: false, RepositoryExecutionValues: 1}, {KeyID: "old-output", Configured: false, WorkflowQuarantinedOutputs: 1}}}
	if requiredKeys(status, true) == nil || remainingCredentials(status) != 2 {
		t.Fatal("retained broker families disappeared from startup/retirement accounting")
	}
}
func TestExecutionValueReferencesAndVersions(t *testing.T) {
	id := "2d40f2fd-c269-4acb-85ad-7acf4d71daaa"
	for _, refs := range [][]*golfv1.RepositoryExecutionValueReference{nil, {{Id: id, Version: "01"}}, {{Id: id, Version: "1"}, {Id: id, Version: "2"}}, {{Id: id, Version: "0"}}, {{Id: id, Version: "9223372036854775808"}}} {
		if _, e := executionReferences(refs); e == nil {
			t.Fatal("ambiguous or invalid immutable references accepted")
		}
	}
	if refs, e := executionReferences([]*golfv1.RepositoryExecutionValueReference{{Id: id, Version: "9007199254740993"}}); e != nil || refs[0].Version != "9007199254740993" {
		t.Fatal("full-width canonical version changed")
	}
}

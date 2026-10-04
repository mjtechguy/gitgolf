package server

import (
	"encoding/json"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"reflect"
	"strconv"
	"strings"
	"testing"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestOrganizationExecutionScopedReferences(t *testing.T) {
	id := "2d40f2fd-c269-4acb-85ad-7acf4d71daaa"
	valid := &golfv1.RepositoryExecutionValueReference{Id: id, Version: "9007199254740993", Scope: golfv1.ExecutionValueScope_EXECUTION_VALUE_SCOPE_ORGANIZATION, OrganizationId: "73"}
	refs, e := executionReferences([]*golfv1.RepositoryExecutionValueReference{valid})
	if e != nil || refs[0].Scope != "organization" || refs[0].OrganizationID != "73" {
		t.Fatal("scoped immutable reference", e)
	}
	b := wireExecutionBinding(executionBindingRecord{values: refs})
	if b.Values[0].Scope != valid.Scope || b.Values[0].OrganizationId != "73" {
		t.Fatal("scoped reference projection")
	}
	for _, bad := range []*golfv1.RepositoryExecutionValueReference{{Id: id, Version: "1", OrganizationId: "73"}, {Id: id, Version: "1", Scope: golfv1.ExecutionValueScope_EXECUTION_VALUE_SCOPE_REPOSITORY, OrganizationId: "73"}, {Id: id, Version: "1", Scope: valid.Scope, OrganizationId: "073"}, {Id: id, Version: "1", Scope: 99}} {
		if _, e := executionReferences([]*golfv1.RepositoryExecutionValueReference{bad}); e == nil {
			t.Fatal("ambiguous scope accepted")
		}
	}
	paired, e := executionReferences([]*golfv1.RepositoryExecutionValueReference{valid, {Id: id, Version: "1", Scope: golfv1.ExecutionValueScope_EXECUTION_VALUE_SCOPE_REPOSITORY}})
	if e != nil || len(paired) != 2 {
		t.Fatal("independent scoped UUID collision refused", e)
	}
	if _, e = executionReferences([]*golfv1.RepositoryExecutionValueReference{{Id: id, Version: "1"}, {Id: id, Version: "1", Scope: golfv1.ExecutionValueScope_EXECUTION_VALUE_SCOPE_REPOSITORY}}); e == nil {
		t.Fatal("same repository scope selected twice under legacy alias")
	}
	legacy, e := executionReferences([]*golfv1.RepositoryExecutionValueReference{{Id: id, Version: "1"}})
	if e != nil || legacy[0].Scope != "" {
		t.Fatal("historic repository reference changed")
	}
	encoded, _ := json.Marshal(legacy)
	if string(encoded) != `[{"id":"2d40f2fd-c269-4acb-85ad-7acf4d71daaa","version":"1"}]` {
		t.Fatal("historic immutable reference serialized differently")
	}
}
func TestOrganizationExecutionApprovalLockOrder(t *testing.T) {
	b := &executionBindingRecord{approverUser: 7, organizations: []organizationExecutionApproval{{record: organizationExecutionRecord{approver: 9}}, {record: organizationExecutionRecord{approver: 3}}, {record: organizationExecutionRecord{approver: 9}}}}
	if got := executionRunApprovalUserIDs(workflowRunRecord{UserID: 7}, b); !reflect.DeepEqual(got, []int64{3, 7, 9}) {
		t.Fatal("dual-scope users lack unique immutable lock order", got)
	}
	c := CredentialKeyUsage{OrganizationExecutionValues: 2}
	status := CredentialKeyStatus{ActiveKeyID: "new", ConfiguredActiveKeyID: "new", Keys: []CredentialKeyUsage{{KeyID: "old", OrganizationExecutionValues: 2}}}
	if credentialUsageTotal(c) != 2 || remainingCredentials(status) != 2 || requiredKeys(status, true) == nil {
		t.Fatal("organization history disappeared from key startup/rotation/retirement accounting")
	}
	status.Keys[0].Configured = true
	if requiredKeys(status, true) != nil {
		t.Fatal("configured retained organization family refused")
	}
}

func TestOrganizationExecutionEncodedRequestBound(t *testing.T) {
	body := strings.Repeat(`"`, 8192)
	m := &golfv1.SaveOrganizationExecutionValueRequest{Target: &golfv1.OrganizationExecutionValueTarget{Organization: "club", OrganizationId: "73"}, Id: "2d40f2fd-c269-4acb-85ad-7acf4d71daaa", OperationId: "2d40f2fd-c269-4acb-85ad-7acf4d71daab", ExpectedVersion: "0", ExpectedBrokerRevision: "0", Name: "BUILD_CREDENTIAL", Kind: golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET, Value: &body, ExpiresAt: "2026-10-05T00:00:00.123456789Z"}
	for i := 0; i < 20; i++ {
		m.SelectedRepositories = append(m.SelectedRepositories, &golfv1.OrganizationExecutionRepository{Repository: &golfv1.RepositoryKey{Owner: "club", Name: "selected-" + strconv.Itoa(i)}, RepositoryId: strconv.Itoa(1000 + i)})
	}
	encoded, e := protojson.Marshal(m)
	if e != nil || len(encoded) <= 16<<10 || len(encoded) > 64<<10 {
		t.Fatal("bounded escaped content+maximum selected request", e)
	}
	var decoded golfv1.SaveOrganizationExecutionValueRequest
	if e = protojson.Unmarshal(encoded, &decoded); e != nil || !proto.Equal(m, &decoded) {
		t.Fatal("maximum wire request lost original intent", e)
	}
	if _, e = organizationExecutionSelections(decoded.SelectedRepositories, "club"); e != nil {
		t.Fatal("maximum selected identities refused", e)
	}
}

func TestOrganizationExecutionCannotSkipOwnerApproval(t *testing.T) {
	ref := executionReference{ID: "2d40f2fd-c269-4acb-85ad-7acf4d71daaa", Version: "1", Scope: "organization", OrganizationID: "73"}
	b := &executionBindingRecord{values: []executionReference{ref}}
	if validateOrganizationExecutionApprovals(b) == nil {
		t.Fatal("inherited refs accepted without prepared owner authority")
	}
	b.organizations = []organizationExecutionApproval{{reference: ref}}
	if e := validateOrganizationExecutionApprovals(b); e != nil {
		t.Fatal(e)
	}
	b.organizations[0].reference.Version = "2"
	if validateOrganizationExecutionApprovals(b) == nil {
		t.Fatal("foreign/replaced prepared owner authority accepted")
	}
}

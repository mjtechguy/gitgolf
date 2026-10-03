package server

import (
	"strings"
	"testing"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestInfrastructureActiveVersionInventoryPostgres(t *testing.T) {
	f := newManagementFixture(t)
	objects := newWorkflowObjectFixture(t)
	enrollLocal(t, f, "alice", true)
	admin := localLogin(t, f, "alice")
	original := saveObjectProfile(t, f, admin, objectProfile(objects, "active-original"), "0")
	if response := activateObjectProfile(f, admin, original, "0", localTestPassword); response.Code != 200 {
		t.Fatal("activation failed", response.Code)
	}
	changed := proto.Clone(original).(*golfv1.InfrastructureConnection)
	changed.Label = "Saved replacement"
	changed.Bucket = "pending-replacement"
	saveObjectProfile(t, f, admin, changed, "1")
	// Active metadata must remain available independently of the latest profile
	// version and loaded inventory page. No credential is projected into it.
	for _, page := range []uint32{1, 2} {
		response := infrastructureRequest(f.s, admin, "ListInfrastructureConnections", &golfv1.ListInfrastructureConnectionsRequest{Page: &golfv1.PageRequest{Page: page, Limit: 1}})
		if response.Code != 200 {
			t.Fatal("inventory failed", response.Code)
		}
		var result golfv1.ListInfrastructureConnectionsResponse
		if err := protojson.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		active := result.ActiveConnection
		if active == nil || active.Id != original.Id || active.Version != "1" || active.Bucket != "active-original" || active.Label != original.Label || active.ActivationState != "active_ci_source_storage" || result.ActiveRevision != "1" {
			t.Fatal("inventory substituted saved draft for immutable active version")
		}
		if page == 1 && (len(result.Connections) != 1 || result.Connections[0].Version != "2" || result.Connections[0].Bucket != "pending-replacement" || result.Connections[0].ActivationState != "saved_not_active") {
			t.Fatal("latest draft/active inventory unclear")
		}
		for _, secret := range []string{"object-test-access", "object-test-secret", "encryptedCredential", "credentialBinding"} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatal("active descriptor disclosed credential material")
			}
		}
	}
}

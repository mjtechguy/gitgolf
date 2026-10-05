package server

import (
	"bytes"
	"database/sql"
	"errors"
	"strings"
	"testing"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/objectstore"
	"google.golang.org/protobuf/proto"
)

func TestWorkflowArtifactDestinationIsOriginalBinding(t *testing.T) {
	data := []byte("archive")
	sum := artifactDigest(data)
	run := workflowRunRecord{ID: "12345678-1234-4234-8234-123456789abc", AttemptID: strings.Repeat("a", 32), SourceStorage: "postgres"}
	binding, err := artifactStorageBinding(run, sum, data)
	if err != nil || !bytes.Equal(binding.Archive, data) || binding.Key != "" {
		t.Fatal("PG fallback binding changed")
	}
	run.SourceStorage = "env_s3"
	run.SourceFingerprint = strings.Repeat("b", 64)
	binding, err = artifactStorageBinding(run, sum, data)
	if err != nil || binding.Archive != nil || binding.Fingerprint != run.SourceFingerprint || binding.Key != "ci-artifacts/"+run.ID+"/"+run.AttemptID+"/"+sum+".tar" {
		t.Fatal("environment address not bound")
	}
	run.SourceStorage = "profile_s3"
	run.SourceFingerprint = ""
	run.SourceProfileID = sql.NullString{String: "12345678-1234-4234-8234-123456789abe", Valid: true}
	run.SourceProfileVersion = sql.NullInt64{Int64: 7, Valid: true}
	binding, err = artifactStorageBinding(run, sum, data)
	if err != nil || binding.ProfileID != run.SourceProfileID || binding.ProfileVersion != run.SourceProfileVersion || binding.Archive != nil {
		t.Fatal("profile version not bound")
	}
	run.SourceProfileVersion.Valid = false
	if _, err = artifactStorageBinding(run, sum, data); err == nil {
		t.Fatal("missing selected version fell back")
	}
	run.SourceStorage = "postgres"
	if _, err = artifactStorageBinding(run, sum, data); err == nil {
		t.Fatal("mixed binding accepted")
	}
	if _, err = (&Server{}).artifactObjectBytes(t.Context(), objectStorageBinding{Storage: "postgres", Archive: data}, sum, 1024); !errors.Is(err, objectstore.ErrIntegrity) {
		t.Fatal("stored size mismatch ignored")
	}
}
func TestWorkflowArtifactObjectProfileVersionSurvivesActivationPostgres(t *testing.T) {
	f := newManagementFixture(t)
	objects := newWorkflowObjectFixture(t)
	enrollLocal(t, f, "alice", true)
	admin := localLogin(t, f, "alice")
	original := saveObjectProfile(t, f, admin, objectProfile(objects, "original-artifacts"), "0")
	if got := activateObjectProfile(f, admin, original, "0", localTestPassword); got.Code != 200 {
		t.Fatal("activation", got.Code)
	}
	sourceBinding, err := f.s.storeWorkflowSource(t.Context(), []byte("original source"))
	if err != nil {
		t.Fatal(err)
	}
	run := bindingRecord(sourceBinding, []byte("original source"))
	run.ID = "12345678-1234-4234-8234-123456789abc"
	run.AttemptID = strings.Repeat("a", 32)
	archive := bytes.Repeat([]byte("x"), 1024)
	sum := artifactDigest(archive)
	binding, err := artifactStorageBinding(run, sum, archive)
	if err != nil {
		t.Fatal(err)
	}
	store, err := f.s.objectStoreForBinding(t.Context(), run)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.PutArtifactImmutable(t.Context(), binding.Key, archive, sum); err != nil {
		t.Fatal(err)
	}
	changed := proto.Clone(original).(*golfv1.InfrastructureConnection)
	changed.Bucket = "new-artifacts"
	next := saveObjectProfile(t, f, admin, changed, "1")
	if got := activateObjectProfile(f, admin, next, "1", localTestPassword); got.Code != 200 {
		t.Fatal("activation2", got.Code)
	}
	data, err := f.s.artifactObjectBytes(t.Context(), binding, sum, int64(len(archive)))
	if err != nil || !bytes.Equal(data, archive) {
		t.Fatal("new selection reinterpreted original artifact", err)
	}
	objects.mu.Lock()
	delete(objects.objects, "/original-artifacts/golf/"+binding.Key)
	objects.mu.Unlock()
	if _, err = f.s.artifactObjectBytes(t.Context(), binding, sum, int64(len(archive))); !errors.Is(err, objectstore.ErrNotFound) {
		t.Fatal("missing historical object fell back", err)
	}
}

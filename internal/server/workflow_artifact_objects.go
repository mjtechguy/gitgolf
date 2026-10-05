package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"

	"github.com/mjtechguy/golf-git/internal/objectstore"
	"github.com/mjtechguy/golf-git/internal/runner"
)

// Artifact addresses inherit the original immutable dispatch source destination,
// never whichever profile is active later. No object failure falls back to PG.
func artifactStorageBinding(run workflowRunRecord, digest string, data []byte) (objectStorageBinding, error) {
	binding := objectStorageBinding{Storage: run.SourceStorage, Fingerprint: run.SourceFingerprint, ProfileID: run.SourceProfileID, ProfileVersion: run.SourceProfileVersion}
	switch binding.Storage {
	case "postgres":
		if binding.Fingerprint != "" || binding.ProfileID.Valid || binding.ProfileVersion.Valid {
			return binding, errStorageUnavailable
		}
		binding.Archive = data
	case "env_s3":
		if len(binding.Fingerprint) != 64 || binding.ProfileID.Valid || binding.ProfileVersion.Valid {
			return binding, errStorageUnavailable
		}
	case "profile_s3":
		if binding.Fingerprint != "" || !binding.ProfileID.Valid || !binding.ProfileVersion.Valid || binding.ProfileVersion.Int64 < 1 {
			return binding, errStorageUnavailable
		}
	default:
		return binding, errStorageUnavailable
	}
	if binding.Storage != "postgres" {
		binding.Key = "ci-artifacts/" + run.ID + "/" + run.AttemptID + "/" + digest + ".tar"
	}
	return binding, nil
}
func (s *Server) artifactObjectBytes(ctx context.Context, binding objectStorageBinding, digest string, size int64) ([]byte, error) {
	if size < 1024 || size > runner.MaxArtifactArchive {
		return nil, objectstore.ErrIntegrity
	}
	if binding.Storage == "postgres" {
		if int64(len(binding.Archive)) != size || artifactDigest(binding.Archive) != digest {
			return nil, objectstore.ErrIntegrity
		}
		return binding.Archive, nil
	}
	store, err := s.objectStoreForBinding(ctx, workflowRunRecord{SourceStorage: binding.Storage, SourceFingerprint: binding.Fingerprint, SourceProfileID: binding.ProfileID, SourceProfileVersion: binding.ProfileVersion})
	if err != nil {
		return nil, err
	}
	data, err := store.GetArtifactVerified(ctx, binding.Key, digest, size)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != size {
		return nil, objectstore.ErrIntegrity
	}
	return data, nil
}
func artifactRowBinding(scanner interface{ Scan(...any) error }) (objectStorageBinding, string, int64, error) {
	var binding objectStorageBinding
	var digest string
	var size int64
	err := scanner.Scan(&binding.Archive, &binding.Storage, &binding.Key, &binding.Fingerprint, &binding.ProfileID, &binding.ProfileVersion, &digest, &size)
	return binding, digest, size, err
}

const artifactStorageColumns = `archive,storage,object_key,object_fingerprint,object_profile_id::text,object_profile_version,archive_sha256,archive_bytes`

// A single current row is used only as an original upload replay receipt.
func existingArtifact(ctx context.Context, tx *sql.Tx, run workflowRunRecord) (objectStorageBinding, string, int64, error) {
	return artifactRowBinding(tx.QueryRowContext(ctx, `SELECT `+artifactStorageColumns+` FROM golf_workflow_artifacts WHERE run_id=$1 AND attempt_id=$2`, run.ID, run.AttemptID))
}

func artifactDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

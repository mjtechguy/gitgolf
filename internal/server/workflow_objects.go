package server

import (
	"bytes"
	"connectrpc.com/connect"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"strconv"

	"github.com/mjtechguy/golf-git/internal/objectstore"
)

type objectStorageBinding struct {
	Storage, Key, Fingerprint string
	ProfileID                 sql.NullString
	ProfileVersion            sql.NullInt64
	Archive                   []byte
}

// Address bindings exclude credentials so rotating a credential for the same
// operator-configured bucket does not strand earlier content-addressed sources.
func objectStoreFingerprint(config objectstore.Config) string {
	value, _ := json.Marshal(struct {
		Endpoint, Bucket, Region, Prefix string
		PathStyle                        bool
	}{config.Endpoint, config.Bucket, config.Region, config.Prefix, config.PathStyle})
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
func (s *Server) configureObjectStore(ctx context.Context) error {
	if s.config.ObjectStoreConfig.Bucket == "" {
		return nil
	}
	store, err := objectstore.New(ctx, s.config.ObjectStoreConfig)
	if err != nil {
		return errors.New("object storage configuration is invalid")
	}
	s.defaultObjectStore = store
	s.defaultObjectStoreFingerprint = objectStoreFingerprint(s.config.ObjectStoreConfig)
	return nil
}
func (s *Server) storeWorkflowSource(ctx context.Context, source []byte) (objectStorageBinding, error) {
	store, binding, err := s.activeObjectStore(ctx)
	if err != nil {
		return binding, err
	}
	if store == nil {
		return objectStorageBinding{Storage: "postgres", Archive: source}, nil
	}
	sum := sha256.Sum256(source)
	sha := hex.EncodeToString(sum[:])
	binding.Key = "ci-sources/" + sha + ".tar"
	if err = store.PutImmutable(ctx, binding.Key, source, sha); err != nil {
		return binding, err
	}
	return binding, nil
}
func (s *Server) workflowSourceObject(ctx context.Context, run workflowRunRecord) ([]byte, error) {
	if run.SourceStorage == "postgres" {
		var source []byte
		err := s.db.QueryRowContext(ctx, `SELECT source_archive FROM golf_workflow_runs WHERE id=$1 AND forge_url=$2`, run.ID, s.config.GiteaURL).Scan(&source)
		if err != nil {
			return nil, errStorageUnavailable
		}
		sum := sha256.Sum256(source)
		if hex.EncodeToString(sum[:]) != run.SourceSHA256 {
			return nil, objectstore.ErrIntegrity
		}
		return source, nil
	}
	store, err := s.objectStoreForBinding(ctx, run)
	if err != nil {
		return nil, err
	}
	return store.GetVerified(ctx, run.SourceKey, run.SourceSHA256, maxWorkflowSource)
}

func (s *Server) infrastructureObjectStore(ctx context.Context, id string, version int64) (*objectstore.Store, error) {
	row, err := s.loadInfrastructureConnection(ctx, id, version)
	if err != nil {
		return nil, err
	}
	if row.Config.Kind != "OBJECT_STORAGE" {
		return nil, errInfrastructureConflict
	}
	if !bytes.Equal(row.CredentialBinding, infrastructureBinding(id, version)) {
		return nil, errCredentialUnavailable
	}
	value, err := s.keyring.open(row.CredentialKeyID, infrastructureConnectionDomain, row.EncryptedCredential, row.CredentialBinding)
	if err != nil {
		return nil, errCredentialUnavailable
	}
	var secret infrastructureConnectionSecret
	if json.Unmarshal([]byte(value), &secret) != nil {
		return nil, errCredentialUnavailable
	}
	c := row.Config
	return objectstore.New(ctx, objectstore.Config{Endpoint: c.Endpoint, Bucket: c.Bucket, Region: c.Region, Prefix: c.Prefix, PathStyle: c.PathStyle, AllowHTTP: c.AllowInsecure, AccessKeyID: secret.AccessKeyID, SecretAccessKey: secret.SecretAccessKey, SessionToken: secret.SessionToken})
}
func (s *Server) activeObjectStore(ctx context.Context) (*objectstore.Store, objectStorageBinding, error) {
	if s.db != nil {
		var id sql.NullString
		var version sql.NullInt64
		err := s.db.QueryRowContext(ctx, `SELECT profile_id::text,version FROM golf_active_object_connection WHERE singleton`).Scan(&id, &version)
		if err != nil {
			return nil, objectStorageBinding{}, errStorageUnavailable
		}
		if id.Valid {
			store, err := s.infrastructureObjectStore(ctx, id.String, version.Int64)
			return store, objectStorageBinding{Storage: "profile_s3", ProfileID: id, ProfileVersion: version}, err
		}
	}
	if s.defaultObjectStore != nil {
		return s.defaultObjectStore, objectStorageBinding{Storage: "env_s3", Fingerprint: s.defaultObjectStoreFingerprint}, nil
	}
	return nil, objectStorageBinding{Storage: "postgres"}, nil
}
func (s *Server) objectStoreForBinding(ctx context.Context, run workflowRunRecord) (*objectstore.Store, error) {
	switch run.SourceStorage {
	case "env_s3":
		if s.defaultObjectStore == nil || run.SourceFingerprint != s.defaultObjectStoreFingerprint {
			return nil, errInfrastructureConflict
		}
		return s.defaultObjectStore, nil
	case "profile_s3":
		if !run.SourceProfileID.Valid || !run.SourceProfileVersion.Valid {
			return nil, errStorageUnavailable
		}
		return s.infrastructureObjectStore(ctx, run.SourceProfileID.String, run.SourceProfileVersion.Int64)
	default:
		return nil, errStorageUnavailable
	}
}

// Object destinations activate independently of the primary database. A DB
// profile remains a staged cutover requiring migration and writer draining.
func (s *Server) ActivateInfrastructureConnection(ctx context.Context, req *connect.Request[golfv1.ActivateInfrastructureConnectionRequest]) (*connect.Response[golfv1.ActivateInfrastructureConnectionResponse], error) {
	credential, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	version, err := strconv.ParseInt(m.ExpectedVersion, 10, 64)
	if err != nil || version < 1 || strconv.FormatInt(version, 10) != m.ExpectedVersion || !creationKey.MatchString(m.Id) {
		return nil, rpcError(invalid("Provide the original connection ID and version."))
	}
	activeRevision, err := strconv.ParseInt(m.ExpectedActiveRevision, 10, 64)
	if err != nil || activeRevision < 0 || strconv.FormatInt(activeRevision, 10) != m.ExpectedActiveRevision {
		return nil, rpcError(invalid("Provide the original active connection revision."))
	}
	cookie := s.cookieValue(req.Header())
	confirmation, err := s.confirmInfrastructureAdmin(ctx, cookie, credential, m.PasswordConfirmation)
	if err != nil {
		return nil, infrastructureRPCError(err)
	}
	row, err := s.loadInfrastructureConnection(ctx, m.Id, version)
	if err != nil {
		return nil, rpcError(err)
	}
	if row.Config.Kind != "OBJECT_STORAGE" {
		return nil, rpcError(invalid("Database activation requires a qualified migration and cutover; it is not a live settings update."))
	}
	store, err := s.infrastructureObjectStore(ctx, m.Id, version)
	if err != nil {
		return nil, rpcError(err)
	}
	probe := []byte("Golf private object-store activation probe v1\n")
	sum := sha256.Sum256(probe)
	sha := hex.EncodeToString(sum[:])
	key := "ci-sources/" + sha + ".tar"
	if err = store.PutImmutable(ctx, key, probe, sha); err != nil {
		return nil, rpcError(err)
	}
	if _, err = store.GetVerified(ctx, key, sha, objectstore.MaxSourceBytes); err != nil {
		return nil, rpcError(err)
	}
	if err = s.requireInstanceAdmin(ctx, cookie, credential); err != nil {
		return nil, infrastructureRPCError(err)
	}
	err = s.infrastructureAdminTransaction(ctx, cookie, confirmation, func(tx *sql.Tx) error {
		var head int64
		if err := tx.QueryRowContext(ctx, `SELECT current_version FROM golf_infrastructure_connections WHERE id=$1 FOR UPDATE`, row.ID).Scan(&head); err != nil || head != version {
			return errInfrastructureConflict
		}
		var old int64
		if err := tx.QueryRowContext(ctx, `SELECT revision FROM golf_active_object_connection WHERE singleton FOR UPDATE`).Scan(&old); err != nil {
			return errStorageUnavailable
		}
		if old != activeRevision {
			return errInfrastructureConflict
		}
		_, err := tx.ExecContext(ctx, `UPDATE golf_active_object_connection SET profile_id=$1,version=$2,revision=revision+1 WHERE singleton`, row.ID, version)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO golf_infrastructure_activation_events(revision,profile_id,version,actor_user_id,actor_session_id) VALUES($1,$2,$3,$4,$5)`, activeRevision+1, row.ID, version, confirmation.UserID, confirmation.SessionID)
		return err
	})
	if err != nil {
		return nil, rpcError(err)
	}
	result := wireInfrastructureConnection(row)
	result.ActivationState = "active_ci_source_storage"
	return connect.NewResponse(&golfv1.ActivateInfrastructureConnectionResponse{Connection: result, ActiveRevision: strconv.FormatInt(activeRevision+1, 10)}), nil
}

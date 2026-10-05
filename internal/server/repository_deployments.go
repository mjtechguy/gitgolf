package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"regexp"

	"strconv"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"github.com/mjtechguy/golf-git/internal/staticpreview"
	"google.golang.org/protobuf/proto"
)

var deploymentSHA = regexp.MustCompile(`^[a-f0-9]{64}$`)

const deploymentContract = "golf.repository.local-static.v1"

var errDeployment = connect.NewError(connect.CodeFailedPrecondition, errors.New("Deployment is unavailable or its original authority changed. Inspect the original deployment."))

func deploymentError(e error) error {
	if errors.Is(e, errDeployment) {
		return errDeployment
	}
	return environmentRPCError(e)
}
func deploymentUUID(id string) bool {
	v, e := uuid.Parse(id)
	return e == nil && v.Version() == 4 && v.String() == id
}
func (s *Server) deploymentArtifact(ctx context.Context, session string, token forgeCredential, t *golfv1.RepositoryEnvironmentTarget, runID string) (*golfv1.WorkflowArtifact, *staticpreview.SiteArchive, error) {
	if !deploymentUUID(runID) {
		return nil, nil, invalid("Provide the original artifact run.")
	}
	a, data, e := s.readWorkflowArtifact(ctx, session, token, runID)
	if e != nil {
		return nil, nil, e
	}
	if a == nil || a.RepositoryId != t.RepositoryId || a.OwnerId != t.OwnerId {
		return nil, nil, errResourceNotFound
	}
	site, e := staticpreview.Parse(data)
	if e != nil || site.ArchiveSHA256 != a.ArchiveSha256 || strconv.Itoa(site.FileCount) != strconv.FormatUint(uint64(a.FileCount), 10) || strconv.FormatInt(site.FileBytes, 10) != a.FileBytes {
		return nil, nil, errDeployment
	}
	return a, site, nil
}
func (s *Server) PrepareStaticDeployment(ctx context.Context, r *connect.Request[golfv1.PrepareStaticDeploymentRequest]) (*connect.Response[golfv1.PrepareStaticDeploymentResponse], error) {
	token, _, e := s.reviewDraftCaller(ctx, r.Header())
	if e != nil {
		return nil, deploymentError(e)
	}
	key, _, _, e := environmentTarget(r.Msg.Target)
	if e != nil {
		return nil, deploymentError(e)
	}
	user, e := s.currentUser(ctx, token)
	if e == nil {
		e = s.environmentAuthority(ctx, token, key, user, r.Msg.Target, true, true)
	}
	if e != nil {
		return nil, deploymentError(e)
	}
	a, site, e := s.deploymentArtifact(ctx, s.cookieValue(r.Header()), token, r.Msg.Target, r.Msg.RunId)
	if e != nil {
		return nil, deploymentError(e)
	}
	out := &golfv1.PrepareStaticDeploymentResponse{Target: r.Msg.Target, Artifact: a, ManifestSha256: site.ManifestSHA256, Available: s.previewAvailable(), Reason: "target_unavailable"}
	if s.previewAvailable() {
		out.TargetFingerprint = s.preview.fingerprint
		out.Reason = ""
	}
	for _, root := range site.Roots() {
		out.Roots = append(out.Roots, &golfv1.StaticPreviewRoot{Path: root.Path, EntryPath: root.EntryPath})
	}
	e = s.environmentAuthority(ctx, token, key, user, r.Msg.Target, true, true)
	if e != nil {
		return nil, deploymentError(e)
	}
	return connect.NewResponse(out), nil
}

type deploymentRecord struct {
	wire               *golfv1.RepositoryDeployment
	user               int64
	session, inputHash []byte
	created, updated   time.Time
	expires            sql.NullTime
}

const deploymentColumns = "receipt,user_id,session_hash,input_hash,state,version,created_at,updated_at,expires_at,native_actor_id,run_id::text,attempt_id,archive_sha256,environment_id::text,environment_version,repository_id,owner_id"

func scanDeployment(row interface{ Scan(...any) error }) (*deploymentRecord, error) {
	d := &deploymentRecord{wire: &golfv1.RepositoryDeployment{}}
	var raw []byte
	var state string
	var version, native, envVersion, repo, owner int64
	var run, attempt, archive, environment string
	e := row.Scan(&raw, &d.user, &d.session, &d.inputHash, &state, &version, &d.created, &d.updated, &d.expires, &native, &run, &attempt, &archive, &environment, &envVersion, &repo, &owner)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, errResourceNotFound
	}
	if e != nil {
		return nil, errStorageUnavailable
	}
	if proto.Unmarshal(raw, d.wire) != nil || d.wire.Contract != deploymentContract || d.wire.Target == nil || d.wire.Artifact == nil || validateEnvironmentPolicy(d.wire.Policy) != nil || validateSourceSelector(d.wire.Source) != nil {
		return nil, errStorageUnavailable
	}

	if d.wire.ActorId != strconv.FormatInt(native, 10) || d.wire.Target.RepositoryId != strconv.FormatInt(repo, 10) || d.wire.Target.OwnerId != strconv.FormatInt(owner, 10) || d.wire.Artifact.RunId != run || d.wire.Artifact.AttemptId != attempt || d.wire.Artifact.ArchiveSha256 != archive || d.wire.EnvironmentId != environment || d.wire.EnvironmentVersion != strconv.FormatInt(envVersion, 10) {
		return nil, errStorageUnavailable
	}
	original := &golfv1.CreateRepositoryDeploymentRequest{Target: d.wire.Target, DeploymentId: d.wire.Id, RunId: run, AttemptId: attempt, CommitId: d.wire.Artifact.CommitId, ArchiveSha256: archive, ManifestSha256: d.wire.ManifestSha256, EnvironmentId: environment, EnvironmentVersion: d.wire.EnvironmentVersion, Source: d.wire.Source, StaticRoot: d.wire.StaticRoot, TargetFingerprint: d.wire.TargetFingerprint}
	if !bytes.Equal(deploymentIntent(original), d.inputHash) {
		return nil, errStorageUnavailable
	}
	d.wire.State = state
	d.wire.Version = strconv.FormatInt(version, 10)
	d.wire.CreatedAt = d.created.UTC().Format(time.RFC3339Nano)
	d.wire.UpdatedAt = d.updated.UTC().Format(time.RFC3339Nano)
	d.wire.EligibleAt = d.created.Add(time.Duration(d.wire.Policy.WaitSeconds) * time.Second).UTC().Format(time.RFC3339Nano)
	if d.expires.Valid {
		d.wire.ExpiresAt = d.expires.Time.UTC().Format(time.RFC3339Nano)
	}
	return d, nil
}
func (s *Server) deploymentRecord(ctx context.Context, id string) (*deploymentRecord, error) {
	if !deploymentUUID(id) {
		return nil, invalid("Provide the original deployment identity.")
	}
	d, e := scanDeployment(s.db.QueryRowContext(ctx, "SELECT "+deploymentColumns+" FROM golf_repository_deployments WHERE id=$1 AND forge_url=$2", id, s.config.GiteaURL))
	if e != nil {
		return nil, e
	}
	if d.wire.State == "READY" && d.expires.Valid && !d.expires.Time.After(time.Now()) {
		return s.expireDeployment(ctx, d)
	}
	return d, nil
}
func deploymentIntent(m *golfv1.CreateRepositoryDeploymentRequest) []byte {
	copy := proto.Clone(m).(*golfv1.CreateRepositoryDeploymentRequest)
	copy.CurrentPassword = ""
	raw, _ := proto.MarshalOptions{Deterministic: true}.Marshal(copy)
	sum := sha256.Sum256(raw)
	return sum[:]
}
func deploymentSourceAllowed(p *golfv1.RepositoryEnvironmentPolicy, source *golfv1.RepositorySourceSelector) bool {
	if validateSourceSelector(source) != nil || source.Kind == golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_DEFAULT_BRANCH {
		return false
	}
	if p.AllowAllSources {
		return true
	}
	for _, v := range p.Sources {
		if proto.Equal(v, source) {
			return true
		}
	}
	return false
}
func (s *Server) deploymentSource(ctx context.Context, token forgeCredential, d *golfv1.RepositoryDeployment) error {
	base, e := repositoryPath(keyFrom(d.Target.Repository))
	if e != nil {
		return e
	}
	var h string
	switch d.Source.Kind {
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_COMMIT:
		h = d.Source.Name
		e = s.exactSourceCommit(ctx, base, token, h)
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH:
		h, e = s.exactSourceBranch(ctx, base, token, d.Source.Name)
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_TAG:
		var tag forgeTag
		tag, e = s.exactSourceTag(ctx, base, token, d.Source.Name)
		h = tag.Commit.SHA
	default:
		return errDeployment
	}
	if e != nil {
		return e
	}
	if h != d.Artifact.CommitId {
		return errDeployment
	}
	return nil
}
func (s *Server) createRepositoryDeployment(ctx context.Context, r *connect.Request[golfv1.CreateRepositoryDeploymentRequest]) (*connect.Response[golfv1.RepositoryDeploymentResponse], error) {
	m := r.Msg
	token, _, e := s.reviewDraftCaller(ctx, r.Header())
	if e != nil {
		return nil, deploymentError(e)
	}
	key, repo, owner, e := environmentTarget(m.Target)
	if e != nil {
		return nil, deploymentError(e)
	}
	if !s.previewAvailable() || m.TargetFingerprint != s.preview.fingerprint {
		return nil, errDeployment
	}
	if !deploymentUUID(m.DeploymentId) || !deploymentUUID(m.EnvironmentId) || !attemptIdentifier.MatchString(m.AttemptId) || !deploymentSHA.MatchString(m.ArchiveSha256) || !deploymentSHA.MatchString(m.ManifestSha256) || !objectID.MatchString(m.CommitId) || validateSourceSelector(m.Source) != nil || len(m.ProtoReflect().GetUnknown()) != 0 {
		return nil, invalid("Provide the exact prepared static deployment.")
	}
	version, e := discussionID(m.EnvironmentVersion)
	if e != nil {
		return nil, invalid("Provide the selected environment version.")
	}
	hash := deploymentIntent(m)
	session := s.cookieValue(r.Header())
	user, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, deploymentError(e)
	}
	// Original replay never reconstructs source or refreshes the accepted identity.
	if original, e := s.deploymentRecord(ctx, m.DeploymentId); e == nil {
		if original.wire.ActorId != strconv.FormatInt(user.ID, 10) || original.wire.Target.RepositoryId != m.Target.RepositoryId || original.wire.Target.OwnerId != m.Target.OwnerId {
			return nil, deploymentError(errResourceNotFound)
		}
		if !bytes.Equal(original.inputHash, hash) {
			return nil, errDeployment
		}
		return s.deploymentResponse(ctx, session, token, m.Target, original)
	} else if !errors.Is(e, errResourceNotFound) {
		return nil, deploymentError(e)
	}
	password, e := s.environmentPassword(ctx, session, token, m.CurrentPassword)
	if e != nil {
		return nil, deploymentError(e)
	}
	a, site, e := s.deploymentArtifact(ctx, session, token, m.Target, m.RunId)
	if e != nil {
		return nil, deploymentError(e)
	}
	if a.AttemptId != m.AttemptId || a.CommitId != m.CommitId || a.ArchiveSha256 != m.ArchiveSha256 || site.ManifestSHA256 != m.ManifestSha256 {
		return nil, errDeployment
	}
	rootOK := false
	for _, root := range site.Roots() {
		rootOK = rootOK || root.Path == m.StaticRoot
	}
	if !rootOK {
		return nil, invalid("Select an exact prepared static root.")
	}
	var record *deploymentRecord
	e = s.workflowTransaction(ctx, session, user.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, sessionHash []byte) error {
		q := database.New(s.db).WithTx(tx)
		if e := environmentPasswordCurrent(ctx, q, sessionHash, s.config.GiteaURL, password); e != nil {
			return e
		}
		if _, e := tx.ExecContext(ctx, "SELECT golf_deployment_lock($1,$2)", s.config.GiteaURL, repo); e != nil {
			return errStorageUnavailable
		}
		var blocked bool
		if tx.QueryRowContext(ctx, "SELECT golf_repository_lifecycle_blocked($1,$2)", s.config.GiteaURL, repo).Scan(&blocked) != nil {
			return errStorageUnavailable
		}
		if blocked {
			return errLifecycleBlocked
		}
		v, e := q.GetRepositoryEnvironment(ctx, database.GetRepositoryEnvironmentParams{ForgeURL: s.config.GiteaURL, ID: uuid.MustParse(m.EnvironmentId), RepositoryID: repo, OwnerID: owner})
		if e != nil || v.Deleted || v.Version != version {
			return errDeployment
		}
		env, e := wireEnvironment(v)
		if e != nil {
			return e
		}
		if !deploymentSourceAllowed(env.Policy, m.Source) {
			return errDeployment
		}
		run, e := s.loadWorkflowRun(ctx, m.RunId)
		if e != nil {
			return e
		}
		d := &golfv1.RepositoryDeployment{Contract: deploymentContract, Id: m.DeploymentId, ActorId: strconv.FormatInt(user.ID, 10), Target: m.Target, Artifact: a, ManifestSha256: m.ManifestSha256, EnvironmentId: m.EnvironmentId, EnvironmentVersion: m.EnvironmentVersion, EnvironmentName: env.Name, Policy: env.Policy, Source: m.Source, StaticRoot: m.StaticRoot, TargetFingerprint: m.TargetFingerprint, ArtifactStorage: run.SourceStorage, ArtifactStorageFingerprint: run.SourceFingerprint}
		if run.SourceProfileID.Valid {
			d.ArtifactProfileId = run.SourceProfileID.String
			d.ArtifactProfileVersion = strconv.FormatInt(run.SourceProfileVersion.Int64, 10)
		}
		if e = s.environmentAuthority(ctx, token, key, user, m.Target, true, true); e != nil {
			return e
		}
		if e = s.deploymentSource(ctx, token, d); e != nil {
			return e
		}
		var count int
		if tx.QueryRowContext(ctx, "SELECT count(*) FROM golf_repository_deployments WHERE forge_url=$1 AND repository_id=$2", s.config.GiteaURL, repo).Scan(&count) != nil {
			return errStorageUnavailable
		}
		if count >= 100 {
			return errDeployment
		}
		data, _ := proto.Marshal(d)
		_, e = tx.ExecContext(ctx, "INSERT INTO golf_repository_deployments(id,forge_url,repository_id,owner_id,user_id,native_actor_id,session_hash,run_id,attempt_id,archive_sha256,environment_id,environment_version,input_hash,receipt,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'REQUESTED')", m.DeploymentId, s.config.GiteaURL, repo, owner, actor.UserID, user.ID, sessionHash, m.RunId, m.AttemptId, m.ArchiveSha256, m.EnvironmentId, version, hash, data)
		if e != nil {
			return errStorageUnavailable
		}
		record, e = scanDeployment(tx.QueryRowContext(ctx, "SELECT "+deploymentColumns+" FROM golf_repository_deployments WHERE id=$1", m.DeploymentId))
		if e != nil {
			return e
		}
		if e = deploymentEvent(ctx, tx, record, actor.UserID); e != nil {
			return e
		}
		if e = s.environmentAuthority(ctx, token, key, user, m.Target, true, true); e != nil {
			return e
		}
		return s.deploymentSource(ctx, token, d)
	})
	if e != nil {
		return nil, deploymentError(e)
	}
	return s.deploymentResponse(ctx, session, token, m.Target, record)
}
func deploymentEvent(ctx context.Context, tx *sql.Tx, d *deploymentRecord, actor int64) error {
	_, e := tx.ExecContext(ctx, "INSERT INTO golf_deployment_events(deployment_id,version,state,actor_id) VALUES($1,$2,$3,$4)", d.wire.Id, d.wire.Version, d.wire.State, actor)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

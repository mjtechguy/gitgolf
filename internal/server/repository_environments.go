package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

var errEnvironmentCAS = errors.New("Environment changed; inspect the current configuration before a new action.")
var errEnvironmentIntent = errors.New("The original environment operation does not match this request.")

func environmentRPCError(e error) error {
	if errors.Is(e, errEnvironmentCAS) {
		return connect.NewError(connect.CodeAborted, errEnvironmentCAS)
	}
	if errors.Is(e, errEnvironmentIntent) || errors.Is(e, errRepositoryAccessConflict) {
		return connect.NewError(connect.CodeFailedPrecondition, e)
	}
	var pe *pgconn.PgError
	if errors.As(e, &pe) && pe.Code == "23505" {
		return connect.NewError(connect.CodeAlreadyExists, errors.New("Environment name or identity already exists; inspect the current inventory."))
	}
	if errors.As(e, &pe) {
		return infrastructureRPCError(errStorageUnavailable)
	}
	return infrastructureRPCError(e)
}
func environmentTarget(t *golfv1.RepositoryEnvironmentTarget) (repositoryKey, int64, int64, error) {
	if t == nil || len(t.ProtoReflect().GetUnknown()) != 0 || t.Repository == nil || len(t.Repository.ProtoReflect().GetUnknown()) != 0 {
		return repositoryKey{}, 0, 0, invalid("Provide the current repository environment target.")
	}
	key := keyFrom(t.Repository)
	if e := validateRepositoryAccess(key, t.RepositoryId, t.OwnerId, t.AccessRevision, ""); e != nil {
		return key, 0, 0, e
	}
	repo, _ := discussionID(t.RepositoryId)
	owner, _ := discussionID(t.OwnerId)
	return key, repo, owner, nil
}
func validateEnvironmentPolicy(p *golfv1.RepositoryEnvironmentPolicy) error {
	if p == nil || len(p.ProtoReflect().GetUnknown()) != 0 || len(p.Sources) > 20 || len(p.Reviewers) > 6 || p.RequiredApprovals > uint32(len(p.Reviewers)) || (p.RequiredApprovals == 0 && len(p.Reviewers) != 0) || p.WaitSeconds > 86400 || p.MaxConcurrency < 1 || p.MaxConcurrency > 10 || !p.PreventSelfApproval || p.AllowAdminBypass || !p.ProtectedPreviews || p.PreviewTtlSeconds < 60 || p.PreviewTtlSeconds > 604800 {
		return invalid("Provide bounded environment policy with independent approvals, protected previews and no administrator bypass.")
	}
	if p.AllowAllSources != (len(p.Sources) == 0) {
		return invalid("Explicitly select all sources or a nonempty exact source list.")
	}
	refs := map[string]bool{}
	for _, r := range p.Sources {
		if r == nil || len(r.ProtoReflect().GetUnknown()) != 0 || r.Kind == golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_DEFAULT_BRANCH {
			return invalid("Environment sources require explicit branch, tag or full commit selectors.")
		}
		if e := validateSourceSelector(r); e != nil {
			return e
		}
		key := strconv.Itoa(int(r.Kind)) + "\x00" + r.Name
		if refs[key] {
			return invalid("Environment source selectors must be unique.")
		}
		refs[key] = true
	}
	ids, logins := map[string]bool{}, map[string]bool{}
	for _, r := range p.Reviewers {
		if r == nil || len(r.ProtoReflect().GetUnknown()) != 0 {
			return invalid("Provide exact reviewer identities.")
		}
		if _, e := discussionID(r.Id); e != nil || !validOrganizationName(r.Login) || ids[r.Id] || logins[strings.ToLower(r.Login)] {
			return invalid("Reviewers require unique native ID/login pairs.")
		}
		ids[r.Id] = true
		logins[strings.ToLower(r.Login)] = true
	}
	if proto.Size(p) > 16384 {
		return invalid("Environment policy exceeds the bounded configuration size.")
	}
	return nil
}
func validateEnvironmentName(name string) error {
	if name == "" || len(name) > 128 || !utf8.ValidString(name) || strings.TrimSpace(name) != name || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return invalid("Environment names must be trimmed, readable UTF-8 text of at most 128 bytes.")
	}
	return nil
}

// The password is deliberately absent. This sanitized typed input preserves
// original field presence and ordered selectors/reviewers, not just equivalence.
func environmentFingerprint(m proto.Message) ([]byte, error) {
	if len(m.ProtoReflect().GetUnknown()) != 0 {
		return nil, invalid("Unknown environment intent fields are unsupported.")
	}
	copy := proto.Clone(m)
	switch c := copy.(type) {
	case *golfv1.SaveRepositoryEnvironmentRequest:
		c.CurrentPassword = ""
	case *golfv1.DeleteRepositoryEnvironmentRequest:
		c.CurrentPassword = ""
	default:
		return nil, errStorageUnavailable
	}
	raw, e := proto.MarshalOptions{Deterministic: true}.Marshal(copy)
	if e != nil {
		return nil, errStorageUnavailable
	}
	h := sha256.Sum256(raw)
	return h[:], nil
}
func (s *Server) environmentReferences(ctx context.Context, token forgeCredential, key repositoryKey, p *golfv1.RepositoryEnvironmentPolicy) error {
	for _, r := range p.Reviewers {
		user, e := s.readTeamTarget(ctx, token, r.Login)
		if e != nil {
			return e
		}
		if strconv.FormatInt(user.ID, 10) != r.Id || user.Login != r.Login {
			return errRepositoryAccessConflict
		}
	}
	base, _ := repositoryPath(key)
	for _, r := range p.Sources {
		if r.Kind == golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_COMMIT {
			if e := s.exactSourceCommit(ctx, base, token, r.Name); e != nil {
				return e
			}
		}
	}
	return nil
}
func environmentMatches(a *golfv1.RepositoryAccess, t *golfv1.RepositoryEnvironmentTarget, revision bool) error {
	if a == nil || a.RepositoryId != t.RepositoryId || a.OwnerId != t.OwnerId || (revision && a.Revision != t.AccessRevision) {
		return errRepositoryAccessConflict
	}
	return nil
}
func (s *Server) environmentAuthority(ctx context.Context, token forgeCredential, key repositoryKey, caller User, t *golfv1.RepositoryEnvironmentTarget, write, revision bool) error {
	var a *golfv1.RepositoryAccess
	var e error
	if write {
		a, e = s.readRepositoryAccess(ctx, token, key, caller)
		if e == nil && !a.CanManage {
			return forgeError{http.StatusForbidden}
		}
	} else {
		a, e = s.rulesAuthority(ctx, token, key, caller)
	}
	if e != nil {
		return e
	}
	return environmentMatches(a, t, revision)
}
func wireEnvironment(v database.GolfRepositoryEnvironmentVersion) (*golfv1.RepositoryEnvironment, error) {
	p := new(golfv1.RepositoryEnvironmentPolicy)
	if proto.Unmarshal(v.Policy, p) != nil || validateEnvironmentPolicy(p) != nil || validateEnvironmentName(v.Name) != nil || v.Version < 1 || v.CreatorNativeID <= 0 || v.ActorNativeID <= 0 || v.CreatedAt.Before(v.EnvironmentCreatedAt) {
		return nil, errStorageUnavailable
	}
	target := &golfv1.RepositoryEnvironmentTarget{Repository: &golfv1.RepositoryKey{Owner: v.RepositoryOwner, Name: v.RepositoryName}, RepositoryId: strconv.FormatInt(v.RepositoryID, 10), OwnerId: strconv.FormatInt(v.OwnerID, 10), AccessRevision: v.AccessRevision}
	if _, _, _, e := environmentTarget(target); e != nil || !creationKey.MatchString(v.EnvironmentID.String()) || v.EnvironmentCreatedAt.IsZero() {
		return nil, errStorageUnavailable
	}
	return &golfv1.RepositoryEnvironment{Id: v.EnvironmentID.String(), Target: &golfv1.RepositoryEnvironmentTarget{Repository: &golfv1.RepositoryKey{Owner: v.RepositoryOwner, Name: v.RepositoryName}, RepositoryId: strconv.FormatInt(v.RepositoryID, 10), OwnerId: strconv.FormatInt(v.OwnerID, 10), AccessRevision: v.AccessRevision}, Name: v.Name, Version: strconv.FormatInt(v.Version, 10), Policy: p, CreatorId: strconv.FormatInt(v.CreatorNativeID, 10), UpdaterId: strconv.FormatInt(v.ActorNativeID, 10), CreatedAt: v.EnvironmentCreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: v.CreatedAt.UTC().Format(time.RFC3339Nano), Deleted: v.Deleted, Capability: golfv1.RepositoryEnvironmentCapability_REPOSITORY_ENVIRONMENT_CAPABILITY_CONFIGURATION_ONLY, DeploymentAvailable: false}, nil
}
func wireEnvironmentOperation(op database.GolfRepositoryEnvironmentOperation, v database.GolfRepositoryEnvironmentVersion) (*golfv1.RepositoryEnvironmentOperation, *golfv1.RepositoryEnvironment, error) {
	env, e := wireEnvironment(v)
	if e != nil {
		return nil, nil, e
	}
	action := golfv1.RepositoryEnvironmentAction_REPOSITORY_ENVIRONMENT_ACTION_SAVE
	if op.Action == "delete" {
		action = golfv1.RepositoryEnvironmentAction_REPOSITORY_ENVIRONMENT_ACTION_DELETE
	} else if op.Action != "save" {
		return nil, nil, errStorageUnavailable
	}
	if op.EnvironmentID != v.EnvironmentID || op.RepositoryID != v.RepositoryID || op.OwnerID != v.OwnerID || op.Version != v.Version || op.UserID != v.ActorUserID || !op.CreatedAt.Equal(v.CreatedAt) || v.Deleted != (op.Action == "delete") {
		return nil, nil, errStorageUnavailable
	}
	return &golfv1.RepositoryEnvironmentOperation{OperationId: op.OperationID.String(), EnvironmentId: env.Id, Target: env.Target, ActorId: env.UpdaterId, Action: action, ExpectedVersion: strconv.FormatInt(op.ExpectedVersion, 10), Version: env.Version, State: "SUCCEEDED", CreatedAt: op.CreatedAt.UTC().Format(time.RFC3339Nano)}, env, nil
}
func (s *Server) environmentOriginal(ctx context.Context, q *database.Queries, actor int64, id uuid.UUID, repo, owner int64) (database.GolfRepositoryEnvironmentOperation, database.GolfRepositoryEnvironmentVersion, error) {
	op, e := q.GetOwnRepositoryEnvironmentOperation(ctx, database.GetOwnRepositoryEnvironmentOperationParams{UserID: actor, OperationID: id, ForgeURL: s.config.GiteaURL})
	if e != nil {
		return op, database.GolfRepositoryEnvironmentVersion{}, e
	}
	if op.RepositoryID != repo || op.OwnerID != owner {
		return op, database.GolfRepositoryEnvironmentVersion{}, errEnvironmentIntent
	}
	v, e := q.GetRepositoryEnvironmentVersion(ctx, database.GetRepositoryEnvironmentVersionParams{ForgeURL: s.config.GiteaURL, EnvironmentID: op.EnvironmentID, Version: op.Version, RepositoryID: repo, OwnerID: owner})
	return op, v, e
}
func (s *Server) environmentPassword(ctx context.Context, value string, token forgeCredential, password string) (database.GetOwnPasswordConfirmationRow, error) {
	initial, e := s.ownSecuritySnapshot(ctx, value, token)
	if e != nil {
		return initial, e
	}
	if e = s.consumeLocalLogin(ctx, initial.Username); e != nil {
		return initial, e
	}
	correct, e := verifyLocalPassword(ctx, password, initial.PasswordHash)
	if e != nil {
		return initial, e
	}
	if !correct {
		return initial, errPasswordConfirmation
	}
	latest, e := s.ownSecuritySnapshot(ctx, value, token)
	if e != nil {
		return initial, e
	}
	if !sameOwnSecurity(initial, latest) {
		return initial, errUnauthenticated
	}
	return initial, nil
}
func environmentPasswordCurrent(ctx context.Context, q *database.Queries, hash []byte, forge string, initial database.GetOwnPasswordConfirmationRow) error {
	row, e := q.GetOwnPasswordConfirmation(ctx, database.GetOwnPasswordConfirmationParams{TokenHash: hash, ForgeURL: forge})
	if e != nil || !sameOwnSecurity(initial, row) {
		return errUnauthenticated
	}
	return nil
}

func (s *Server) ListRepositoryEnvironments(ctx context.Context, req *connect.Request[golfv1.ListRepositoryEnvironmentsRequest]) (*connect.Response[golfv1.ListRepositoryEnvironmentsResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	key, repo, owner, e := environmentTarget(req.Msg.Target)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	page, limit, e := pagination(pageFrom(req.Msg.Page))
	if e != nil {
		return nil, environmentRPCError(e)
	}
	if limit > 20 {
		return nil, environmentRPCError(invalid("Environment inventory page size is at most 20."))
	}
	out := &golfv1.ListRepositoryEnvironmentsResponse{Target: proto.Clone(req.Msg.Target).(*golfv1.RepositoryEnvironmentTarget), Capability: golfv1.RepositoryEnvironmentCapability_REPOSITORY_ENVIRONMENT_CAPABILITY_CONFIGURATION_ONLY}
	e = s.withForgeCaller(ctx, session, token, func(caller User) error {
		txErr := s.workflowTransaction(ctx, session, caller.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, hash []byte) error {
			if e := s.environmentAuthority(ctx, token, key, caller, req.Msg.Target, false, true); e != nil {
				return e
			}
			if _, e := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended($1||'/repository-environments/'||$2::bigint::text,0))`, s.config.GiteaURL, repo); e != nil {
				return errStorageUnavailable
			}
			q := database.New(s.db).WithTx(tx)
			total, e := q.CountRepositoryEnvironments(ctx, database.CountRepositoryEnvironmentsParams{ForgeURL: s.config.GiteaURL, RepositoryID: repo, OwnerID: owner})
			if e != nil {
				return errStorageUnavailable
			}
			rows, e := q.ListRepositoryEnvironments(ctx, database.ListRepositoryEnvironmentsParams{ForgeURL: s.config.GiteaURL, RepositoryID: repo, OwnerID: owner, Limit: int32(limit), Offset: int32((page - 1) * limit)})
			if e != nil {
				return errStorageUnavailable
			}
			out.TotalCount = strconv.FormatInt(total, 10)
			out.Page = &golfv1.PageResponse{}
			if int64(page*limit) < total {
				out.Page.NextPage = page + 1
			}
			for _, row := range rows {
				env, e := wireEnvironment(row)
				if e != nil {
					return e
				}
				out.Environments = append(out.Environments, env)
			}
			return s.environmentAuthority(ctx, token, key, caller, req.Msg.Target, false, true)
		})
		if txErr != nil {
			return txErr
		}
		return s.environmentAuthority(ctx, token, key, caller, req.Msg.Target, false, true)
	})
	if e != nil {
		return nil, environmentRPCError(e)
	}
	r := connect.NewResponse(out)
	r.Header().Set("Cache-Control", "no-store")
	return r, nil
}
func (s *Server) GetRepositoryEnvironmentOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryEnvironmentOperationRequest]) (*connect.Response[golfv1.GetRepositoryEnvironmentOperationResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	key, repo, owner, e := environmentTarget(req.Msg.Target)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	if !creationKey.MatchString(req.Msg.OperationId) {
		return nil, environmentRPCError(invalid("Provide the original canonical operation ID."))
	}
	var out *golfv1.GetRepositoryEnvironmentOperationResponse
	e = s.withForgeCaller(ctx, session, token, func(caller User) error {
		txErr := s.workflowTransaction(ctx, session, caller.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, hash []byte) error {
			if e := s.environmentAuthority(ctx, token, key, caller, req.Msg.Target, false, true); e != nil {
				return e
			}
			op, v, e := s.environmentOriginal(ctx, database.New(s.db).WithTx(tx), actor.UserID, uuid.MustParse(req.Msg.OperationId), repo, owner)
			if errors.Is(e, sql.ErrNoRows) {
				return errResourceNotFound
			}
			if e != nil {
				return e
			}
			receipt, env, e := wireEnvironmentOperation(op, v)
			if e != nil {
				return e
			}
			out = &golfv1.GetRepositoryEnvironmentOperationResponse{Operation: receipt, Environment: env}
			return s.environmentAuthority(ctx, token, key, caller, req.Msg.Target, false, true)
		})
		if txErr != nil {
			return txErr
		}
		return s.environmentAuthority(ctx, token, key, caller, req.Msg.Target, false, true)
	})
	if e != nil {
		return nil, environmentRPCError(e)
	}
	r := connect.NewResponse(out)
	r.Header().Set("Cache-Control", "no-store")
	return r, nil
}

type environmentChange struct {
	target              *golfv1.RepositoryEnvironmentTarget
	id, operation, name string
	version             int64
	policy              *golfv1.RepositoryEnvironmentPolicy
	deleted             bool
	fingerprint         []byte
	password            string
}

func (s *Server) changeRepositoryEnvironment(ctx context.Context, token forgeCredential, session string, in environmentChange) (*golfv1.RepositoryEnvironment, *golfv1.RepositoryEnvironmentOperation, error) {
	key, repo, owner, _ := environmentTarget(in.target)
	initial, e := s.environmentPassword(ctx, session, token, in.password)
	if e != nil {
		return nil, nil, e
	}
	var env *golfv1.RepositoryEnvironment
	var receipt *golfv1.RepositoryEnvironmentOperation
	e = s.withForgeCaller(ctx, session, token, func(caller User) error {
		txErr := s.workflowTransaction(ctx, session, caller.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, hash []byte) error {
			q := database.New(s.db).WithTx(tx)
			if e := environmentPasswordCurrent(ctx, q, hash, s.config.GiteaURL, initial); e != nil {
				return e
			}
			// Replay never re-sends a mutation, and does not require an old revision to
			// become current again. Current ordinary administration and native IDs do.
			if e := s.environmentAuthority(ctx, token, key, caller, in.target, false, false); e != nil {
				return e
			}
			op, v, e := s.environmentOriginal(ctx, q, actor.UserID, uuid.MustParse(in.operation), repo, owner)
			if e == nil {
				if !bytes.Equal(op.InputFingerprint, in.fingerprint) {
					return errEnvironmentIntent
				}
				receipt, env, e = wireEnvironmentOperation(op, v)
				if e != nil {
					return e
				}
				if e = environmentPasswordCurrent(ctx, q, hash, s.config.GiteaURL, initial); e != nil {
					return e
				}
				return s.environmentAuthority(ctx, token, key, caller, in.target, false, false)
			}
			if !errors.Is(e, sql.ErrNoRows) {
				return e
			}
			if e = s.environmentAuthority(ctx, token, key, caller, in.target, true, true); e != nil {
				return e
			}
			if _, e = s.lockRepositoryLifecycleTransaction(ctx, tx, repo); e != nil {
				return e
			}
			if e = q.LockRepositoryEnvironments(ctx, database.LockRepositoryEnvironmentsParams{ForgeURL: s.config.GiteaURL, RepositoryID: repo}); e != nil {
				return errStorageUnavailable
			}
			// Refresh authority, credential version and configured identities after wait.
			if e = environmentPasswordCurrent(ctx, q, hash, s.config.GiteaURL, initial); e != nil {
				return e
			}
			if e = s.environmentAuthority(ctx, token, key, caller, in.target, true, true); e != nil {
				return e
			}
			prior, e := q.GetRepositoryEnvironment(ctx, database.GetRepositoryEnvironmentParams{ForgeURL: s.config.GiteaURL, ID: uuid.MustParse(in.id), RepositoryID: repo, OwnerID: owner})
			if in.version == 0 {
				if e == nil {
					return errEnvironmentCAS
				}
				if !errors.Is(e, sql.ErrNoRows) {
					return errStorageUnavailable
				}
			} else {
				if errors.Is(e, sql.ErrNoRows) {
					return errResourceNotFound
				}
				if e != nil {
					return errStorageUnavailable
				}
				if prior.Deleted || prior.Version != in.version {
					return errEnvironmentCAS
				}
			}
			if in.deleted {
				in.name = prior.Name
				p := new(golfv1.RepositoryEnvironmentPolicy)
				if proto.Unmarshal(prior.Policy, p) != nil {
					return errStorageUnavailable
				}
				in.policy = p
			}
			if !in.deleted {
				if e = s.environmentReferences(ctx, token, key, in.policy); e != nil {
					return e
				}
			}
			count, e := q.CountRepositoryEnvironmentOperations(ctx, database.CountRepositoryEnvironmentOperationsParams{ForgeURL: s.config.GiteaURL, RepositoryID: repo})
			if e != nil {
				return errStorageUnavailable
			}
			max := int64(900)
			if in.deleted {
				max = 1000
			}
			if count >= max {
				return connect.NewError(connect.CodeResourceExhausted, errors.New("Environment operation retention limit reached; inspect retained configuration and qualified recovery policy."))
			}
			if in.version == 0 {
				n, e := q.CountRepositoryEnvironments(ctx, database.CountRepositoryEnvironmentsParams{ForgeURL: s.config.GiteaURL, RepositoryID: repo, OwnerID: owner})
				if e != nil {
					return errStorageUnavailable
				}
				if n >= 100 {
					return connect.NewError(connect.CodeResourceExhausted, errors.New("Repository environment inventory limit reached."))
				}
				e = q.InsertRepositoryEnvironment(ctx, database.InsertRepositoryEnvironmentParams{ForgeURL: s.config.GiteaURL, ID: uuid.MustParse(in.id), RepositoryID: repo, OwnerID: owner, Column5: in.name})
				if e != nil {
					return e
				}
			} else {
				n, e := q.AdvanceRepositoryEnvironment(ctx, database.AdvanceRepositoryEnvironmentParams{ForgeURL: s.config.GiteaURL, ID: uuid.MustParse(in.id), RepositoryID: repo, OwnerID: owner, Column5: in.name, Deleted: in.deleted, CurrentVersion: in.version})
				if e != nil {
					return e
				}
				if n != 1 {
					return errEnvironmentCAS
				}
			}
			raw, e := proto.MarshalOptions{Deterministic: true}.Marshal(in.policy)
			if e != nil {
				return errStorageUnavailable
			}
			now := time.Now().UTC().Truncate(time.Microsecond)
			creator, creatorNative, created := actor.UserID, caller.ID, now
			if in.version > 0 {
				creator, creatorNative, created = prior.CreatorUserID, prior.CreatorNativeID, prior.EnvironmentCreatedAt
			}
			v, e = q.InsertRepositoryEnvironmentVersion(ctx, database.InsertRepositoryEnvironmentVersionParams{ForgeURL: s.config.GiteaURL, EnvironmentID: uuid.MustParse(in.id), RepositoryID: repo, OwnerID: owner, Version: in.version + 1, Name: in.name, Deleted: in.deleted, Policy: raw, CreatorUserID: creator, CreatorNativeID: creatorNative, ActorUserID: actor.UserID, ActorNativeID: caller.ID, RepositoryOwner: key.Owner, RepositoryName: key.Name, AccessRevision: in.target.AccessRevision, EnvironmentCreatedAt: created, CreatedAt: now})
			if e != nil {
				return e
			}
			action := "save"
			if in.deleted {
				action = "delete"
			}
			op, e = q.InsertRepositoryEnvironmentOperation(ctx, database.InsertRepositoryEnvironmentOperationParams{UserID: actor.UserID, OperationID: uuid.MustParse(in.operation), ForgeURL: s.config.GiteaURL, EnvironmentID: v.EnvironmentID, RepositoryID: repo, OwnerID: owner, Action: action, ExpectedVersion: in.version, Version: v.Version, InputFingerprint: in.fingerprint, CreatedAt: now})
			if e != nil {
				return e
			}
			if !in.deleted {
				if e = s.environmentReferences(ctx, token, key, in.policy); e != nil {
					return e
				}
			}
			if e = s.environmentAuthority(ctx, token, key, caller, in.target, true, true); e != nil {
				return e
			}
			if e = environmentPasswordCurrent(ctx, q, hash, s.config.GiteaURL, initial); e != nil {
				return e
			}
			receipt, env, e = wireEnvironmentOperation(op, v)
			return e
		})
		if txErr != nil {
			return txErr
		}
		return s.environmentAuthority(ctx, token, key, caller, in.target, false, false)
	})
	return env, receipt, e
}
func (s *Server) SaveRepositoryEnvironment(ctx context.Context, req *connect.Request[golfv1.SaveRepositoryEnvironmentRequest]) (*connect.Response[golfv1.SaveRepositoryEnvironmentResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if _, _, _, e = environmentTarget(m.Target); e != nil {
		return nil, environmentRPCError(e)
	}
	version, e := executionNumber(m.ExpectedVersion, true)
	if e != nil || version == math.MaxInt64 || !creationKey.MatchString(m.EnvironmentId) || !creationKey.MatchString(m.OperationId) {
		return nil, environmentRPCError(invalid("Provide canonical environment/operation IDs and current version."))
	}
	if e = validateEnvironmentName(m.Name); e != nil {
		return nil, environmentRPCError(e)
	}
	if e = validateEnvironmentPolicy(m.Policy); e != nil {
		return nil, environmentRPCError(e)
	}
	fp, e := environmentFingerprint(m)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	env, op, e := s.changeRepositoryEnvironment(ctx, token, session, environmentChange{target: m.Target, id: m.EnvironmentId, operation: m.OperationId, name: m.Name, version: version, policy: proto.Clone(m.Policy).(*golfv1.RepositoryEnvironmentPolicy), fingerprint: fp, password: m.CurrentPassword})
	if e != nil {
		return nil, environmentRPCError(e)
	}
	r := connect.NewResponse(&golfv1.SaveRepositoryEnvironmentResponse{Environment: env, Operation: op})
	r.Header().Set("Cache-Control", "no-store")
	return r, nil
}
func (s *Server) DeleteRepositoryEnvironment(ctx context.Context, req *connect.Request[golfv1.DeleteRepositoryEnvironmentRequest]) (*connect.Response[golfv1.DeleteRepositoryEnvironmentResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if _, _, _, e = environmentTarget(m.Target); e != nil {
		return nil, environmentRPCError(e)
	}
	version, e := executionNumber(m.ExpectedVersion, false)
	if e != nil || version == math.MaxInt64 || !creationKey.MatchString(m.EnvironmentId) || !creationKey.MatchString(m.OperationId) {
		return nil, environmentRPCError(invalid("Provide canonical environment/operation IDs and a positive current version."))
	}
	fp, e := environmentFingerprint(m)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	env, op, e := s.changeRepositoryEnvironment(ctx, token, session, environmentChange{target: m.Target, id: m.EnvironmentId, operation: m.OperationId, version: version, deleted: true, fingerprint: fp, password: m.CurrentPassword})
	if e != nil {
		return nil, environmentRPCError(e)
	}
	r := connect.NewResponse(&golfv1.DeleteRepositoryEnvironmentResponse{Environment: env, Operation: op})
	r.Header().Set("Cache-Control", "no-store")
	return r, nil
}

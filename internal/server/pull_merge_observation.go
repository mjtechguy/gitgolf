package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const mergeObservationUnavailable = "protected_integration_unqualified"

type forgeMergeBranch struct {
	Name   string `json:"name"`
	Commit struct {
		ID string `json:"id"`
	} `json:"commit"`
	Protected    *bool `json:"protected"`
	UserCanMerge *bool `json:"user_can_merge"`
}

// The branch API's effective-protection observation is checked against the
// exact ref namespace, not a guessed short name or a client-side rule matcher.
func (s *Server) readMergeBranch(ctx context.Context, token forgeCredential, base, name string) (*forgeMergeBranch, error) {
	if !validRef(name) {
		return nil, errInvalidForgeResponse
	}
	var row forgeMergeBranch
	if _, e := s.forge(ctx, http.MethodGet, base+"/branches/"+escapedSourcePath(name), token, nil, &row); e != nil {
		return nil, e
	}
	if row.Name != name || !objectID.MatchString(row.Commit.ID) || row.Protected == nil || row.UserCanMerge == nil {
		return nil, errInvalidForgeResponse
	}
	exact, e := s.exactSourceBranch(ctx, base, token, name)
	if e != nil {
		return nil, e
	}
	if exact != row.Commit.ID {
		return nil, errPullSnapshotChanged
	}
	return &row, nil
}
func mergeReadUnavailable(e error) bool {
	var f forgeError
	return sourceNotFound(e) || errors.As(e, &f) && f.status == http.StatusForbidden
}
func mergeBranchSelection(row *forgeMergeBranch) *golfv1.RepositorySourceSelection {
	return &golfv1.RepositorySourceSelection{Kind: golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH, Name: row.Name, CommitId: row.Commit.ID}
}
func sameMergeObservation(a, b *golfv1.PullRequestMergeObservation) bool {
	return proto.Equal(a, b)
}

func (s *Server) mergeObservationSnapshot(ctx context.Context, session string, token forgeCredential, base string, repo Repository, pull forgePull, selected *golfv1.PullRequestSelection) (*golfv1.PullRequestMergeObservation, error) {
	var raw forgeRulesRepository
	if _, e := s.forge(ctx, http.MethodGet, base, token, nil, &raw); e != nil {
		return nil, e
	}
	if raw.ID != repo.ID || raw.Owner == nil || raw.Owner.ID <= 0 || raw.Owner.Login != keyFrom(selected.Repository).Owner || raw.FullName != repo.FullName {
		return nil, errPullSnapshotChanged
	}
	config, e := wireMergeConfiguration(raw)
	if e != nil {
		return nil, e
	}
	ownerID := strconv.FormatInt(raw.Owner.ID, 10)
	native, actor, e := s.gitCurrentTarget(ctx, token, keyFrom(selected.Repository), selected.RepositoryId, ownerID, false)
	if e != nil {
		return nil, e
	}
	result := &golfv1.PullRequestMergeObservation{Selection: proto.Clone(selected).(*golfv1.PullRequestSelection), PullRevision: pullRevision(pull), TargetOwnerId: ownerID, MergeConfiguration: config, TargetProtection: golfv1.PullMergeTargetProtection_PULL_MERGE_TARGET_PROTECTION_UNKNOWN, SourceState: golfv1.PullMergeSourceState_PULL_MERGE_SOURCE_STATE_UNAVAILABLE, UnavailableReason: mergeObservationUnavailable}
	// Positive ordinary write authority is independently checked; the flag is
	// an observation, not authority to execute a merge or bypass protections.
	_, writer, e := s.gitCurrentTarget(ctx, token, keyFrom(selected.Repository), selected.RepositoryId, ownerID, true)
	if e == nil {
		if writer.ID != actor.ID {
			return nil, errUnauthenticated
		}
		yes := true
		result.CurrentTargetWriter = &yes
	} else if mergeReadUnavailable(e) {
		no := false
		result.CurrentTargetWriter = &no
	} else {
		return nil, e
	}
	if native.ID != repo.ID {
		return nil, errPullSnapshotChanged
	}
	targetBranch, e := s.readMergeBranch(ctx, token, base, pull.Base.Ref)
	if e == nil {
		if len(targetBranch.Commit.ID) != len(selected.BaseCommitId) {
			return nil, errInvalidForgeResponse
		}
		result.Base = mergeBranchSelection(targetBranch)
		result.NativeCallerCanMerge = targetBranch.UserCanMerge
		result.TargetProtection = golfv1.PullMergeTargetProtection_PULL_MERGE_TARGET_PROTECTION_UNPROTECTED
		if *targetBranch.Protected {
			result.TargetProtection = golfv1.PullMergeTargetProtection_PULL_MERGE_TARGET_PROTECTION_PROTECTED
		}
	} else if !mergeReadUnavailable(e) {
		return nil, e
	}
	if result.TargetProtection == golfv1.PullMergeTargetProtection_PULL_MERGE_TARGET_PROTECTION_PROTECTED {
		result.ProtectedReviews, e = s.protectedReviewObservation(ctx, token, base, pull, selected.HeadCommitId)
		if e != nil {
			return nil, e
		}
	}
	if strings.HasPrefix(pull.Head.Ref, "refs/pull/") || pull.Head.RepositoryID <= 0 {
		result.SourceState = golfv1.PullMergeSourceState_PULL_MERGE_SOURCE_STATE_RETAINED_ONLY
		return result, nil
	}
	if pull.Head.Repository == nil {
		return result, nil
	}
	sourceRepo := pull.Head.Repository
	if !validRepository(*sourceRepo) || sourceRepo.ID != pull.Head.RepositoryID {
		return nil, errInvalidForgeResponse
	}
	sourceName := strings.Split(sourceRepo.FullName, "/")
	if len(sourceName) != 2 {
		return nil, errInvalidForgeResponse
	}
	sourceKey := repositoryKey{Owner: sourceName[0], Name: sourceName[1]}
	e = s.withRepositoryRead(ctx, session, token, sourceKey, func(sourceBase string, current Repository) error {
		if current.ID != pull.Head.RepositoryID || current.FullName != sourceRepo.FullName {
			return errPullSnapshotChanged
		}
		var sourceNative gitNativeRepository
		if _, err := s.forge(ctx, http.MethodGet, sourceBase, token, nil, &sourceNative); err != nil {
			return err
		}
		if sourceNative.Owner == nil || sourceNative.Owner.ID <= 0 {
			return errInvalidForgeResponse
		}
		sourceOwnerID := strconv.FormatInt(sourceNative.Owner.ID, 10)
		_, sourceActor, err := s.gitCurrentTarget(ctx, token, sourceKey, strconv.FormatInt(current.ID, 10), sourceOwnerID, false)
		if err != nil {
			return err
		}
		if sourceActor.ID != actor.ID {
			return errUnauthenticated
		}
		sha, err := s.exactSourceBranch(ctx, sourceBase, token, pull.Head.Ref)
		if err != nil {
			return err
		}
		if len(sha) != len(selected.HeadCommitId) {
			return errInvalidForgeResponse
		}
		result.SourceRepository = &golfv1.RepositoryKey{Owner: sourceKey.Owner, Name: sourceKey.Name}
		result.SourceRepositoryId = strconv.FormatInt(current.ID, 10)
		result.SourceOwnerId = &sourceOwnerID
		result.Source = &golfv1.RepositorySourceSelection{Kind: golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH, Name: pull.Head.Ref, CommitId: sha}
		_, latestActor, err := s.gitCurrentTarget(ctx, token, sourceKey, strconv.FormatInt(current.ID, 10), sourceOwnerID, false)
		if err != nil {
			return err
		}
		if latestActor.ID != actor.ID {
			return errUnauthenticated
		}
		result.SourceState = golfv1.PullMergeSourceState_PULL_MERGE_SOURCE_STATE_CURRENT
		if sha != selected.HeadCommitId {
			result.SourceState = golfv1.PullMergeSourceState_PULL_MERGE_SOURCE_STATE_CHANGED
		}
		return nil
	})
	if e != nil {
		if !mergeReadUnavailable(e) {
			return nil, e
		}
		result.Source = nil
		result.SourceRepository = nil
		result.SourceRepositoryId = ""
		result.SourceOwnerId = nil
		result.SourceState = golfv1.PullMergeSourceState_PULL_MERGE_SOURCE_STATE_UNAVAILABLE
	}
	return result, nil
}

func (s *Server) GetPullRequestMergeObservation(ctx context.Context, req *connect.Request[golfv1.GetPullRequestMergeObservationRequest]) (*connect.Response[golfv1.GetPullRequestMergeObservationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if m.Selection == nil || !issueRevisionPattern.MatchString(m.ExpectedPullRevision) {
		return nil, rpcError(invalid("Select the exact pull request revision."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.PullRequestMergeObservation
	e = s.withPullSelection(ctx, session, token, m.Selection, func(base string, repo Repository, pull forgePull) error {
		if pullRevision(pull) != m.ExpectedPullRevision {
			return errPullSnapshotChanged
		}
		first, err := s.mergeObservationSnapshot(ctx, session, token, base, repo, pull, m.Selection)
		if err != nil {
			return err
		}
		second, err := s.mergeObservationSnapshot(ctx, session, token, base, repo, pull, m.Selection)
		if err != nil {
			return err
		}
		if !sameMergeObservation(first, second) {
			return errPullSnapshotChanged
		}
		// Re-read the full PR revision (including draft/retarget/content changes),
		// in addition to withPullSelection's retained comparison/authority fences.
		latest, err := s.readPull(ctx, token, base, repo, m.Selection.Number)
		if err != nil {
			return err
		}
		if pullRevision(latest) != m.ExpectedPullRevision {
			return errPullSnapshotChanged
		}
		// Recheck ordinary target authority after source/PR waits; aggregate
		// native administrator access must not substitute for the caller's grant.
		_, finalActor, err := s.gitCurrentTarget(ctx, token, keyFrom(m.Selection.Repository), m.Selection.RepositoryId, first.TargetOwnerId, false)
		if err != nil {
			return err
		}
		_, writer, writerErr := s.gitCurrentTarget(ctx, token, keyFrom(m.Selection.Repository), m.Selection.RepositoryId, first.TargetOwnerId, true)
		currentWriter := writerErr == nil
		if writerErr != nil && !mergeReadUnavailable(writerErr) {
			return writerErr
		}
		if first.CurrentTargetWriter == nil || currentWriter != *first.CurrentTargetWriter || currentWriter && writer.ID != finalActor.ID {
			return errPullSnapshotChanged
		}
		first.Fingerprint = accessRevision(first)
		first.ObservedAt = time.Now().UTC().Format(time.RFC3339Nano)
		encoded, err := protojson.Marshal(first)
		if err != nil || len(encoded) > 64<<10 {
			return errForgeResponseTooLarge
		}
		result = first
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetPullRequestMergeObservationResponse{Observation: result}), nil
}

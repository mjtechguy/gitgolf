package server

import (
	"context"
	"database/sql"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"sort"
	"strconv"
)

const standardMergeForkContract = "golf.pull.standard-native-merge.v2"

func validateStandardMergeSource(m *golfv1.SubmitStandardPullMergeRequest) error {
	if m.SourceRepository == nil && m.SourceRepositoryId == "" && m.SourceOwnerId == "" {
		return nil
	}
	if m.SourceRepository == nil {
		return invalid("Bind the exact source repository and owner identity.")
	}
	if _, e := repositoryPath(keyFrom(m.SourceRepository)); e != nil {
		return e
	}
	for _, id := range []string{m.SourceRepositoryId, m.SourceOwnerId} {
		if _, e := discussionID(id); e != nil {
			return e
		}
	}
	return nil
}
func standardMergeSourceID(r standardMergeRecord) int64 {
	if r.SourceRepositoryID > 0 {
		return r.SourceRepositoryID
	}
	return r.RepositoryID
}

// Shared sorted lifecycle gates exclude managed archive/deletion while reading
// or dispatching. They do not lock external/native Git writers or create CAS.
func (s *Server) lockStandardMergeLifecycles(ctx context.Context, tx *sql.Tx, target, source int64, check bool) (context.Context, error) {
	ids := []int64{target}
	if source > 0 && source != target {
		ids = append(ids, source)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		if _, e := tx.ExecContext(ctx, `SELECT golf_repository_lifecycle_lock($1,$2,false)`, s.config.ForgeURL, id); e != nil {
			return nil, errStorageUnavailable
		}
		if check {
			var blocked bool
			if e := tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked($1,$2)`, s.config.ForgeURL, id).Scan(&blocked); e != nil {
				return nil, errStorageUnavailable
			}
			if blocked {
				return nil, errLifecycleBlocked
			}
		}
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.ForgeURL, target, tx}), nil
}

// Historical original inspection verifies current source identity/read access;
// only preparation and success readback additionally require the original H.
func (s *Server) standardMergeSourceRead(ctx context.Context, session string, token forgeCredential, r standardMergeRecord, ref, head string) error {
	if r.SourceRepositoryID <= 0 {
		return nil
	}
	key := repositoryKey{r.SourceOwner, r.SourceName}
	repoID := strconv.FormatInt(r.SourceRepositoryID, 10)
	ownerID := strconv.FormatInt(r.SourceOwnerID, 10)
	return s.withForgeCaller(ctx, session, token, func(actor User) error {
		return s.withRepositoryRead(ctx, session, token, key, func(base string, current Repository) error {
			if current.ID != r.SourceRepositoryID {
				return errPullSnapshotChanged
			}
			_, before, e := s.gitCurrentTarget(ctx, token, key, repoID, ownerID, false)
			if e != nil {
				return e
			}
			if before.ID != actor.ID {
				return errUnauthenticated
			}
			if ref != "" {
				sha, e := s.exactSourceBranch(ctx, base, token, ref)
				if e != nil {
					return e
				}
				if sha != head {
					return errPullSnapshotChanged
				}
			}
			_, after, e := s.gitCurrentTarget(ctx, token, key, repoID, ownerID, false)
			if e != nil {
				return e
			}
			if after.ID != actor.ID {
				return errUnauthenticated
			}
			if ref != "" {
				sha, e := s.exactSourceBranch(ctx, base, token, ref)
				if e != nil {
					return e
				}
				if sha != head {
					return errPullSnapshotChanged
				}
			}
			return nil
		})
	})
}
func (s *Server) standardMergeSourcePreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitStandardPullMergeRequest, p forgePull, targetBase string, target Repository) error {
	if m.SourceRepository == nil {
		if p.Head.RepositoryID != target.ID {
			return errStandardMergeUnavailable
		}
		sha, e := s.exactSourceBranch(ctx, targetBase, token, m.SourceRef)
		if e != nil {
			return e
		}
		if sha != m.Selection.HeadCommitId {
			return errPullSnapshotChanged
		}
		return nil
	}
	sourceID, _ := discussionID(m.SourceRepositoryId)
	ownerID, _ := discussionID(m.SourceOwnerId)
	key := keyFrom(m.SourceRepository)
	if p.Head.RepositoryID != sourceID || p.Head.Repository == nil || p.Head.Repository.ID != sourceID || p.Head.Repository.FullName != key.Owner+"/"+key.Name {
		return errPullSnapshotChanged
	}
	r := standardMergeRecord{SourceRepositoryID: sourceID, SourceOwnerID: ownerID, SourceOwner: key.Owner, SourceName: key.Name}
	return s.standardMergeSourceRead(ctx, session, token, r, m.SourceRef, m.Selection.HeadCommitId)
}

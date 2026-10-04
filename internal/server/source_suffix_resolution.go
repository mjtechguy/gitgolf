package server

import (
	"context"
	"strings"
	"sync"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

type sourceSuffixBoundary struct{ name, path string }

// The suffix is already decoded literal input. No percent decoding, path
// probing, commit guessing or longest-prefix/name-namespace precedence occurs.
func sourceSuffixBoundaries(suffix string) ([]sourceSuffixBoundary, error) {
	if suffix == "" || !validSourcePath(suffix) {
		return nil, invalid("Select a nonempty literal readable source suffix.")
	}
	parts := strings.Split(suffix, "/")
	var boundaries []sourceSuffixBoundary
	for end := 1; end <= len(parts); end++ {
		name, path := strings.Join(parts[:end], "/"), strings.Join(parts[end:], "/")
		if !validRef(name) || !validSourcePath(path) {
			continue
		}
		boundaries = append(boundaries, sourceSuffixBoundary{name, path})
		if len(boundaries) > 32 {
			return nil, errForgeResponseTooLarge
		}
	}
	if len(boundaries) == 0 {
		return nil, invalid("No valid branch or tag boundary exists in this suffix. Select an explicit ref and path.")
	}
	return boundaries, nil
}

func (s *Server) sourceSuffixCandidate(ctx context.Context, base string, repo Repository, credential forgeCredential, boundary sourceSuffixBoundary, kind golfv1.RepositorySourceRefKind) (*golfv1.RepositorySourceCandidate, error) {
	// Only an initial exact namespace miss may be an absence observation. Once
	// present, missing commit/ref verification is uncertainty, not a dropped match.
	var initialCommit, initialTag string
	var err error
	if kind == golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH {
		initialCommit, err = s.exactSourceBranch(ctx, base, credential, boundary.name)
	} else {
		var tag forgeTag
		tag, err = s.exactSourceTag(ctx, base, credential, boundary.name)
		initialCommit, initialTag = tag.Commit.SHA, tag.ID
	}
	if sourceNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	selection, err := s.sourceSelection(ctx, base, repo, credential, &golfv1.RepositorySourceSelector{Kind: kind, Name: boundary.name})
	if sourceNotFound(err) {
		return nil, errPullSnapshotChanged
	}
	if err != nil {
		return nil, err
	}
	if selection.CommitId != initialCommit || selection.GetTagObjectId() != initialTag {
		return nil, errPullSnapshotChanged
	}
	return &golfv1.RepositorySourceCandidate{Selection: selection, Path: boundary.path}, nil
}

// At most 64 logical namespace jobs and four concurrent native checks. Positive
// jobs also perform the existing exact commit/ref reobservations. All jobs must
// succeed before unique/ambiguous output; one unresolved job cancels the batch.
func (s *Server) resolveSourceSuffix(ctx context.Context, base string, repo Repository, credential forgeCredential, boundaries []sourceSuffixBoundary) ([]*golfv1.RepositorySourceCandidate, error) {
	if len(boundaries) == 0 || len(boundaries) > 32 {
		return nil, errForgeResponseTooLarge
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan int, len(boundaries)*2)
	results := make([]*golfv1.RepositorySourceCandidate, cap(jobs))
	for index := range results {
		jobs <- index
	}
	close(jobs)
	var workers sync.WaitGroup
	var fail sync.Once
	var failure error
	for range min(4, len(results)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				var candidate *golfv1.RepositorySourceCandidate
				err := ctx.Err()
				if err == nil {
					kind := golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH
					if index%2 == 1 {
						kind = golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_TAG
					}
					candidate, err = s.sourceSuffixCandidate(ctx, base, repo, credential, boundaries[index/2], kind)
				}
				if err != nil {
					fail.Do(func() { failure = err; cancel() })
				} else {
					results[index] = candidate
				}
			}
		}()
	}
	workers.Wait()
	if failure != nil {
		return nil, failure
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var candidates []*golfv1.RepositorySourceCandidate
	for _, result := range results {
		if result != nil {
			candidates = append(candidates, result)
		}
	}
	return candidates, nil
}

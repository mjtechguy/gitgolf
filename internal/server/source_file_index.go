package server

import (
	"context"
	"path"
	"sort"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func (s *Server) GetRepositoryFileIndex(ctx context.Context, req *connect.Request[golfv1.GetRepositoryFileIndexRequest]) (*connect.Response[golfv1.GetRepositoryFileIndexResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	id, err := discussionID(req.Msg.RepositoryId)
	if err != nil || !objectID.MatchString(req.Msg.CommitId) {
		return nil, rpcError(invalid("Select a repository ID and full lowercase commit ID."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var paths []string
	err = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), func(base string, repo Repository) error {
		if repo.ID != id {
			return errIssueTargetChanged
		}
		var readErr error
		paths, readErr = s.sourceFileIndex(ctx, base, token, req.Msg.CommitId)
		return readErr
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetRepositoryFileIndexResponse{RepositoryId: strconv.FormatInt(id, 10), CommitId: req.Msg.CommitId, Paths: paths}), nil
}

func (s *Server) sourceFileIndex(ctx context.Context, base string, token forgeCredential, commit string) ([]string, error) {
	root, err := s.sourceCommitTree(ctx, base, token, commit)
	if err != nil {
		return nil, err
	}
	type directory struct {
		hash, prefix string
		depth        int
	}
	pending := []directory{{hash: root}}
	cache := map[string][]sourceTreeEntry{}
	paths := []string{}
	bytes, directories := 0, 0
	for len(pending) > 0 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		current := pending[0]
		pending = pending[1:]
		directories++
		// shortcut: bounded on-demand index; use a durable background index for larger trees.
		if directories > 512 || current.depth > 64 {
			return nil, errForgeResponseTooLarge
		}
		entries, ok := cache[current.hash]
		if !ok {
			entries, err = s.sourceTreeEntries(ctx, base, token, current.hash, current.prefix == "")
			if err != nil {
				return nil, err
			}
			cache[current.hash] = entries
		}
		for _, entry := range entries {
			name := path.Join(current.prefix, entry.Path)
			if !validSourcePath(name) {
				return nil, errInvalidForgeResponse
			}
			if entry.Type == "tree" {
				if directories+len(pending) >= 512 {
					return nil, errForgeResponseTooLarge
				}
				pending = append(pending, directory{hash: entry.SHA, prefix: name, depth: current.depth + 1})
			} else if entry.Type != "commit" {
				bytes += len(name)
				if len(paths) >= 10000 || bytes > 1024*1024 {
					return nil, errForgeResponseTooLarge
				}
				paths = append(paths, name)
			}
		}
	}
	sort.Strings(paths)
	return paths, nil
}

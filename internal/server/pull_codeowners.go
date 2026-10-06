package server

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type codeOwnerRule struct {
	pattern *regexp.Regexp
	negate  bool
	owners  []string
}

// Native CODEOWNERS uses Go regular expressions, not GitHub globs. The
// observations below are routing suggestions, never protected approval policy.
func codeOwnerFields(line string) ([]string, error) {
	var fields []string
	var word strings.Builder
	flush := func() {
		if word.Len() > 0 {
			fields = append(fields, word.String())
			word.Reset()
		}
	}
	for i := 0; i < len(line); i++ {
		c := line[i]
		if c == '#' {
			break
		}
		if c == '\\' && i+1 < len(line) && (line[i+1] == '#' || line[i+1] == ' ' || line[i+1] == '\\') {
			i++
			word.WriteByte(line[i])
			continue
		}
		if c == ' ' || c == '\t' {
			flush()
			continue
		}
		word.WriteByte(c)
	}
	flush()
	return fields, nil
}
func parseCodeOwners(text string) ([]codeOwnerRule, uint32) {
	if len(text) > 16<<10 || !utf8.ValidString(text) || !discussionText(text, 16<<10) {
		return nil, 1
	}
	var rules []codeOwnerRule
	var unsupported uint32
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		fields, _ := codeOwnerFields(line)
		if len(fields) == 0 {
			continue
		}
		if len(fields) < 2 || len(fields) > 21 || len(rules) >= 200 {
			unsupported++
			continue
		}
		pattern := fields[0]
		negative := strings.HasPrefix(pattern, "!")
		if negative {
			pattern = strings.TrimPrefix(pattern, "!")
		}
		compiled, e := regexp.Compile(pattern)
		valid := e == nil && pattern != ""
		for _, owner := range fields[1:] {
			parts := strings.Split(strings.TrimPrefix(owner, "@"), "/")
			if !strings.HasPrefix(owner, "@") || len(parts) > 2 {
				valid = false
			}
			for _, part := range parts {
				if !validOrganizationName(part) {
					valid = false
				}
			}
		}
		if !valid {
			unsupported++
			continue
		}
		rules = append(rules, codeOwnerRule{compiled, negative, fields[1:]})
	}
	return rules, unsupported
}
func codeOwnerMatches(rules []codeOwnerRule, paths []string) []*golfv1.PullCodeOwnerMatch {
	var out []*golfv1.PullCodeOwnerMatch
	for _, path := range paths {
		owners := map[string]bool{}
		for _, rule := range rules {
			if rule.pattern.MatchString(path) != rule.negate {
				for _, owner := range rule.owners {
					owners[owner] = true
				}
			}
		}
		if len(owners) == 0 {
			continue
		}
		row := &golfv1.PullCodeOwnerMatch{Path: path}
		for owner := range owners {
			row.Owners = append(row.Owners, owner)
		}
		sort.Strings(row.Owners)
		out = append(out, row)
	}
	return out
}
func (s *Server) GetPullCodeOwners(ctx context.Context, req *connect.Request[golfv1.GetPullCodeOwnersRequest]) (*connect.Response[golfv1.GetPullCodeOwnersResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if m.Selection == nil || !issueRevisionPattern.MatchString(m.ExpectedPullRevision) {
		return nil, rpcError(invalid("Select the exact pull request comparison."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out := &golfv1.GetPullCodeOwnersResponse{Selection: proto.Clone(m.Selection).(*golfv1.PullRequestSelection), PullRevision: m.ExpectedPullRevision, RoutingComplete: true}
	e = s.withPullSelection(ctx, session, token, m.Selection, func(base string, repo Repository, pull forgePull) error {
		if pullRevision(pull) != m.ExpectedPullRevision {
			return errPullSnapshotChanged
		}
		for _, name := range []string{"CODEOWNERS", "docs/CODEOWNERS", ".gitea/CODEOWNERS"} {
			entry, _, e := s.sourceObjectAtPath(ctx, base, token, m.Selection.BaseCommitId, name)
			if sourceNotFound(e) {
				continue
			}
			if e != nil {
				return e
			}
			if entry.Type != "file" || entry.Size > 16<<10 {
				return errForgeResponseTooLarge
			}
			data, e := s.sourceBlob(ctx, base, token, entry)
			if e != nil {
				return e
			}
			out.Path = name
			out.BlobId = entry.SHA
			out.Source = string(data)
			break
		}
		if out.Path == "" {
			return nil
		}
		rules, unsupported := parseCodeOwners(out.Source)
		out.UnsupportedRules = unsupported
		out.RoutingComplete = unsupported == 0
		if unsupported > 0 {
			return nil
		} // Never display a partial routing result as complete.
		diff, e := s.getPullRequestDiff(ctx, session, token, &golfv1.GetPullRequestDiffRequest{Repository: m.Selection.Repository, RepositoryId: m.Selection.RepositoryId, PullRequestId: m.Selection.PullRequestId, Number: m.Selection.Number, BaseCommitId: m.Selection.BaseCommitId, HeadCommitId: m.Selection.HeadCommitId})
		if e != nil {
			return e
		}
		comparison, e := parseReviewComparison(diff.RawDiff)
		if e != nil {
			return e
		}
		if len(comparison.files) > 200 {
			return errForgeResponseTooLarge
		}
		paths := map[string]bool{}
		for _, file := range comparison.files {
			if !file.oldMissing {
				paths[file.oldPath] = true
			}
			if !file.newMissing {
				paths[file.newPath] = true
			}
		}
		ordered := make([]string, 0, len(paths))
		for path := range paths {
			ordered = append(ordered, path)
		}
		sort.Strings(ordered)
		out.Matches = codeOwnerMatches(rules, ordered)
		latest, e := s.readPull(ctx, token, base, repo, m.Selection.Number)
		if e != nil {
			return e
		}
		if pullRevision(latest) != m.ExpectedPullRevision {
			return errPullSnapshotChanged
		}
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(out), nil
}

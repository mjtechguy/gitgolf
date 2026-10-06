package server

import (
	"context"
	"path"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"go.yaml.in/yaml/v3"
)

func markdownIssueTemplate(entry sourceEntry, text string) (*golfv1.IssueTemplate, error) {
	if len(text) > 6000 || !discussionText(text, 6000) {
		return nil, errForgeResponseTooLarge
	}
	template := &golfv1.IssueTemplate{Path: entry.Path, Name: strings.TrimSuffix(entry.Name, path.Ext(entry.Name)), Body: text, BlobId: entry.SHA}
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	if strings.HasPrefix(normalized, "---\n") {
		end := strings.Index(normalized[4:], "\n---\n")
		if end < 0 || end > 4096 {
			return nil, errInvalidForgeResponse
		}
		var front struct {
			Name  string `yaml:"name"`
			About string `yaml:"about"`
			Title string `yaml:"title"`
		}
		if yaml.Unmarshal([]byte(normalized[4:4+end]), &front) != nil {
			return nil, errInvalidForgeResponse
		}
		if front.Name != "" {
			template.Name = front.Name
		}
		template.About = front.About
		template.Title = front.Title
		template.Body = normalized[4+end+5:]
	}
	if !discussionMetadataName(template.Name) || !discussionText(template.About, 1024) || !discussionText(template.Title, 255) || strings.TrimSpace(template.Title) != template.Title {
		return nil, errInvalidForgeResponse
	}
	return template, nil
}
func (s *Server) ListIssueTemplates(ctx context.Context, req *connect.Request[golfv1.ListIssueTemplatesRequest]) (*connect.Response[golfv1.ListIssueTemplatesResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	id, e := discussionID(req.Msg.RepositoryId)
	if e != nil {
		return nil, rpcError(e)
	}
	out := &golfv1.ListIssueTemplatesResponse{}
	e = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), func(base string, repo Repository) error {
		if repo.ID != id {
			return errIssueTargetChanged
		}
		if repo.Empty {
			return nil
		}
		selected, e := s.sourceSelection(ctx, base, repo, token, &golfv1.RepositorySourceSelector{Kind: golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_DEFAULT_BRANCH})
		if e != nil {
			return e
		}
		out.CommitId = selected.CommitId
		entries := []sourceEntry{}
		for _, name := range []string{".gitea/ISSUE_TEMPLATE", ".github/ISSUE_TEMPLATE"} {
			result, e := s.readContentsAtCommit(ctx, base, token, selected.CommitId, name)
			if sourceNotFound(e) {
				continue
			}
			if e != nil {
				return e
			}
			if result.Kind != "dir" {
				continue
			}
			for _, entry := range result.Entries {
				if entry.Type == "file" {
					entries = append(entries, entry)
				}
			}
		}
		for _, name := range []string{".gitea/ISSUE_TEMPLATE.md", ".github/ISSUE_TEMPLATE.md", "ISSUE_TEMPLATE.md"} {
			result, e := s.readContentsAtCommit(ctx, base, token, selected.CommitId, name)
			if sourceNotFound(e) {
				continue
			}
			if e != nil {
				return e
			}
			if result.File != nil && result.Kind == "file" {
				entries = append(entries, result.File.sourceEntry)
			}
		}
		if len(entries) > 50 {
			return errForgeResponseTooLarge
		}
		for _, entry := range entries {
			ext := strings.ToLower(path.Ext(entry.Name))
			if ext != ".md" && ext != ".yml" && ext != ".yaml" || entry.Name == "config.yml" || entry.Name == "config.yaml" {
				continue
			}
			if entry.Size > 6000 {
				out.UnsupportedTemplates++
				continue
			}
			result, e := s.readContentsAtCommit(ctx, base, token, selected.CommitId, entry.Path)
			if e != nil {
				return e
			}
			if result.File == nil || result.File.Content == nil || result.File.SHA != entry.SHA {
				out.UnsupportedTemplates++
				continue
			}
			template, e := issueTemplate(entry, *result.File.Content)
			if e != nil {
				out.UnsupportedTemplates++
				continue
			}
			out.Templates = append(out.Templates, template)
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}

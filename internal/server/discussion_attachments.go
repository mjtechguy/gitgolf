package server

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func discussionAttachmentRevision(a forgeReleaseDownloadAsset) string {
	if !validReleaseDownloadAsset(a, a.ID) {
		return ""
	}
	return resourceHash([]any{a.ID, a.UUID, a.Name, *a.Size, a.CreatedAt})
}
func discussionAttachmentWire(a forgeReleaseDownloadAsset) *golfv1.DiscussionAttachment {
	return &golfv1.DiscussionAttachment{Id: strconv.FormatInt(a.ID, 10), Name: a.Name, SizeBytes: uint64(*a.Size), CreatedAt: a.CreatedAt, Revision: discussionAttachmentRevision(a)}
}
func discussionAttachmentRoute(base string, t *golfv1.DiscussionTarget) string {
	if t.CommentId != "" {
		return base + "/issues/comments/" + t.CommentId + "/assets"
	}
	return base + "/issues/" + strconv.FormatUint(uint64(t.Number), 10) + "/assets"
}
func (s *Server) discussionAttachments(ctx context.Context, session string, token forgeCredential, t *golfv1.DiscussionTarget) (*golfv1.ListDiscussionAttachmentsResponse, error) {
	out := &golfv1.ListDiscussionAttachmentsResponse{}
	e := s.withDiscussionTarget(ctx, session, token, t, func(base string, _ Repository, _ discussionIssue) error {
		var rows []forgeReleaseDownloadAsset
		if _, e := s.forgeJSON(ctx, http.MethodGet, discussionAttachmentRoute(base, t), token, nil, &rows, http.StatusOK); e != nil {
			return e
		}
		if len(rows) > 100 {
			return errForgeResponseTooLarge
		}
		seen := map[int64]bool{}
		for _, a := range rows {
			if discussionAttachmentRevision(a) == "" || seen[a.ID] {
				return errInvalidForgeResponse
			}
			seen[a.ID] = true
			out.Attachments = append(out.Attachments, discussionAttachmentWire(a))
		}
		out.Target = proto.Clone(t).(*golfv1.DiscussionTarget)
		out.SnapshotRevision = resourceHash(out.Attachments)
		return nil
	})
	return out, e
}
func (s *Server) ListDiscussionAttachments(ctx context.Context, req *connect.Request[golfv1.ListDiscussionAttachmentsRequest]) (*connect.Response[golfv1.ListDiscussionAttachmentsResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	out, e := s.discussionAttachments(ctx, s.cookieValue(req.Header()), token, req.Msg.Target)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}
func (s *Server) discussionAttachmentBytes(ctx context.Context, token forgeCredential, a forgeReleaseDownloadAsset) ([]byte, error) {
	if discussionAttachmentRevision(a) == "" {
		return nil, errInvalidForgeResponse
	}
	if *a.Size > repositoryReleaseAssetMaxBytes {
		return nil, errForgeResponseTooLarge
	}
	if token.Token == "" || token.Kind != "pat" && token.Kind != "oauth" {
		return nil, errUnauthenticated
	}
	// The verified API association supplies only UUID. No provider URL is followed.
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, s.config.ForgeURL+"/attachments/"+a.UUID, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Authorization", "Bearer "+token.Token)
	req.Header.Set("Accept", "application/octet-stream")
	resp, e := s.client.Do(req)
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, forgeError{status: resp.StatusCode}
	}
	if resp.ContentLength > repositoryReleaseAssetMaxBytes {
		return nil, errForgeResponseTooLarge
	}
	data, e := io.ReadAll(io.LimitReader(resp.Body, repositoryReleaseAssetMaxBytes+1))
	if e != nil {
		return nil, e
	}
	if len(data) > repositoryReleaseAssetMaxBytes {
		return nil, errForgeResponseTooLarge
	}
	if int64(len(data)) != *a.Size {
		return nil, errInvalidForgeResponse
	}
	return data, nil
}
func (s *Server) DownloadDiscussionAttachment(ctx context.Context, req *connect.Request[golfv1.DownloadDiscussionAttachmentRequest]) (*connect.Response[golfv1.DownloadDiscussionAttachmentResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	m := req.Msg
	id, e := discussionID(m.AttachmentId)
	if e != nil {
		return nil, rpcError(e)
	}
	if !issueRevisionPattern.MatchString(m.ExpectedRevision) {
		return nil, rpcError(invalid("Select the original attachment revision."))
	}
	out := &golfv1.DownloadDiscussionAttachmentResponse{}
	e = s.withDiscussionTarget(ctx, s.cookieValue(req.Header()), token, m.Target, func(base string, _ Repository, _ discussionIssue) error {
		route := discussionAttachmentRoute(base, m.Target) + "/" + m.AttachmentId
		var before, after forgeReleaseDownloadAsset
		if _, e := s.forgeJSON(ctx, http.MethodGet, route, token, nil, &before, http.StatusOK); e != nil {
			return e
		}
		if before.ID != id || discussionAttachmentRevision(before) != m.ExpectedRevision {
			return errIssueTargetChanged
		}
		data, e := s.discussionAttachmentBytes(ctx, token, before)
		if e != nil {
			return e
		}
		if _, e = s.forgeJSON(ctx, http.MethodGet, route, token, nil, &after, http.StatusOK); e != nil {
			return e
		}
		if !sameReleaseDownloadAsset(before, after) || discussionAttachmentRevision(after) != m.ExpectedRevision {
			return errIssueTargetChanged
		}
		out.Target = proto.Clone(m.Target).(*golfv1.DiscussionTarget)
		out.Attachment = discussionAttachmentWire(after)
		out.Content = data
		out.ContentSha256 = fileMutationHash(data)
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}

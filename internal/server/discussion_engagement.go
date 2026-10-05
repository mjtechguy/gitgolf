package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

var discussionReactionNames = []string{"+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"}

func engagementKind(k string) bool {
	return k == "ADD_REACTION" || k == "REMOVE_REACTION" || k == "SUBSCRIBE" || k == "UNSUBSCRIBE"
}
func engagementTarget(m *golfv1.SubmitDiscussionResourceOperationRequest) *golfv1.DiscussionTarget {
	t := &golfv1.DiscussionTarget{Repository: m.Repository, RepositoryId: m.RepositoryId, IssueId: m.IssueId, Number: m.Number, PullRequest: m.PullRequest}
	if m.ReactionComment {
		t.CommentId = m.ResourceId
	}
	return t
}
func validateDiscussionTarget(t *golfv1.DiscussionTarget) error {
	if t == nil {
		return invalid("Bind a discussion target.")
	}
	if _, e := repositoryPath(keyFrom(t.Repository)); e != nil {
		return e
	}
	for _, id := range []string{t.RepositoryId, t.IssueId} {
		if _, e := discussionID(id); e != nil {
			return e
		}
	}
	if t.CommentId != "" {
		if _, e := discussionID(t.CommentId); e != nil {
			return e
		}
	}
	return pullNumber(t.Number)
}
func (s *Server) withDiscussionTarget(ctx context.Context, session string, token forgeCredential, t *golfv1.DiscussionTarget, fn func(string, Repository, discussionIssue) error) error {
	if e := validateDiscussionTarget(t); e != nil {
		return e
	}
	ctx = context.WithValue(ctx, pullDiscussionKey{}, t.PullRequest)
	return s.withRepositoryRead(ctx, session, token, keyFrom(t.Repository), func(base string, repo Repository) error {
		if strconv.FormatInt(repo.ID, 10) != t.RepositoryId {
			return errIssueTargetChanged
		}
		before, e := s.readDiscussionIssue(ctx, token, base, repo, t.Number)
		if e != nil {
			return e
		}
		if strconv.FormatInt(before.ID, 10) != t.IssueId {
			return errIssueTargetChanged
		}
		if t.CommentId != "" {
			id, _ := discussionID(t.CommentId)
			if _, e = s.readDiscussionComment(ctx, token, base, repo, t.Number, id); e != nil {
				return e
			}
		}
		if e = fn(base, repo, before); e != nil {
			return e
		}
		after, e := s.readDiscussionIssue(ctx, token, base, repo, t.Number)
		if e != nil {
			return e
		}
		if after.ID != before.ID {
			return errIssueTargetChanged
		}
		if t.CommentId != "" {
			id, _ := discussionID(t.CommentId)
			if _, e = s.readDiscussionComment(ctx, token, base, repo, t.Number, id); e != nil {
				return e
			}
		}
		return nil
	})
}
func reactionSuffix(t *golfv1.DiscussionTarget) string {
	if t.CommentId != "" {
		return "/issues/comments/" + t.CommentId + "/reactions"
	}
	return issueSuffix(int64(t.Number)) + "/reactions"
}

type nativeDiscussionReaction struct {
	User    *User  `json:"user"`
	Content string `json:"content"`
	Created string `json:"created_at"`
}

func (s *Server) readDiscussionEngagement(ctx context.Context, session string, token forgeCredential, t *golfv1.DiscussionTarget) (*golfv1.GetDiscussionEngagementResponse, error) {
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, e
	}
	out := &golfv1.GetDiscussionEngagementResponse{ActorLogin: actor.Login}
	e = s.withDiscussionTarget(ctx, session, token, t, func(base string, repo Repository, issue discussionIssue) error {
		var rows []nativeDiscussionReaction
		if t.CommentId != "" {
			if _, e := s.forge(ctx, http.MethodGet, base+reactionSuffix(t), token, nil, &rows); e != nil {
				return e
			}
		} else {
			// Own-state absence is meaningful only after the full bounded inventory is read.
			e := s.withNativePageSize(ctx, token, 100, func(limit uint32) error {
				for page := uint32(1); page <= 100; page++ {
					var part []nativeDiscussionReaction
					headers, e := s.forge(ctx, http.MethodGet, base+reactionSuffix(t)+"?"+pageQuery(page, limit).Encode(), token, nil, &part)
					if e != nil {
						return e
					}
					if len(part) > int(limit) || len(rows)+len(part) > 10000 {
						return errForgeResponseTooLarge
					}
					rows = append(rows, part...)
					next, e := pullNextPage(headers, page, limit)
					if e != nil {
						return e
					}
					if next == 0 {
						return nil
					}
					if next != page+1 {
						return errInvalidForgeResponse
					}
				}
				return errForgeResponseTooLarge
			})
			if e != nil {
				return e
			}
		}
		if len(rows) > 10000 {
			return errForgeResponseTooLarge
		}
		counts := map[string]*golfv1.DiscussionReaction{}
		seen := map[string]bool{}
		for _, r := range rows {
			if !slices.Contains(discussionReactionNames, r.Content) || !validPullUser(r.User) || !validPullTime(r.Created) {
				return errInvalidForgeResponse
			}
			actorID := int64(0)
			if r.User != nil {
				actorID = r.User.ID
			}
			key := strconv.FormatInt(actorID, 10) + ":" + r.Content
			if actorID > 0 && seen[key] {
				return errInvalidForgeResponse
			}
			if actorID > 0 {
				seen[key] = true
			}
			v := counts[r.Content]
			if v == nil {
				v = &golfv1.DiscussionReaction{Content: r.Content}
				counts[r.Content] = v
			}
			v.Count++
			v.Reacted = v.Reacted || actorID == actor.ID
		}
		for _, name := range discussionReactionNames {
			v := counts[name]
			if v == nil {
				v = &golfv1.DiscussionReaction{Content: name}
			}
			out.Reactions = append(out.Reactions, v)
		}
		var watch struct {
			Subscribed *bool `json:"subscribed"`
			Ignored    *bool `json:"ignored"`
		}
		if _, e := s.forge(ctx, http.MethodGet, base+issueSuffix(int64(t.Number))+"/subscriptions/check", token, nil, &watch); e != nil {
			return e
		}
		if watch.Subscribed == nil || watch.Ignored == nil || *watch.Subscribed == *watch.Ignored {
			return errInvalidForgeResponse
		}
		out.Subscribed = *watch.Subscribed
		active, e := s.activeDiscussionUnit(ctx, token, base, repo, t.PullRequest)
		if e != nil {
			return e
		}
		// The native API additionally enforces locked-issue and blocked-user policy.
		_, delegated := ctx.Value(apiAuthKey{}).(apiAuth)
		out.CanReact = active && !delegated && issue.IsLocked != nil
		if out.CanReact && *issue.IsLocked {
			writer, e := s.milestoneEditAuthority(context.WithValue(ctx, pullDiscussionKey{}, t.PullRequest), token, base, repo)
			if e != nil {
				return e
			}
			out.CanReact = writer
		}
		out.CanSubscribe = active && !delegated && t.CommentId == ""
		out.Revision = resourceHash([]any{t.RepositoryId, t.IssueId, t.Number, t.PullRequest, t.CommentId, actor.ID, out.Reactions, out.Subscribed})
		return nil
	})
	if e != nil {
		return nil, e
	}
	return out, nil
}
func (s *Server) GetDiscussionEngagement(ctx context.Context, req *connect.Request[golfv1.GetDiscussionEngagementRequest]) (*connect.Response[golfv1.GetDiscussionEngagementResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	v, e := s.readDiscussionEngagement(ctx, s.cookieValue(req.Header()), token, req.Msg.Target)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(v), nil
}
func engagementNative(m *golfv1.SubmitDiscussionResourceOperationRequest, actorLogin string) (string, string, any) {
	switch resourceKind(m.Kind) {
	case "SUBSCRIBE":
		return http.MethodPut, issueSuffix(int64(m.Number)) + "/subscriptions/" + url.PathEscape(actorLogin), nil
	case "UNSUBSCRIBE":
		return http.MethodDelete, issueSuffix(int64(m.Number)) + "/subscriptions/" + url.PathEscape(actorLogin), nil
	case "REMOVE_REACTION":
		return http.MethodDelete, reactionSuffix(engagementTarget(m)), map[string]string{"content": m.GetReaction()}
	default:
		return http.MethodPost, reactionSuffix(engagementTarget(m)), map[string]string{"content": m.GetReaction()}
	}
}
func engagementMatches(m *golfv1.SubmitDiscussionResourceOperationRequest, v *golfv1.GetDiscussionEngagementResponse) bool {
	k := resourceKind(m.Kind)
	if k == "SUBSCRIBE" {
		return v.Subscribed
	}
	if k == "UNSUBSCRIBE" {
		return !v.Subscribed
	}
	for _, r := range v.Reactions {
		if r.Content == m.GetReaction() {
			return r.Reacted == (k == "ADD_REACTION")
		}
	}
	return false
}
func (s *Server) engagementAuthority(ctx context.Context, session string, token forgeCredential, r discussionResourceRecord) error {
	t := &golfv1.DiscussionTarget{Repository: &golfv1.RepositoryKey{Owner: r.Owner, Name: r.Name}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), IssueId: strconv.FormatInt(r.IssueID, 10), Number: uint32(r.Number), PullRequest: r.Pull}
	if r.EngagementComment {
		t.CommentId = strconv.FormatInt(r.ResourceID, 10)
	}
	return s.withDiscussionTarget(ctx, session, token, t, func(base string, repo Repository, _ discussionIssue) error {
		actor, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		if actor.ID != r.ActorID {
			return errUnauthenticated
		}
		active, e := s.activeDiscussionUnit(ctx, token, base, repo, r.Pull)
		if e != nil {
			return e
		}
		if !active {
			return forgeError{status: 403}
		}
		return nil
	})
}

// Native timeline metadata is bounded and rendered as text/Markdown. Nested cross-repository
// references are never returned merely because they appeared in an authorized timeline.
func (s *Server) ListDiscussionTimeline(ctx context.Context, req *connect.Request[golfv1.ListDiscussionTimelineRequest]) (*connect.Response[golfv1.ListDiscussionTimelineResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	t := req.Msg.Target
	if e = validateDiscussionTarget(t); e != nil {
		return nil, rpcError(e)
	}
	if t.CommentId != "" {
		return nil, rpcError(invalid("Timeline targets the discussion, not a comment."))
	}
	page, limit, e := pagination(pageFrom(req.Msg.Page))
	if e != nil {
		return nil, rpcError(e)
	}
	out := &golfv1.ListDiscussionTimelineResponse{}
	e = s.withDiscussionTarget(ctx, s.cookieValue(req.Header()), token, t, func(base string, repo Repository, _ discussionIssue) error {
		return s.withNativePageSize(ctx, token, limit, func(limit uint32) error {
			var rows []struct {
				ID       int64            `json:"id"`
				Kind     string           `json:"type"`
				User     *User            `json:"user"`
				Body     string           `json:"body"`
				Created  string           `json:"created_at"`
				IssueURL string           `json:"issue_url"`
				PullURL  string           `json:"pull_request_url"`
				OldTitle string           `json:"old_title"`
				NewTitle string           `json:"new_title"`
				Label    json.RawMessage  `json:"label"`
				RefIssue *discussionIssue `json:"ref_issue"`
			}
			headers, e := s.forge(ctx, http.MethodGet, base+issueSuffix(int64(t.Number))+"/timeline?"+pageQuery(page, limit).Encode(), token, nil, &rows)
			if e != nil {
				return e
			}
			if len(rows) > int(limit) {
				return errForgeResponseTooLarge
			}
			// Gitea timeline X-Total-Count is the filtered page length, not a global total.
			// Offer another native page after every nonempty page; never claim a total.
			count, err := strconv.Atoi(headers.Get("X-Total-Count"))
			if err != nil || count != len(rows) {
				return errInvalidForgeResponse
			}
			next := uint32(0)
			if len(rows) > 0 && page < 10000 {
				next = page + 1
			}
			out.Page = &golfv1.PageResponse{NextPage: next}
			seen := map[int64]bool{}
			for _, row := range rows {
				if row.ID <= 0 || seen[row.ID] || !discussionText(row.Kind, 64) || row.Kind == "" || !validPullTime(row.Created) || row.User != nil && !validPullUser(row.User) || !discussionText(row.Body, 256<<10) || !discussionText(row.OldTitle, 1024) || !discussionText(row.NewTitle, 1024) {
					return errInvalidForgeResponse
				}
				seen[row.ID] = true
				if !discussionURL(row.IssueURL, repo.HTMLURL, issueSuffix(int64(t.Number)), "") {
					return errInvalidForgeResponse
				}
				if t.PullRequest && !discussionURL(row.PullURL, repo.HTMLURL, discussionSuffix(int64(t.Number), true), "") {
					return errInvalidForgeResponse
				}
				if !t.PullRequest && row.PullURL != "" {
					return errInvalidForgeResponse
				}
				v := &golfv1.DiscussionTimelineEvent{Id: strconv.FormatInt(row.ID, 10), Kind: row.Kind, Actor: wirePullUser(row.User), CreatedAt: row.Created, Body: row.Body, OldTitle: row.OldTitle, NewTitle: row.NewTitle}
				if len(row.Label) > 0 && string(row.Label) != "null" {
					v.Label, e = nativeLabel(row.Label)
					if e != nil {
						return e
					}
				}
				ref := row.RefIssue
				if ref != nil && ref.Repository != nil && ref.Repository.ID == repo.ID && ref.Number > 0 && ref.Number <= 2147483647 {
					refctx := context.WithValue(ctx, pullDiscussionKey{}, ref.isPullRequest())
					fresh, e := s.readDiscussionIssue(refctx, token, base, repo, uint32(ref.Number))
					if e == nil && fresh.ID == ref.ID {
						v.ReferencedNumber = uint32(fresh.Number)
						v.ReferencedPullRequest = fresh.isPullRequest()
						v.ReferencedTitle = fresh.Title
					}
				}
				// Body can contain arbitrary native event data; only ordinary comments are rendered.
				if row.Kind != "comment" {
					v.Body = ""
				}
				out.Events = append(out.Events, v)
			}
			return nil
		})
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}

func (s *Server) preflightResourceRequest(ctx context.Context, session string, token forgeCredential, r discussionResourceRecord, m *golfv1.SubmitDiscussionResourceOperationRequest) error {
	if r.Kind == "MARK_NOTIFICATION_READ" {
		row, e := s.notificationForOperation(ctx, session, token, r)
		if e != nil {
			return e
		}
		if !row.Unread || row.Revision != r.Revision {
			return errIssueRevisionChanged
		}
		return nil
	}
	if !engagementKind(r.Kind) {
		return s.preflightDiscussionResource(ctx, session, token, r)
	}
	if e := s.resourceAuthority(ctx, session, token, r); e != nil {
		return e
	}
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return e
	}
	if actor.ID != r.ActorID {
		return errUnauthenticated
	}
	if m.SubscriptionLogin != "" && actor.Login != m.SubscriptionLogin {
		return errIssueTargetChanged
	}
	v, e := s.readDiscussionEngagement(ctx, session, token, engagementTarget(m))
	if e != nil {
		return e
	}
	if (r.Kind == "ADD_REACTION" || r.Kind == "REMOVE_REACTION") && !v.CanReact {
		return forgeError{status: http.StatusForbidden}
	}
	if (r.Kind == "SUBSCRIBE" || r.Kind == "UNSUBSCRIBE") && !v.CanSubscribe {
		return forgeError{status: http.StatusForbidden}
	}
	if v.Revision != r.Revision || engagementMatches(m, v) {
		return errIssueRevisionChanged
	}
	return nil
}
func (s *Server) dispatchEngagement(ctx context.Context, session string, token forgeCredential, r discussionResourceRecord, m *golfv1.SubmitDiscussionResourceOperationRequest) (int64, error) {
	base, _ := repositoryPath(repositoryKey{r.Owner, r.Name})
	method, suffix, payload := resourceNative(m)
	// Native own-subscription changes use 200/201; reaction removals use 200.
	// No response body is needed: success additionally requires an exact authorized state read.
	res, e := s.forgeRequest(ctx, method, base+suffix, "application/json", token, payload)
	if e != nil {
		return 0, e
	}
	defer res.Body.Close()
	allowedStatus := res.StatusCode == http.StatusOK || res.StatusCode == http.StatusCreated && resourceKind(m.Kind) != "REMOVE_REACTION" || res.StatusCode == http.StatusNoContent && resourceKind(m.Kind) == "REMOVE_REACTION"
	if !allowedStatus {
		return 0, errInvalidForgeResponse
	}
	if e := s.resourceAuthority(ctx, session, token, r); e != nil {
		return 0, e
	}
	v, e := s.readDiscussionEngagement(ctx, session, token, engagementTarget(m))
	if e != nil {
		return 0, e
	}
	if !engagementMatches(m, v) {
		return 0, errInvalidForgeResponse
	}
	return r.ResourceID, nil
}

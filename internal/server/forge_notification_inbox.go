package server

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

type nativeForgeNotification struct {
	ID         int64       `json:"id"`
	Repository *Repository `json:"repository"`
	Subject    *struct {
		Title   string `json:"title"`
		HTMLURL string `json:"html_url"`
		Type    string `json:"type"`
	} `json:"subject"`
	Unread  bool   `json:"unread"`
	Pinned  bool   `json:"pinned"`
	Updated string `json:"updated_at"`
}

func (s *Server) ownNotificationPage(ctx context.Context, token forgeCredential, page, limit uint32, all bool) ([]nativeForgeNotification, uint32, error) {
	query := pageQuery(page, limit)
	query.Set("all", strconv.FormatBool(all))
	query.Add("subject-type", "issue")
	query.Add("subject-type", "pull")
	var rows []nativeForgeNotification
	headers, e := s.forge(ctx, http.MethodGet, "/notifications?"+query.Encode(), token, nil, &rows)
	if e != nil {
		return nil, 0, e
	}
	if len(rows) > int(limit) {
		return nil, 0, errForgeResponseTooLarge
	}
	seen := map[int64]bool{}
	for _, row := range rows {
		if row.ID <= 0 || seen[row.ID] {
			return nil, 0, errInvalidForgeResponse
		}
		seen[row.ID] = true
	}
	next, e := pullNextPage(headers, page, limit)
	return rows, next, e
}
func (s *Server) authorizeOwnNotification(ctx context.Context, session string, token forgeCredential, n nativeForgeNotification) (*golfv1.OwnForgeNotification, error) {
	if n.ID <= 0 || n.Repository == nil || !validRepository(*n.Repository) || n.Subject == nil || !validPullTime(n.Updated) {
		return nil, errInvalidForgeResponse
	}
	pull := n.Subject.Type == "Pull"
	if !pull && n.Subject.Type != "Issue" {
		return nil, errResourceNotFound
	}
	parts := strings.Split(n.Repository.FullName, "/")
	if len(parts) != 2 {
		return nil, errInvalidForgeResponse
	}
	key := repositoryKey{parts[0], parts[1]}
	if _, e := repositoryPath(key); e != nil {
		return nil, e
	}
	u, e := url.Parse(n.Subject.HTMLURL)
	if e != nil {
		return nil, errInvalidForgeResponse
	}
	number, e := strconv.ParseUint(strings.TrimPrefix(u.Path, strings.TrimRight(mustURLPath(n.Repository.HTMLURL), "/")+map[bool]string{true: "/pulls/", false: "/issues/"}[pull]), 10, 32)
	if e != nil || number == 0 || number > 2147483647 || !discussionURL(n.Subject.HTMLURL, n.Repository.HTMLURL, discussionSuffix(int64(number), pull), "") {
		return nil, errInvalidForgeResponse
	}
	var out *golfv1.OwnForgeNotification
	e = s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		if repo.ID != n.Repository.ID {
			return errIssueTargetChanged
		}
		issue, e := s.readDiscussionIssue(context.WithValue(ctx, pullDiscussionKey{}, pull), token, base, repo, uint32(number))
		if e != nil {
			return e
		}
		actor, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		out = &golfv1.OwnForgeNotification{Id: strconv.FormatInt(n.ID, 10), Target: &golfv1.DiscussionTarget{Repository: &golfv1.RepositoryKey{Owner: key.Owner, Name: key.Name}, RepositoryId: strconv.FormatInt(repo.ID, 10), IssueId: strconv.FormatInt(issue.ID, 10), Number: uint32(number), PullRequest: pull}, Title: issue.Title, Unread: n.Unread, Pinned: n.Pinned, UpdatedAt: n.Updated}
		out.Revision = resourceHash([]any{n.ID, actor.ID, repo.ID, issue.ID, number, pull, n.Unread, n.Pinned, n.Updated})
		return nil
	})
	return out, e
}
func mustURLPath(v string) string {
	u, e := url.Parse(v)
	if e != nil {
		return ""
	}
	return u.Path
}
func (s *Server) ListOwnForgeNotifications(ctx context.Context, req *connect.Request[golfv1.ListOwnForgeNotificationsRequest]) (*connect.Response[golfv1.ListOwnForgeNotificationsResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	page, limit, e := pagination(pageFrom(req.Msg.Page))
	if e != nil {
		return nil, rpcError(e)
	}
	session := s.cookieValue(req.Header())
	out := &golfv1.ListOwnForgeNotificationsResponse{}
	e = s.withForgeCaller(ctx, session, token, func(User) error {
		return s.withNativePageSize(ctx, token, limit, func(limit uint32) error {
			rows, next, e := fillOwnNotifications(page, ownNotificationPages, func(page uint32) ([]nativeForgeNotification, uint32, error) {
				return s.ownNotificationPage(ctx, token, page, limit, req.Msg.IncludeRead)
			}, func(row nativeForgeNotification) (*golfv1.OwnForgeNotification, error) {
				return s.authorizeOwnNotification(ctx, session, token, row)
			})
			out.Notifications, out.Page = rows, wirePage(next)
			return e
		})
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}
func isForgeDenied(e error) bool { return connect.CodeOf(rpcError(e)) == connect.CodePermissionDenied }

// ownNotificationPages bounds the native pages one inbox page reads past threads the caller can no longer open.
const ownNotificationPages = 3

// fillOwnNotifications leaves out missing or denied threads, so a page can be shorter than its limit, but it reads on
// (up to maxPages native pages) rather than return a page that filter emptied while a later page exists. The cursor is
// the next native page not yet read.
func fillOwnNotifications(page uint32, maxPages int, read func(uint32) ([]nativeForgeNotification, uint32, error), authorize func(nativeForgeNotification) (*golfv1.OwnForgeNotification, error)) ([]*golfv1.OwnForgeNotification, uint32, error) {
	var out []*golfv1.OwnForgeNotification
	for range maxPages {
		rows, next, e := read(page)
		if e != nil {
			return nil, 0, e
		}
		seen := map[int64]bool{}
		for _, row := range rows {
			if seen[row.ID] {
				return nil, 0, errInvalidForgeResponse
			}
			seen[row.ID] = true
			v, e := authorize(row)
			if sourceNotFound(e) || isForgeDenied(e) {
				continue
			}
			if e != nil {
				return nil, 0, e
			}
			out = append(out, v)
		}
		if len(out) > 0 || next == 0 {
			return out, next, nil
		}
		page = next
	}
	return out, page, nil
}

// Native thread GET permits administrators to access others' threads. Ownership is
// established from the current actor's list endpoint before ever reading a thread ID.
func (s *Server) notificationForOperation(ctx context.Context, session string, token forgeCredential, r discussionResourceRecord) (*golfv1.OwnForgeNotification, error) {
	var out *golfv1.OwnForgeNotification
	e := s.withForgeCaller(ctx, session, token, func(actor User) error {
		if actor.ID != r.ActorID {
			return errUnauthenticated
		}
		return s.withNativePageSize(ctx, token, 100, func(limit uint32) error {
			for page := uint32(1); page <= 100; page++ {
				rows, next, e := s.ownNotificationPage(ctx, token, page, limit, true)
				if e != nil {
					return e
				}
				for _, row := range rows {
					if row.ID != r.ResourceID {
						continue
					}
					v, e := s.authorizeOwnNotification(ctx, session, token, row)
					if e != nil {
						return e
					}
					if v.Target.RepositoryId != strconv.FormatInt(r.RepositoryID, 10) || v.Target.IssueId != strconv.FormatInt(r.IssueID, 10) || v.Target.Number != uint32(r.Number) || v.Target.PullRequest != r.Pull || v.Target.Repository.Owner != r.Owner || v.Target.Repository.Name != r.Name {
						return errIssueTargetChanged
					}
					out = v
					return nil
				}
				if next == 0 {
					return errResourceNotFound
				}
				if next != page+1 {
					return errInvalidForgeResponse
				}
			}
			return errForgeResponseTooLarge
		})
	})
	return out, e
}
func (s *Server) dispatchNotificationRead(ctx context.Context, session string, token forgeCredential, r discussionResourceRecord, _ *golfv1.SubmitDiscussionResourceOperationRequest) (int64, error) {
	if _, e := s.notificationForOperation(ctx, session, token, r); e != nil {
		return 0, e
	}
	// The owned journal/lifecycle transaction is already held. Only this fixed global
	// endpoint is dispatched; no client/provider URL is followed and no bulk writes occur.
	var receipt nativeForgeNotification
	if _, e := s.forgeJSON(ctx, http.MethodPatch, "/notifications/threads/"+strconv.FormatInt(r.ResourceID, 10)+"?to-status=read", token, nil, &receipt, http.StatusResetContent); e != nil {
		return 0, e
	}
	if receipt.ID != r.ResourceID || receipt.Unread {
		return 0, errInvalidForgeResponse
	}
	out, e := s.notificationForOperation(ctx, session, token, r)
	if e != nil {
		return 0, e
	}
	if out.Unread {
		return 0, errInvalidForgeResponse
	}
	return r.ResourceID, nil
}

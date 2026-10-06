package server

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// These are native observations, not current reviewer grants or publication
// authority. In particular, official/stale are provider assertions; exact H is
// compared independently so delayed stale dismissal cannot inflate the count.
func protectedReviewFacts(pull forgePull, head string, rows []forgePullReview) *golfv1.ProtectedReviewObservation {
	out := &golfv1.ProtectedReviewObservation{SelectedHeadCommitId: head, ObservedReviews: uint32(len(rows))}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	latest := map[int64]int64{}
	for _, row := range rows {
		if row.User != nil && row.User.ID > 0 && (row.State == "APPROVED" || row.State == "REQUEST_CHANGES") {
			latest[row.User.ID] = row.ID
		}
	}
	for _, row := range rows {
		reason := ""
		switch {
		case row.State != "APPROVED" && row.State != "REQUEST_CHANGES":
			reason = "non_decision"
		case row.User == nil || row.User.ID <= 0 || !row.Official:
			reason = "unofficial"
		case pull.User != nil && row.User.ID == pull.User.ID:
			reason = "author"
		case row.CommitID != head:
			reason = "stale_head"
		case row.Dismissed:
			reason = "dismissed"
		case row.Stale:
			reason = "stale"
		case latest[row.User.ID] != row.ID:
			reason = "superseded"
		}
		if reason != "" {
			actor := ""
			if row.User != nil && row.User.ID > 0 {
				actor = strconv.FormatInt(row.User.ID, 10)
			}
			out.Exclusions = append(out.Exclusions, &golfv1.ProtectedReviewExclusion{ReviewId: strconv.FormatInt(row.ID, 10), ReviewerId: actor, ReviewedCommitId: row.CommitID, Reason: reason})
		} else if row.State == "APPROVED" {
			out.ExactHeadOfficialApprovals++
		} else {
			out.ExactHeadOfficialChangeRequests++
		}
	}
	return out
}

func (s *Server) protectedReviewObservation(ctx context.Context, token forgeCredential, base string, pull forgePull, head string) (*golfv1.ProtectedReviewObservation, error) {
	var rows []forgePullReview
	e := s.withNativePageSize(ctx, token, 100, func(limit uint32) error {
		seen := map[int64]bool{}
		total := int64(-1)
		// ponytail: at most 200 reviews per observation; larger inventories need a
		// separately paged diagnostic, never a partial approval count.
		for page := uint32(1); page <= 200; page++ {
			var raw []json.RawMessage
			h, e := s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatInt(pull.Number, 10)+"/reviews?"+pageQuery(page, limit).Encode(), token, nil, &raw)
			if e != nil {
				return e
			}
			count, e := strconv.ParseInt(h.Get("X-Total-Count"), 10, 64)
			if e != nil || count < 0 || count > 200 || raw == nil || len(raw) > int(limit) || total >= 0 && total != count {
				return errInvalidForgeResponse
			}
			total = count
			for _, data := range raw {
				var row forgePullReview
				var flags struct{ Stale, Dismissed, Official *bool }
				if json.Unmarshal(data, &row) != nil || json.Unmarshal(data, &flags) != nil || flags.Stale == nil || flags.Dismissed == nil || flags.Official == nil || row.ID <= 0 || seen[row.ID] || !validPullUser(row.User) || pullReviewState(row.State) == 0 || row.CommitID != "" && !objectID.MatchString(row.CommitID) || !validPullTime(row.SubmittedAt) || !validPullTime(row.UpdatedAt) || row.PullRequestURL != pull.HTMLURL {
					return errInvalidForgeResponse
				}
				seen[row.ID] = true
				rows = append(rows, row)
			}
			next, e := pullNextPage(h, page, limit)
			if e != nil {
				return e
			}
			if next == 0 {
				if int64(len(rows)) != total {
					return errInvalidForgeResponse
				}
				return nil
			}
			if next != page+1 || len(rows) > 200 {
				return errInvalidForgeResponse
			}
		}
		return errForgeResponseTooLarge
	})
	if e != nil {
		// Missing read scope/data never becomes an empty successful inventory.
		if mergeReadUnavailable(e) {
			return &golfv1.ProtectedReviewObservation{SelectedHeadCommitId: head, UnavailableReason: "native_reviews_unavailable"}, nil
		}
		return nil, e
	}
	return protectedReviewFacts(pull, head, rows), nil
}

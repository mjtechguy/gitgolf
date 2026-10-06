package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestProtectedReviewExactHeadObservations087(t *testing.T) {
	head := strings.Repeat("a", 40)
	pull := forgePull{User: &User{ID: 1}}
	rows := []forgePullReview{}
	for i, reason := range []string{"count", "stale_head", "dismissed", "stale", "unofficial", "author", "non_decision", "superseded", "change"} {
		row := forgePullReview{ID: int64(i + 1), User: &User{ID: int64(i + 2)}, State: "APPROVED", CommitID: head, Official: true}
		switch reason {
		case "stale_head":
			row.CommitID = strings.Repeat("b", 40) // native still says fresh
		case "dismissed":
			row.Dismissed = true
		case "stale":
			row.Stale = true
		case "unofficial":
			row.Official = false
		case "author":
			row.User.ID = 1
		case "non_decision":
			row.State = "COMMENT"
		case "superseded":
			row.User.ID = 10
		case "change":
			row.State = "REQUEST_CHANGES"
		}
		rows = append(rows, row)
	}
	out := protectedReviewFacts(pull, head, rows)
	if out.ExactHeadOfficialApprovals != 1 || out.ExactHeadOfficialChangeRequests != 1 || out.ObservedReviews != 9 || len(out.Exclusions) != 7 {
		t.Fatal("old/stale/dismissed/self/duplicate reviews inflated native count", out)
	}
	for i, reason := range []string{"stale_head", "dismissed", "stale", "unofficial", "author", "non_decision", "superseded"} {
		if out.Exclusions[i].Reason != reason {
			t.Fatal("review exclusion changed", out.Exclusions[i])
		}
	}
}

func TestProtectedReviewCompleteInventory087(t *testing.T) {
	for _, mode := range []string{"valid", "missing-flag", "wrong-pr", "duplicate", "truncated", "changed-total", "too-many", "denied"} {
		t.Run(mode, func(t *testing.T) {
			pull := forgePull{Number: 7, HTMLURL: "https://forge.invalid/pulls/7", User: &User{ID: 1}}
			head := strings.Repeat("a", 40)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					t.Fatal("review observation dispatched a mutation")
				}
				if r.URL.Path == "/api/v1/settings/api" {
					json.NewEncoder(w).Encode(map[string]int{"max_response_items": 1})
					return
				}
				if mode == "denied" {
					w.WriteHeader(403)
					return
				}
				page, _ := strconv.Atoi(r.URL.Query().Get("page"))
				if mode == "truncated" && page == 2 {
					w.Header().Set("X-Total-Count", "2")
					json.NewEncoder(w).Encode([]any{})
					return
				}
				total := "2"
				if mode == "changed-total" && page == 2 {
					total = "3"
				}
				if mode == "too-many" {
					total = "201"
				}
				w.Header().Set("X-Total-Count", total)
				if page == 1 && mode != "truncated" {
					w.Header().Set("Link", `</api/v1/repos/alice/private/pulls/7/reviews?page=2&limit=1>; rel="next"`)
				}
				row := map[string]any{"id": page, "user": &User{ID: int64(page + 2), Login: "reviewer"}, "state": "APPROVED", "commit_id": head, "official": true, "stale": false, "dismissed": false, "submitted_at": "2026-10-06T00:00:00Z", "updated_at": "2026-10-06T00:00:00Z", "pull_request_url": pull.HTMLURL}
				if mode == "missing-flag" {
					delete(row, "stale")
				}
				if mode == "wrong-pr" {
					row["pull_request_url"] = "https://forge.invalid/pulls/8"
				}
				if mode == "duplicate" {
					row["id"] = 1
				}
				json.NewEncoder(w).Encode([]any{row})
			}))
			defer provider.Close()
			s := &Server{config: Config{GiteaURL: provider.URL}, client: provider.Client()}
			out, e := s.protectedReviewObservation(t.Context(), forgeCredential{Kind: "pat", Token: "owned-test"}, "/repos/alice/private", pull, head)
			if mode == "valid" {
				if e != nil || out.ExactHeadOfficialApprovals != 2 || out.UnavailableReason != "" {
					t.Fatal("complete exact-head reviews unavailable", e, out)
				}
			} else if mode == "denied" {
				if e != nil || out.UnavailableReason != "native_reviews_unavailable" || out.ExactHeadOfficialApprovals != 0 {
					t.Fatal("scope denial became a success", e, out)
				}
			} else if e == nil {
				t.Fatal("partial/ambiguous native inventory produced a count", out)
			}
		})
	}
}

package server

import (
	"encoding/json"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Raw fields distinguish an omitted capability from native null/empty data.
// They are embedded in both native issue and PR DTOs, without another request.
type forgeDiscussionMetadata struct {
	Labels    json.RawMessage `json:"labels,omitempty"`
	Assignees json.RawMessage `json:"assignees,omitempty"`
	Assignee  json.RawMessage `json:"assignee,omitempty"`
	Milestone json.RawMessage `json:"milestone,omitempty"`
}
type forgeDiscussionLabel struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
	Exclusive   bool   `json:"exclusive"`
	Archived    bool   `json:"is_archived"`
}
type forgeDiscussionMilestone struct {
	ID           int64   `json:"id"`
	Title        string  `json:"title"`
	Description  string  `json:"description"`
	State        string  `json:"state"`
	OpenIssues   *int64  `json:"open_issues"`
	ClosedIssues *int64  `json:"closed_issues"`
	DueOn        *string `json:"due_on"`
}

func discussionMetadataName(value string) bool {
	return value != "" && len(value) <= 1024 && utf8.ValidString(value) && strings.IndexFunc(value, unicode.IsControl) < 0
}

// These are display observations, not assignability, edit rights or an atomic
// metadata revision. Provider URLs are never followed or exported as local links.
func discussionMetadata(row forgeDiscussionMetadata) (*golfv1.DiscussionMetadata, error) {
	if len(row.Labels)+len(row.Assignees)+len(row.Assignee)+len(row.Milestone) == 0 {
		return nil, nil
	}
	result := &golfv1.DiscussionMetadata{LabelsKnown: len(row.Labels) > 0, AssigneesKnown: len(row.Assignees) > 0 || len(row.Assignee) > 0, MilestoneKnown: len(row.Milestone) > 0}
	if len(row.Labels) > 1<<20 || len(row.Assignees) > 256<<10 || len(row.Assignee) > 16<<10 || len(row.Milestone) > 128<<10 {
		return nil, errForgeResponseTooLarge
	}
	if result.LabelsKnown {
		var labels []forgeDiscussionLabel
		if json.Unmarshal(row.Labels, &labels) != nil || len(labels) > 256 {
			return nil, errInvalidForgeResponse
		}
		seen := map[int64]bool{}
		for _, label := range labels {
			if label.ID <= 0 || seen[label.ID] || !discussionMetadataName(label.Name) || !discussionText(label.Description, 4096) || len(label.Color) != 6 || strings.IndexFunc(label.Color, func(r rune) bool { return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') }) >= 0 {
				return nil, errInvalidForgeResponse
			}
			seen[label.ID] = true
			result.Labels = append(result.Labels, &golfv1.DiscussionLabel{Id: strconv.FormatInt(label.ID, 10), Name: label.Name, Color: strings.ToLower(label.Color), Description: label.Description, Exclusive: label.Exclusive, Archived: label.Archived})
		}
	}
	if result.AssigneesKnown {
		var assignees []*User
		var legacy *User
		if len(row.Assignee) > 0 && json.Unmarshal(row.Assignee, &legacy) != nil {
			return nil, errInvalidForgeResponse
		}
		if len(row.Assignees) > 0 {
			if json.Unmarshal(row.Assignees, &assignees) != nil {
				return nil, errInvalidForgeResponse
			}
		} else if legacy != nil {
			assignees = []*User{legacy}
		}
		if len(assignees) > 100 {
			return nil, errInvalidForgeResponse
		}
		seen := map[int64]bool{}
		logins := map[string]bool{}
		legacyFound := legacy == nil
		for _, user := range assignees {
			if user == nil || user.ID <= 0 || !validPullUser(user) || seen[user.ID] || logins[strings.ToLower(user.Login)] || !discussionText(user.FullName, 1024) {
				return nil, errInvalidForgeResponse
			}
			seen[user.ID] = true
			logins[strings.ToLower(user.Login)] = true
			if legacy != nil && legacy.ID == user.ID && strings.EqualFold(legacy.Login, user.Login) {
				legacyFound = true
			}
			result.Assignees = append(result.Assignees, wireUser(*user))
		}
		if !legacyFound {
			return nil, errInvalidForgeResponse
		}
	}
	if result.MilestoneKnown {
		var milestone *forgeDiscussionMilestone
		if json.Unmarshal(row.Milestone, &milestone) != nil {
			return nil, errInvalidForgeResponse
		}
		if milestone != nil {
			if milestone.ID <= 0 || !discussionMetadataName(milestone.Title) || !discussionText(milestone.Description, 64<<10) || (milestone.State != "open" && milestone.State != "closed") || milestone.OpenIssues == nil || milestone.ClosedIssues == nil || *milestone.OpenIssues < 0 || *milestone.ClosedIssues < 0 || milestone.DueOn != nil && !validPullTime(*milestone.DueOn) {
				return nil, errInvalidForgeResponse
			}
			state := golfv1.IssueState_ISSUE_STATE_OPEN
			if milestone.State == "closed" {
				state = golfv1.IssueState_ISSUE_STATE_CLOSED
			}
			result.Milestone = &golfv1.DiscussionMilestone{Id: strconv.FormatInt(milestone.ID, 10), Title: milestone.Title, Description: milestone.Description, State: state, OpenIssues: uint64(*milestone.OpenIssues), ClosedIssues: uint64(*milestone.ClosedIssues)}
			if milestone.DueOn != nil {
				result.Milestone.DueOn = *milestone.DueOn
			}
		}
	}
	return result, nil
}

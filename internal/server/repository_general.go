package server

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type forgeInternalTracker struct {
	EnableTimeTracker     bool `json:"enable_time_tracker"`
	AllowOnlyContributors bool `json:"allow_only_contributors_to_track_time"`
	EnableDependencies    bool `json:"enable_issue_dependencies"`
}
type forgeExternalTracker struct {
	URL     string `json:"external_tracker_url"`
	Format  string `json:"external_tracker_format"`
	Style   string `json:"external_tracker_style"`
	Pattern string `json:"external_tracker_regexp_pattern"`
}
type forgeExternalWiki struct {
	URL string `json:"external_wiki_url"`
}

// Native config fields are complete observations; missing/null values must not
// become false/empty settings in a stale-edit fingerprint.
func (t *forgeInternalTracker) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return errInvalidForgeResponse
	}
	for _, key := range []string{"enable_time_tracker", "allow_only_contributors_to_track_time", "enable_issue_dependencies"} {
		v := strings.TrimSpace(string(fields[key]))
		if v != "true" && v != "false" {
			return errInvalidForgeResponse
		}
	}
	type value forgeInternalTracker
	return json.Unmarshal(data, (*value)(t))
}
func (t *forgeExternalTracker) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return errInvalidForgeResponse
	}
	for _, key := range []string{"external_tracker_url", "external_tracker_format", "external_tracker_style", "external_tracker_regexp_pattern"} {
		var v string
		if fields[key] == nil || string(fields[key]) == "null" || json.Unmarshal(fields[key], &v) != nil {
			return errInvalidForgeResponse
		}
	}
	type value forgeExternalTracker
	return json.Unmarshal(data, (*value)(t))
}
func (t *forgeExternalWiki) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return errInvalidForgeResponse
	}
	var url string
	if fields["external_wiki_url"] == nil || string(fields["external_wiki_url"]) == "null" || json.Unmarshal(fields["external_wiki_url"], &url) != nil {
		return errInvalidForgeResponse
	}
	t.URL = url
	return nil
}

var repositoryTopicPattern = regexp.MustCompile(`^[a-z0-9][-.a-z0-9]*$`)

func validRepositoryTopics(values []string) bool {
	if len(values) > 25 {
		return false
	}
	seen := map[string]bool{}
	for _, v := range values {
		if len(v) > 35 || !repositoryTopicPattern.MatchString(v) || seen[v] {
			return false
		}
		seen[v] = true
	}
	return true
}
func validExternalTrackerRead(t *forgeExternalTracker) bool {
	return t == nil || profileText(t.URL, 1024, false) && profileText(t.Format, 2048, false) && profileText(t.Style, 32, false) && profileText(t.Pattern, 1024, false)
}
func projectGeneralSettings(row forgeRepositorySettings, value *golfv1.RepositorySettings) error {
	if row.Topics == nil || !validRepositoryTopics(*row.Topics) || !profileText(row.Website, 1024, false) || !validExternalTrackerRead(row.ExternalTracker) || row.ExternalWiki != nil && !profileText(row.ExternalWiki.URL, 1024, false) {
		return errInvalidForgeResponse
	}
	value.Website = row.Website
	value.Topics = append([]string{}, (*row.Topics)...)
	slices.Sort(value.Topics)
	value.IssuesMode = golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_DISABLED
	if *row.HasIssues {
		if row.ExternalTracker != nil && row.InternalTracker == nil {
			value.IssuesMode = golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL
			t := row.ExternalTracker
			value.ExternalTracker = &golfv1.RepositoryExternalTracker{Url: t.URL, Format: t.Format, Style: t.Style, RegexpPattern: t.Pattern}
		} else if row.InternalTracker != nil && row.ExternalTracker == nil {
			value.IssuesMode = golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_INTERNAL
		} else {
			return errInvalidForgeResponse
		}
	} else if row.InternalTracker != nil || row.ExternalTracker != nil {
		return errInvalidForgeResponse
	}
	value.WikiMode = golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_DISABLED
	if *row.HasWiki {
		value.WikiMode = golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_INTERNAL
		if row.ExternalWiki != nil {
			value.WikiMode = golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL
			value.ExternalWiki = &golfv1.RepositoryExternalWiki{Url: row.ExternalWiki.URL}
		}
	} else if row.ExternalWiki != nil {
		return errInvalidForgeResponse
	}
	value.Archived = *row.Archived
	value.Mirror = *row.Mirror
	value.GeneralEditImplemented = true
	return nil
}
func generalFeaturePatch(req *golfv1.UpdateRepositorySettingsRequest, patch map[string]any) error {
	if req.Website != nil {
		if *req.Website != "" && overviewWebsite(*req.Website) != *req.Website {
			return invalid("Website must be an HTTP(S) URL without credentials, or empty to clear.")
		}
		patch["website"] = *req.Website
	}
	if req.IssuesMode != nil {
		if req.HasIssues != nil {
			return invalid("Choose one issues mode, not a legacy issues flag as well.")
		}
		switch *req.IssuesMode {
		case golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_DISABLED:
			patch["has_issues"] = false
		case golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_INTERNAL:
			patch["has_issues"] = true
		case golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL:
			t := req.ExternalTracker
			if t == nil || t.Url == "" || overviewWebsite(t.Url) != t.Url || !profileText(t.Format, 2048, false) || !profileText(t.RegexpPattern, 1024, false) {
				return invalid("Provide a safe external tracker URL and bounded format/pattern.")
			}
			if t.Style != "numeric" && t.Style != "alphanumeric" && t.Style != "regexp" {
				return invalid("Choose numeric, alphanumeric or regexp external issue identifiers.")
			}
			if t.Style == "regexp" {
				if t.RegexpPattern == "" {
					return invalid("A regexp tracker requires an identifier pattern.")
				}
				if _, err := regexp.Compile(t.RegexpPattern); err != nil {
					return invalid("External issue identifier pattern is invalid.")
				}
			}
			format := t.Format
			for _, p := range []string{"{user}", "{repo}", "{index}"} {
				format = strings.ReplaceAll(format, p, "value")
			}
			if t.Format != "" && overviewWebsite(format) != format {
				return invalid("Tracker issue format must be a safe HTTP(S) URL using supported placeholders.")
			}
			patch["has_issues"] = true
			patch["external_tracker"] = &forgeExternalTracker{URL: t.Url, Format: t.Format, Style: t.Style, Pattern: t.RegexpPattern}
		default:
			return invalid("Choose a supported issues mode.")
		}
	}
	if req.ExternalTracker != nil && (req.IssuesMode == nil || *req.IssuesMode != golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL) {
		return invalid("External tracker configuration requires an explicit external issues mode.")
	}
	if req.WikiMode != nil {
		if req.HasWiki != nil {
			return invalid("Choose one wiki mode, not a legacy wiki flag as well.")
		}
		switch *req.WikiMode {
		case golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_DISABLED:
			patch["has_wiki"] = false
		case golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_INTERNAL:
			patch["has_wiki"] = true
		case golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL:
			if req.ExternalWiki == nil || req.ExternalWiki.Url == "" || overviewWebsite(req.ExternalWiki.Url) != req.ExternalWiki.Url {
				return invalid("Provide a safe external wiki HTTP(S) URL.")
			}
			patch["has_wiki"] = true
			patch["external_wiki"] = &forgeExternalWiki{URL: req.ExternalWiki.Url}
		default:
			return invalid("Choose a supported wiki mode.")
		}
	}
	if req.ExternalWiki != nil && (req.WikiMode == nil || *req.WikiMode != golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL) {
		return invalid("External wiki configuration requires an explicit external wiki mode.")
	}
	return nil
}
func generalSettingsMatch(settings *golfv1.RepositorySettings, req *golfv1.UpdateRepositorySettingsRequest) bool {
	return (req.Website == nil || settings.Website == *req.Website) && (req.IssuesMode == nil || settings.IssuesMode == *req.IssuesMode) && (req.WikiMode == nil || settings.WikiMode == *req.WikiMode) && (req.ExternalTracker == nil || proto.Equal(settings.ExternalTracker, req.ExternalTracker)) && (req.ExternalWiki == nil || proto.Equal(settings.ExternalWiki, req.ExternalWiki))
}

// Include all native general configuration, even read-only internal tracker
// options, so an external editor cannot be silently overwritten after preview.
func generalRevisionData(row forgeRepositorySettings) json.RawMessage {
	data, _ := json.Marshal(struct {
		Website  string
		Topics   []string
		Internal *forgeInternalTracker
		Tracker  *forgeExternalTracker
		Wiki     *forgeExternalWiki
	}{row.Website, *row.Topics, row.InternalTracker, row.ExternalTracker, row.ExternalWiki})
	return data
}

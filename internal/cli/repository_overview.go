package cli

import (
	"errors"
	"math"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func repositoryReadKey(row *golfv1.Repository, requested *golfv1.RepositoryKey) (*golfv1.RepositoryKey, error) {
	if row == nil || !canonicalNativeID(row.GetId()) {
		return nil, errors.New("repository identity unavailable")
	}
	parts := strings.Split(row.GetFullName(), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] != row.GetName() || !strings.EqualFold(row.GetFullName(), requested.GetOwner()+"/"+requested.GetName()) {
		return nil, errors.New("repository identity mismatch")
	}
	return &golfv1.RepositoryKey{Owner: parts[0], Name: parts[1]}, nil
}

func validateRepositoryOverview(row *golfv1.GetRepositoryOverviewResponse, key *golfv1.RepositoryKey, id string) error {
	failure := errors.New("repository overview receipt mismatch")
	text := func(value string, limit int, multiline bool) bool {
		if len(value) > limit || !utf8.ValidString(value) {
			return false
		}
		for _, c := range value {
			if unicode.IsControl(c) && !(multiline && (c == '\n' || c == '\r' || c == '\t')) {
				return false
			}
		}
		return true
	}
	names := func(values []string, count, limit int) bool {
		if len(values) > count {
			return false
		}
		seen := map[string]bool{}
		for _, value := range values {
			if value == "" || strings.TrimSpace(value) != value || !text(value, limit, false) || seen[value] {
				return false
			}
			seen[value] = true
		}
		return true
	}
	count := func(value string) (int64, bool) {
		n, err := strconv.ParseInt(value, 10, 64)
		return n, err == nil && n >= 0 && strconv.FormatInt(n, 10) == value
	}
	state := func(value golfv1.RepositoryOverviewSectionState) bool {
		return value == golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE || value == golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_UNAVAILABLE || value == golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_ERROR
	}
	if row == nil || row.RepositoryId != id || !proto.Equal(row.Repository, key) || !text(row.Description, 2048, true) || !names(row.Topics, 100, 100) || !names(row.LicenseIds, 128, 128) || len(row.Languages) > 256 || !state(row.LanguagesState) || !state(row.LicensesState) {
		return failure
	}
	if row.Website != "" {
		u, err := url.ParseRequestURI(row.Website)
		if err != nil || !text(row.Website, 1024, false) || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
			return failure
		}
	}
	for _, value := range []*string{row.StarsCount, row.WatchersCount, row.ForksCount} {
		if value != nil {
			if _, ok := count(*value); !ok {
				return failure
			}
		}
	}
	var total int64
	var languages []string
	for _, language := range row.Languages {
		if language == nil {
			return failure
		}
		n, ok := count(language.ByteCount)
		if !ok || n > math.MaxInt64-total {
			return failure
		}
		total += n
		languages = append(languages, language.Name)
	}
	if !names(languages, 256, 100) || row.LanguagesState != golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE && len(row.Languages) != 0 || row.LicensesState != golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE && len(row.LicenseIds) != 0 {
		return failure
	}
	return nil
}

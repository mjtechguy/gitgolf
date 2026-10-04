package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// These values are current native metadata. No field is bound to the selected
// source commit, and the independent native index reads are not atomic.
type forgeRepositoryOverview struct {
	Repository
	Website       string    `json:"website"`
	Topics        *[]string `json:"topics"`
	StarsCount    *int64    `json:"stars_count"`
	WatchersCount *int64    `json:"watchers_count"`
	ForksCount    *int64    `json:"forks_count"`
}

func overviewWebsite(value string) string {
	if !profileText(value, 1024, false) {
		return ""
	}
	u, err := url.ParseRequestURI(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return ""
	}
	return value
}

func overviewNames(values []string, count, length int) bool {
	if values == nil || len(values) > count {
		return false
	}
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if value == "" || strings.TrimSpace(value) != value || !profileText(value, length, false) || seen[value] {
			return false
		}
		seen[value] = true
	}
	return true
}

func wireRepositoryOverview(row forgeRepositoryOverview, expected Repository) (*golfv1.GetRepositoryOverviewResponse, error) {
	owner, name, ok := strings.Cut(row.FullName, "/")
	if !ok || row.ID != expected.ID || row.Name != expected.Name || row.FullName != expected.FullName || name != row.Name ||
		!profileText(row.Description, 2048, true) || row.Topics == nil || !overviewNames(*row.Topics, 100, 100) {
		return nil, errInvalidForgeResponse
	}
	if _, err := repositoryPath(repositoryKey{owner, name}); err != nil {
		return nil, errInvalidForgeResponse
	}
	result := &golfv1.GetRepositoryOverviewResponse{
		Repository: &golfv1.RepositoryKey{Owner: owner, Name: name}, RepositoryId: strconv.FormatInt(row.ID, 10),
		Description: row.Description, Website: overviewWebsite(row.Website), Topics: append([]string{}, (*row.Topics)...),
	}
	for _, count := range []struct {
		native *int64
		wire   **string
	}{
		{row.StarsCount, &result.StarsCount}, {row.WatchersCount, &result.WatchersCount}, {row.ForksCount, &result.ForksCount},
	} {
		if count.native != nil {
			if *count.native < 0 {
				return nil, errInvalidForgeResponse
			}
			value := strconv.FormatInt(*count.native, 10)
			*count.wire = &value
		}
	}
	return result, nil
}

// Reject duplicate JSON names and noncanonical/overflowing numeric observations
// instead of letting map decoding silently replace a language or round bytes.
type overviewLanguages map[string]int64

func (values *overviewLanguages) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errInvalidForgeResponse
	}
	result := overviewLanguages{}
	var total int64
	for decoder.More() {
		key, err := decoder.Token()
		name, ok := key.(string)
		if err != nil || !ok || name == "" || strings.TrimSpace(name) != name || !profileText(name, 100, false) || len(result) >= 256 {
			return errInvalidForgeResponse
		}
		if _, duplicate := result[name]; duplicate {
			return errInvalidForgeResponse
		}
		value, err := decoder.Token()
		number, numeric := value.(json.Number)
		if err != nil || !numeric {
			return errInvalidForgeResponse
		}
		size, err := strconv.ParseInt(number.String(), 10, 64)
		if err != nil || size < 0 || strconv.FormatInt(size, 10) != number.String() || size > math.MaxInt64-total {
			return errInvalidForgeResponse
		}
		total += size
		result[name] = size
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return errInvalidForgeResponse
	}
	*values = result
	return nil
}

func overviewSectionError(err error) (golfv1.RepositoryOverviewSectionState, error) {
	if err == nil {
		return golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE, nil
	}
	var upstream forgeError
	if errors.As(err, &upstream) {
		if upstream.status == http.StatusUnauthorized {
			return 0, err
		}
		if upstream.status == http.StatusForbidden || upstream.status == http.StatusNotFound {
			return golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_UNAVAILABLE, nil
		}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return 0, err
	}
	return golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_ERROR, nil
}

func (s *Server) readOverviewIndexes(ctx context.Context, base string, credential forgeCredential, result *golfv1.GetRepositoryOverviewResponse) error {
	var languages overviewLanguages
	_, err := s.forge(ctx, http.MethodGet, base+"/languages", credential, nil, &languages)
	result.LanguagesState, err = overviewSectionError(err)
	if err != nil {
		return err
	}
	if result.LanguagesState == golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE {
		for name, count := range languages {
			result.Languages = append(result.Languages, &golfv1.RepositoryLanguage{Name: name, ByteCount: strconv.FormatInt(count, 10)})
		}
		sort.Slice(result.Languages, func(i, j int) bool {
			a, b := result.Languages[i], result.Languages[j]
			if languages[a.Name] != languages[b.Name] {
				return languages[a.Name] > languages[b.Name]
			}
			return a.Name < b.Name
		})
	}
	var licenses []string
	_, err = s.forge(ctx, http.MethodGet, base+"/licenses", credential, nil, &licenses)
	if err == nil && !overviewNames(licenses, 128, 128) {
		err = errInvalidForgeResponse
	}
	result.LicensesState, err = overviewSectionError(err)
	if err != nil {
		return err
	}
	if result.LicensesState == golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE {
		result.LicenseIds = licenses
	}
	return nil
}

func (s *Server) GetRepositoryOverview(ctx context.Context, req *connect.Request[golfv1.GetRepositoryOverviewRequest]) (*connect.Response[golfv1.GetRepositoryOverviewResponse], error) {
	id, err := discussionID(req.Msg.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	key := keyFrom(req.Msg.Repository)
	if _, err := repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	credential, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.GetRepositoryOverviewResponse
	err = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), credential, key, func(base string, repo Repository) error {
		if repo.ID != id {
			return errIssueTargetChanged
		}
		var metadata forgeRepositoryOverview
		if _, err := s.forge(ctx, http.MethodGet, base, credential, nil, &metadata); err != nil {
			return err
		}
		var err error
		result, err = wireRepositoryOverview(metadata, repo)
		if err != nil {
			return err
		}
		return s.readOverviewIndexes(ctx, base, credential, result)
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

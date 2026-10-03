package server

import (
	"context"
	"net/http"
	"strconv"
)

type forgeTag struct {
	Name    string `json:"name"`
	ID      string `json:"id"`
	Message string `json:"message"`
	Commit  struct {
		SHA string `json:"sha"`
	} `json:"commit"`
}

// Native inventory endpoints clamp page size. Tags emit a total but no Link.
// Discover the actual first-page span and slice caller pages without treating
// loaded rows as the total or silently skipping rows under the native clamp.
func inventoryPage[T any](paging pageRequest, read func(uint32) ([]T, int64, error)) ([]T, uint32, int64, error) {
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, 0, err
	}
	first, total, err := read(1)
	if err != nil {
		return nil, 0, 0, err
	}
	span := int64(len(first))
	if total < 0 || span > 100 || span > total || (total > 0 && span == 0) || (total == 0 && span != 0) {
		return nil, 0, 0, errInvalidForgeResponse
	}
	result := []T{}
	start := int64(page-1) * int64(limit)
	end := min(start+int64(limit), total)
	for offset := start; offset < end; {
		nativePage := uint32(offset/span + 1)
		rows := first
		if nativePage != 1 {
			var count int64
			rows, count, err = read(nativePage)
			if err != nil {
				return nil, 0, 0, err
			}
			if count != total || int64(len(rows)) != min(span, total-int64(nativePage-1)*span) {
				return nil, 0, 0, errInvalidForgeResponse
			}
		}
		local := offset % span
		take := min(int64(len(rows))-local, end-offset)
		result = append(result, rows[local:local+take]...)
		offset += take
	}
	var next uint32
	if end < total {
		if page == 10000 {
			return nil, 0, 0, invalid("Repository inventory exceeds the 10000-page limit. Increase the page size before continuing.")
		}
		next = page + 1
	}
	return result, next, total, nil
}

func inventoryTotal(headers http.Header) (int64, error) {
	value := headers.Get("X-Total-Count")
	total, err := strconv.ParseInt(value, 10, 64)
	if err != nil || total < 0 || strconv.FormatInt(total, 10) != value || len(headers.Values("X-Total-Count")) != 1 {
		return 0, errInvalidForgeResponse
	}
	return total, nil
}

func (s *Server) listTags(ctx context.Context, session string, token forgeCredential, key repositoryKey, id int64, paging pageRequest) ([]forgeTag, uint32, int64, error) {
	if _, _, err := pagination(paging); err != nil {
		return nil, 0, 0, err
	}
	var rows []forgeTag
	var next uint32
	var total int64
	err := s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		if repo.ID != id {
			return errIssueTargetChanged
		}
		var err error
		rows, next, total, err = inventoryPage(paging, func(page uint32) ([]forgeTag, int64, error) {
			items := []forgeTag{}
			headers, err := s.forge(ctx, http.MethodGet, base+"/tags?"+pageQuery(page, 100).Encode(), token, nil, &items)
			if err != nil {
				return nil, 0, err
			}
			count, err := inventoryTotal(headers)
			if err != nil {
				return nil, 0, err
			}
			seen := map[string]bool{}
			for _, item := range items {
				if item.Name == "" || !validRef(item.Name) || seen[item.Name] || !objectID.MatchString(item.ID) || !objectID.MatchString(item.Commit.SHA) || len(item.ID) != len(item.Commit.SHA) || !discussionText(item.Message, 256<<10) {
					return nil, 0, errInvalidForgeResponse
				}
				seen[item.Name] = true
			}
			return items, count, nil
		})
		return err
	})
	if err == nil {
		seen := map[string]bool{}
		for _, row := range rows {
			if seen[row.Name] {
				return nil, 0, 0, errInvalidForgeResponse
			}
			seen[row.Name] = true
		}
	}
	return rows, next, total, err
}

func (s *Server) listBoundBranches(ctx context.Context, session string, token forgeCredential, key repositoryKey, id int64, paging pageRequest) ([]branch, uint32, int64, error) {
	if _, _, err := pagination(paging); err != nil {
		return nil, 0, 0, err
	}
	var rows []branch
	var next uint32
	var total int64
	err := s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		if repo.ID != id {
			return errIssueTargetChanged
		}
		// Empty metadata is not a verified inventory count. Preserve the native
		// first-push race guard; the RPC leaves total absent in this case.
		if repo.Empty {
			total = -1
			return nil
		}
		var err error
		rows, next, total, err = inventoryPage(paging, func(page uint32) ([]branch, int64, error) {
			var items []struct {
				Name      string `json:"name"`
				Protected bool   `json:"protected"`
				Commit    struct {
					ID string `json:"id"`
				} `json:"commit"`
			}
			headers, err := s.forge(ctx, http.MethodGet, base+"/branches?"+pageQuery(page, 100).Encode(), token, nil, &items)
			if err != nil {
				return nil, 0, err
			}
			count, err := inventoryTotal(headers)
			if err != nil {
				return nil, 0, err
			}
			result := []branch{}
			seen := map[string]bool{}
			for _, item := range items {
				if item.Name == "" || !validRef(item.Name) || seen[item.Name] || !objectID.MatchString(item.Commit.ID) {
					return nil, 0, errInvalidForgeResponse
				}
				seen[item.Name] = true
				result = append(result, branch{item.Name, item.Commit.ID, item.Protected})
			}
			return result, count, nil
		})
		return err
	})
	if err == nil {
		seen := map[string]bool{}
		for _, row := range rows {
			if seen[row.Name] {
				return nil, 0, 0, errInvalidForgeResponse
			}
			seen[row.Name] = true
		}
	}
	return rows, next, total, err
}

func (s *Server) listBoundCommits(ctx context.Context, session string, token forgeCredential, key repositoryKey, id int64, ref string, paging pageRequest) ([]forgeCommit, uint32, error) {
	if !objectID.MatchString(ref) {
		return nil, 0, invalid("Exact repository history requires a full lowercase commit ID.")
	}
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	var rows []forgeCommit
	var next uint32
	err = s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		if repo.ID != id {
			return errIssueTargetChanged
		}
		// Independently bind the anchor even for later history pages.
		first, firstHeaders, err := s.readCommits(ctx, base, token, ref, 1, 1)
		if err != nil {
			return err
		}
		if len(first) != 1 || first[0].SHA != ref {
			return errInvalidForgeResponse
		}
		var headers http.Header
		if page == 1 && limit == 1 {
			rows, headers = first, firstHeaders
		} else {
			rows, headers, err = s.readCommits(ctx, base, token, ref, page, limit)
		}
		if err != nil {
			return err
		}
		if page == 1 && (len(rows) == 0 || rows[0].SHA != ref) {
			return errInvalidForgeResponse
		}
		seen := map[string]bool{}
		for _, row := range rows {
			if len(row.SHA) != len(ref) || seen[row.SHA] || !validHistoryCommit(row) {
				return errInvalidForgeResponse
			}
			seen[row.SHA] = true
		}
		next = nextPage(headers, page)
		return nil
	})
	return rows, next, err
}

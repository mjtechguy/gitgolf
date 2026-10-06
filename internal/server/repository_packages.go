package server

import (
	"context"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

type nativePackage struct {
	ID         int64       `json:"id"`
	Name       string      `json:"name"`
	Type       string      `json:"type"`
	Version    string      `json:"version"`
	Created    string      `json:"created_at"`
	Owner      *User       `json:"owner"`
	Creator    *User       `json:"creator"`
	Repository *Repository `json:"repository"`
}

func packageSegment(v string) bool {
	return v != "" && v != "." && v != ".." && strings.TrimSpace(v) == v && profileText(v, 1024, false) && !strings.ContainsAny(v, "\\")
}
func packageType(v string) bool {
	return strings.Contains("|alpine|cargo|chef|composer|conan|conda|container|cran|debian|generic|go|helm|maven|npm|nuget|pub|pypi|rpm|rubygems|swift|terraform|vagrant|", "|"+v+"|") && v != "" && !strings.Contains(v, "|")
}
func packageWire(row nativePackage, repo Repository) (*golfv1.ForgePackage, error) {
	if row.ID < 1 || !packageSegment(row.Name) || !packageType(row.Type) || !packageSegment(row.Version) || !validPullTime(row.Created) || row.Owner == nil || !validPullUser(row.Owner) || row.Repository == nil || !validRepository(*row.Repository) || row.Repository.ID != repo.ID || !strings.EqualFold(row.Repository.FullName, repo.FullName) || !strings.EqualFold(row.Owner.Login, strings.Split(repo.FullName, "/")[0]) || row.Creator == nil || !validPullUser(row.Creator) {
		return nil, errInvalidForgeResponse
	}
	return &golfv1.ForgePackage{Id: strconv.FormatInt(row.ID, 10), Name: row.Name, Type: row.Type, Version: row.Version, CreatedAt: row.Created, CreatorLogin: row.Creator.Login}, nil
}
func (s *Server) withPackageRead(ctx context.Context, session string, token forgeCredential, key repositoryKey, id string, fn func(string, Repository) error) error {
	if _, e := discussionID(id); e != nil {
		return e
	}
	return s.withRepositoryRead(ctx, session, token, key, func(_ string, repo Repository) error {
		if strconv.FormatInt(repo.ID, 10) != id {
			return errResourceNotFound
		}
		var config struct {
			ID          int64 `json:"id"`
			HasPackages *bool `json:"has_packages"`
		}
		base, _ := repositoryPath(key)
		if _, e := s.forge(ctx, http.MethodGet, base, token, nil, &config); e != nil {
			return e
		}
		if config.ID != repo.ID || config.HasPackages == nil || !*config.HasPackages {
			return forgeError{http.StatusNotFound}
		}
		if e := fn("/packages/"+url.PathEscape(key.Owner), repo); e != nil {
			return e
		}
		var after struct {
			ID          int64 `json:"id"`
			HasPackages *bool `json:"has_packages"`
		}
		if _, e := s.forge(ctx, http.MethodGet, base, token, nil, &after); e != nil {
			return e
		}
		if after.ID != repo.ID || after.HasPackages == nil || !*after.HasPackages {
			return forgeError{http.StatusNotFound}
		}
		return nil
	})
}
func (s *Server) ListRepositoryPackages(ctx context.Context, req *connect.Request[golfv1.ListRepositoryPackagesRequest]) (*connect.Response[golfv1.ListRepositoryPackagesResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	m := req.Msg
	page, limit, e := pagination(pageFrom(m.Page))
	if e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.ListRepositoryPackagesResponse{RepositoryId: m.RepositoryId, Page: &golfv1.PageResponse{}}
	e = s.withPackageRead(ctx, s.cookieValue(req.Header()), token, keyFrom(m.Repository), m.RepositoryId, func(base string, repo Repository) error {
		return s.withNativePageSize(ctx, token, limit, func(span uint32) error {
			path := base + "?" + pageQuery(page, span).Encode()
			var rows []nativePackage
			headers, e := s.forge(ctx, http.MethodGet, path, token, nil, &rows)
			if e != nil {
				return e
			}
			if rows == nil || len(rows) > int(span) {
				return errInvalidForgeResponse
			}
			seen := map[int64]bool{}
			for _, row := range rows {
				if row.ID < 1 || seen[row.ID] {
					return errInvalidForgeResponse
				}
				seen[row.ID] = true
				if row.Repository == nil || row.Repository.ID != repo.ID {
					continue
				}
				wire, e := packageWire(row, repo)
				if e != nil {
					return e
				}
				result.Packages = append(result.Packages, wire)
			}
			result.Page.NextPage = nextPage(headers, page)
			var after []nativePackage
			_, e = s.forge(ctx, http.MethodGet, path, token, nil, &after)
			if e != nil {
				return e
			}
			if !reflect.DeepEqual(rows, after) {
				return errPullSnapshotChanged
			}
			return nil
		})
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) GetRepositoryPackageFiles(ctx context.Context, req *connect.Request[golfv1.GetRepositoryPackageFilesRequest]) (*connect.Response[golfv1.GetRepositoryPackageFilesResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	m := req.Msg
	p := m.Package
	if p == nil || !packageSegment(p.Name) || !packageType(p.Type) || !packageSegment(p.Version) {
		return nil, rpcError(invalid("Select an exact package version."))
	}
	if _, e = discussionID(p.Id); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.GetRepositoryPackageFilesResponse{RepositoryId: m.RepositoryId, PackageId: p.Id}
	e = s.withPackageRead(ctx, s.cookieValue(req.Header()), token, keyFrom(m.Repository), m.RepositoryId, func(base string, repo Repository) error {
		path := base + "/" + p.Type + "/" + url.PathEscape(p.Name) + "/" + url.PathEscape(p.Version)
		var before nativePackage
		if _, e := s.forge(ctx, http.MethodGet, path, token, nil, &before); e != nil {
			return e
		}
		wire, e := packageWire(before, repo)
		if e != nil {
			return e
		}
		if wire.Id != p.Id || wire.Name != p.Name || wire.Type != p.Type || wire.Version != p.Version {
			return errResourceNotFound
		}
		type file struct {
			ID     int64  `json:"id"`
			Name   string `json:"name"`
			Size   *int64 `json:"size"`
			SHA256 string `json:"sha256"`
		}
		var files []file
		if _, e = s.forge(ctx, http.MethodGet, path+"/files", token, nil, &files); e != nil {
			return e
		}
		if files == nil || len(files) > 1000 {
			return errInvalidForgeResponse
		}
		seen := map[int64]bool{}
		for _, f := range files {
			if f.ID < 1 || seen[f.ID] || !packageSegment(f.Name) || f.Size == nil || *f.Size < 0 || !validAccessRevision(f.SHA256) {
				return errInvalidForgeResponse
			}
			seen[f.ID] = true
			result.Files = append(result.Files, &golfv1.ForgePackageFile{Id: strconv.FormatInt(f.ID, 10), Name: f.Name, SizeBytes: strconv.FormatInt(*f.Size, 10), Sha256: f.SHA256})
		}
		var after nativePackage
		if _, e = s.forge(ctx, http.MethodGet, path, token, nil, &after); e != nil {
			return e
		}
		if !reflect.DeepEqual(before, after) {
			return errPullSnapshotChanged
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(result), nil
}

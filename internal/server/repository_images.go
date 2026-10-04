package server

import (
	"bytes"
	"context"
	"encoding/xml"
	"html"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Images are bounded private RPC responses. Never forward forge credentials to
// external hosts, follow redirects, or expose an authenticated generic proxy.
func repositoryImagePath(document, reference string) (string, error) {
	u, e := url.Parse(reference)
	if e != nil || u.IsAbs() || u.Host != "" || strings.ContainsAny(reference, "\\\x00\r\n") {
		return "", invalid("Use a repository image path.")
	}
	candidate := path.Join(path.Dir(document), u.Path)
	if strings.HasPrefix(u.Path, "/") {
		candidate = strings.TrimPrefix(path.Clean(u.Path), "/")
	}
	if candidate == "" || !validSourcePath(candidate) {
		return "", invalid("Image path leaves this repository.")
	}
	return candidate, nil
}
func externalImageURL(reference string) (*url.URL, error) {
	u, e := url.Parse(reference)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" || len(reference) > 2048 {
		return nil, invalid("Unsupported external image URL.")
	}
	switch u.Host {
	case "raw.githubusercontent.com", "img.shields.io", "avatars.githubusercontent.com", "user-images.githubusercontent.com", "github.githubassets.com", "badgen.net", "expressjs.com", "sindresorhus.com", "api.securityscorecards.dev":
	default:
		return nil, invalid("This image host is not supported.")
	}
	return u, nil
}
func publicImageIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return false
	}
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32"} {
		_, network, _ := net.ParseCIDR(cidr)
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

func fetchRepositoryImage(ctx context.Context, reference string) ([]byte, error) {
	u, e := externalImageURL(reference)
	if e != nil {
		return nil, e
	}
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(address)
		if e != nil || host != u.Hostname() || port != "443" {
			return nil, invalid("Unsupported image destination.")
		}
		addresses, e := net.DefaultResolver.LookupIPAddr(ctx, host)
		if e != nil || len(addresses) == 0 {
			return nil, errForgeUnavailable
		}
		for _, a := range addresses {
			if !publicImageIP(a.IP) {
				return nil, invalid("Image destination is not public.")
			}
		}
		return (&net.Dialer{Timeout: 4 * time.Second}).DialContext(ctx, network, net.JoinHostPort(addresses[0].IP.String(), port))
	}}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: 6 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Accept", "image/png,image/jpeg,image/gif,image/svg+xml")
	response, e := client.Do(req)
	if e != nil {
		return nil, errForgeUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errResourceNotFound
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, maxPreviewBytes+1))
	if e != nil {
		return nil, errForgeUnavailable
	}
	if len(data) > maxPreviewBytes {
		return nil, errForgeResponseTooLarge
	}
	return data, nil
}
func repositoryImageType(data []byte) (string, error) {
	if len(data) == 0 || len(data) > maxPreviewBytes {
		return "", errForgeResponseTooLarge
	}
	config, format, e := image.DecodeConfig(bytes.NewReader(data))
	if e == nil {
		if config.Width <= 0 || config.Height <= 0 || config.Width > 16384 || config.Height > 16384 || int64(config.Width)*int64(config.Height) > 32_000_000 {
			return "", invalid("Image dimensions exceed preview limits.")
		}
		switch format {
		case "png":
			return "image/png", nil
		case "jpeg":
			return "image/jpeg", nil
		case "gif":
			return "image/gif", nil
		}
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	for {
		token, e := decoder.Token()
		if e != nil {
			return "", invalid("Unsupported image content.")
		}
		if start, ok := token.(xml.StartElement); ok {
			if start.Name.Local == "svg" && start.Name.Space == "http://www.w3.org/2000/svg" {
				return "image/svg+xml", nil
			}
			return "", invalid("Unsupported image content.")
		}
	}
}
func (s *Server) GetRepositoryImage(ctx context.Context, req *connect.Request[golfv1.GetRepositoryImageRequest]) (*connect.Response[golfv1.GetRepositoryImageResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	input := req.Msg
	var id int64
	if input.RepositoryId != "" {
		id, e = discussionID(input.RepositoryId)
		if e != nil {
			return nil, rpcError(e)
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if !objectID.MatchString(input.CommitId) || input.DocumentPath == "" || !validSourcePath(input.DocumentPath) || len(input.ImageUrl) > 2048 || strings.ContainsAny(input.ImageUrl, "\x00\r\n") {
		return nil, rpcError(invalid("Select an immutable document and image reference."))
	}
	var data []byte
	e = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, keyFrom(input.Repository), func(base string, repo Repository) error {
		if id > 0 && repo.ID != id {
			return errIssueTargetChanged
		}
		id = repo.ID
		document, e := s.getBoundContents(ctx, s.cookieValue(req.Header()), token, keyFrom(input.Repository), id, input.CommitId, input.DocumentPath, false)
		if e != nil {
			return e
		}
		if document.RepositoryID != id || document.CommitID != input.CommitId || document.File == nil || document.File.Content == nil || !strings.Contains(html.UnescapeString(*document.File.Content), input.ImageUrl) {
			return invalid("Image is not referenced by this source document.")
		}
		if strings.HasPrefix(input.ImageUrl, "https://") {
			data, e = fetchRepositoryImage(ctx, input.ImageUrl)
			return e
		}
		sourcePath, e := repositoryImagePath(input.DocumentPath, input.ImageUrl)
		if e != nil {
			return e
		}
		file, entries, e := s.sourceObjectAtPath(ctx, base, token, input.CommitId, sourcePath)
		if e != nil {
			return e
		}
		if entries != nil || file.Type != "file" || file.Size > maxPreviewBytes {
			return invalid("Image is not an ordinary bounded repository file.")
		}
		data, e = s.sourceBlob(ctx, base, token, file)
		if e != nil {
			return e
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	media, e := repositoryImageType(data)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryImageResponse{Content: data, MediaType: media, RepositoryId: strconv.FormatInt(id, 10), CommitId: input.CommitId, DocumentPath: input.DocumentPath, ImageUrl: input.ImageUrl}), nil
}

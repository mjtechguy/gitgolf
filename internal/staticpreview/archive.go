// Package staticpreview validates the bounded ordinary artifact format without
// extracting files. HTTP authorization, receipt comparison and CSP are consumers'
// responsibilities. This static-only profile deliberately rejects gzip, hidden
// paths, unknown MIME extensions and non-path extended tar headers.
package staticpreview

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"path"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	MaxArchiveBytes = 10 << 20
	MaxFiles        = 128
	MaxFileBytes    = 8 << 20
)

var ErrArchive = errors.New("artifact is outside the bounded static archive profile")
var ErrFile = errors.New("static archive file is unavailable")

type Root struct{ Path, EntryPath string }
type File struct {
	Bytes               []byte
	ContentType, SHA256 string
}
type SiteArchive struct {
	ArchiveSHA256, ManifestSHA256 string
	FileCount                     int
	FileBytes                     int64
	files                         map[string]File
	roots                         []Root
}

type manifestFile struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
}

// Parse validates the entire archive before returning any files. The caller
// must compare the returned archive hash/count/bytes against its immutable
// artifact receipt. No path or content values are included in errors.
func Parse(data []byte) (*SiteArchive, error) {
	if len(data) == 0 || len(data) > MaxArchiveBytes {
		return nil, ErrArchive
	}
	input := bytes.NewReader(data)
	reader := tar.NewReader(input)
	site := &SiteArchive{ArchiveSHA256: digest(data), files: make(map[string]File)}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil || len(site.files) >= MaxFiles || header.Typeflag != tar.TypeReg || header.Linkname != "" || len(header.Xattrs) != 0 || header.Format == tar.FormatGNU || !validPath(header.Name) || header.Size < 0 || header.Size > MaxFileBytes {
			return nil, ErrArchive
		}
		for key, value := range header.PAXRecords {
			if key != "path" || value != header.Name {
				return nil, ErrArchive
			}
		}
		if _, exists := site.files[header.Name]; exists {
			return nil, ErrArchive
		}
		for existing := range site.files {
			if strings.HasPrefix(existing, header.Name+"/") || strings.HasPrefix(header.Name, existing+"/") {
				return nil, ErrArchive
			}
		}
		site.FileBytes += header.Size
		if site.FileBytes > MaxFileBytes {
			return nil, ErrArchive
		}
		contentType := fileMIME(header.Name)
		if contentType == "" {
			return nil, ErrArchive
		}
		body, err := io.ReadAll(io.LimitReader(reader, header.Size+1))
		if err != nil || int64(len(body)) != header.Size || (strings.HasPrefix(contentType, "text/") || contentType == "application/json") && !utf8.Valid(body) {
			return nil, ErrArchive
		}
		site.files[header.Name] = File{Bytes: body, ContentType: contentType, SHA256: digest(body)}
	}
	// The producer emits exactly the two terminating zero blocks. Refuse trailing
	// archives, garbage and extra members rather than adopting a partial inventory.
	if input.Len() != 0 || len(data) < 1024 || !bytes.Equal(data[len(data)-1024:], make([]byte, 1024)) || len(site.files) == 0 {
		return nil, ErrArchive
	}
	names := make([]string, 0, len(site.files))
	for name := range site.files {
		names = append(names, name)
	}
	sort.Strings(names)
	manifest := make([]manifestFile, 0, len(names))
	for _, name := range names {
		file := site.files[name]
		manifest = append(manifest, manifestFile{Name: name, Size: int64(len(file.Bytes)), SHA256: file.SHA256, ContentType: file.ContentType})
		if path.Base(name) == "index.html" {
			site.roots = append(site.roots, Root{Path: path.Dir(name), EntryPath: name})
		}
	}
	if len(site.roots) == 0 {
		return nil, ErrArchive
	}
	sort.Slice(site.roots, func(i, j int) bool { return site.roots[i].Path < site.roots[j].Path })
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return nil, ErrArchive
	}
	site.ManifestSHA256 = digest(encoded)
	site.FileCount = len(site.files)
	return site, nil
}

func (s *SiteArchive) Roots() []Root {
	if s == nil {
		return nil
	}
	return append([]Root(nil), s.roots...)
}

// File uses an explicit accepted root and literal relative filename. It performs
// no URL decoding, directory indexing, SPA fallback or guessed root selection.
// Returned bytes are owned by the caller and cannot mutate subsequent reads.
func (s *SiteArchive) File(root, relativePath string) (File, error) {
	if s == nil || !validPath(relativePath) {
		return File{}, ErrFile
	}
	found := false
	for _, candidate := range s.roots {
		if candidate.Path == root {
			found = true
			break
		}
	}
	if !found {
		return File{}, ErrFile
	}
	name := relativePath
	if root != "." {
		name = root + "/" + relativePath
	}
	file, ok := s.files[name]
	if !ok {
		return File{}, ErrFile
	}
	file.Bytes = bytes.Clone(file.Bytes)
	return file, nil
}

func validPath(name string) bool {
	if name == "" || len(name) > 1024 || !utf8.ValidString(name) || path.IsAbs(name) || path.Clean(name) != name || strings.ContainsAny(name, "\\:%?#") || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return false
	}
	for _, segment := range strings.Split(name, "/") {
		if segment == "" || strings.HasPrefix(segment, ".") || strings.HasPrefix(segment, "__golf") {
			return false
		}
	}
	return true
}

func fileMIME(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".txt":
		return "text/plain; charset=utf-8"
	case ".json":
		return "application/json"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".avif":
		return "image/avif"
	case ".ico":
		return "image/x-icon"
	case ".woff":
		return "font/woff"
	case ".woff2":
		return "font/woff2"
	case ".ttf":
		return "font/ttf"
	case ".otf":
		return "font/otf"
	default:
		return ""
	}
}

func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

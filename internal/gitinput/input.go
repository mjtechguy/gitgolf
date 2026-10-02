// Package gitinput validates Git selections shared by API and local clients.
package gitinput

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

func ValidRef(ref string) bool {
	if ref == "" {
		return true
	}
	if len(ref) > 1024 || !utf8.ValidString(ref) || ref == "@" || strings.HasPrefix(ref, "-") || strings.ContainsAny(ref, " ~^:?*[\\") || strings.Contains(ref, "..") || strings.Contains(ref, "@{") {
		return false
	}
	for _, part := range strings.Split(ref, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".") || strings.HasSuffix(part, ".lock") {
			return false
		}
	}
	return strings.IndexFunc(ref, unicode.IsControl) == -1
}
func ValidSourcePath(value string) bool {
	if len(value) > 4096 || !utf8.ValidString(value) || strings.Contains(value, "\\") || strings.IndexFunc(value, unicode.IsControl) != -1 {
		return false
	}
	if value == "" {
		return true
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

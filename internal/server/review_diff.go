package server

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// This parser is write authority, unlike the readable raw-diff fallback. It
// accepts only complete, unambiguous ordinary Git patches within reader bounds.
type reviewComparison struct {
	files []reviewDiffFile
}
type reviewDiffFile struct {
	oldPath, newPath                    string
	oldMissing, newMissing, unsupported bool
	hunks                               []reviewDiffHunk
}
type reviewDiffHunk struct {
	header                                 string
	oldStart, oldCount, newStart, newCount int
	rows                                   []reviewDiffRow
	unsupported                            bool
	nativeJSONBytes                        int
}
type reviewDiffRow struct {
	kind             byte
	text             string
	oldLine, newLine int
}

var strictReviewHunk = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$`)
var strictReviewIndex = regexp.MustCompile(`^index [0-9a-f]{4,64}\.\.[0-9a-f]{4,64}(?: (100644|100755|120000|160000))?$`)

const reviewNativeContextLimit = 64 * 1024

// Native cuts can replace the original header with four decimal ranges. The
// largest coordinates/counts admitted here fit this header width. Reserve it
// even when the original shorthand header is shorter; never assume the
// operator's configured context-window size will make a larger hunk safe.
const reviewNativeCutHeaderBytes = len("@@ -2147483647,12000 +2147483647,12000 @@")

func parseReviewRange(header string) (reviewDiffHunk, error) {
	m := strictReviewHunk.FindStringSubmatch(header)
	if m == nil {
		return reviewDiffHunk{}, errInvalidForgeResponse
	}
	n := [4]int{}
	for i := range n {
		v := m[i+1]
		if v == "" {
			v = "1"
		}
		u, e := strconv.ParseUint(v, 10, 31)
		if e != nil {
			return reviewDiffHunk{}, errInvalidForgeResponse
		}
		n[i] = int(u)
	}
	for i := 0; i < 4; i += 2 {
		if n[i+1] > 0 && (n[i] == 0 || uint64(n[i])+uint64(n[i+1])-1 > 2147483647) {
			return reviewDiffHunk{}, errInvalidForgeResponse
		}
	}
	if n[1] == 0 && n[3] == 0 {
		return reviewDiffHunk{}, errInvalidForgeResponse
	}
	return reviewDiffHunk{header: header, oldStart: n[0], oldCount: n[1], newStart: n[2], newCount: n[3]}, nil
}

// strconv supplies strict C byte decoding, but Git does not emit Go's hex or
// Unicode escapes. Reject those instead of widening the literal-path grammar.
func reviewGitPath(s string) (string, error) {
	if strings.HasPrefix(s, `"`) {
		for i := 1; i < len(s)-1; i++ {
			if s[i] != '\\' {
				continue
			}
			i++
			if i >= len(s)-1 {
				return "", errInvalidForgeResponse
			}
			if s[i] >= '0' && s[i] <= '7' {
				if i+2 >= len(s)-1 || s[i+1] < '0' || s[i+1] > '7' || s[i+2] < '0' || s[i+2] > '7' {
					return "", errInvalidForgeResponse
				}
				i += 2
			} else if !strings.ContainsRune(`abtnvfr\"`, rune(s[i])) {
				return "", errInvalidForgeResponse
			}
		}
		v, e := strconv.Unquote(s)
		if e != nil || !utf8.ValidString(v) {
			return "", errInvalidForgeResponse
		}
		s = v
	} else if strings.ContainsRune(s, '"') {
		return "", errInvalidForgeResponse
	}
	if s == "" || !validSourcePath(s) {
		return "", errInvalidForgeResponse
	}
	return s, nil
}

func reviewDiffPaths(header string) (string, string, error) {
	if !strings.HasPrefix(header, "diff --git ") {
		return "", "", errInvalidForgeResponse
	}
	s := strings.TrimPrefix(header, "diff --git ")
	cut := -1
	if strings.HasPrefix(s, `"`) {
		for i := 1; i < len(s); i++ {
			if s[i] == '\\' {
				i++
				continue
			}
			if s[i] == '"' {
				cut = i + 1
				break
			}
		}
		if cut < 0 || cut >= len(s) || s[cut] != ' ' {
			return "", "", errInvalidForgeResponse
		}
	} else {
		// Unquoted names may contain spaces. Multiple possible separators are
		// ambiguous, even if a later file header happens to choose one.
		for i := 0; i < len(s); i++ {
			if s[i] == ' ' && (strings.HasPrefix(s[i+1:], "b/") || strings.HasPrefix(s[i+1:], `"b/`)) {
				if cut >= 0 {
					return "", "", errInvalidForgeResponse
				}
				cut = i
			}
		}
	}
	if cut < 0 {
		return "", "", errInvalidForgeResponse
	}
	a, e := reviewGitPath(s[:cut])
	if e != nil {
		return "", "", e
	}
	b, e := reviewGitPath(s[cut+1:])
	if e != nil {
		return "", "", e
	}
	if !strings.HasPrefix(a, "a/") || !strings.HasPrefix(b, "b/") {
		return "", "", errInvalidForgeResponse
	}
	a, b = a[2:], b[2:]
	if a == "" || b == "" || !validSourcePath(a) || !validSourcePath(b) {
		return "", "", errInvalidForgeResponse
	}
	return a, b, nil
}

func reviewSidePath(s, prefix string) (string, bool, error) {
	if s == "/dev/null" {
		return "", true, nil
	}
	// Native Git terminates an unquoted whitespace-containing side path with
	// an empty TAB delimiter. Admit exactly that delimiter, never timestamps,
	// additional delimiters or literal path controls.
	if tab := strings.IndexByte(s, '\t'); tab >= 0 {
		if tab != len(s)-1 {
			return "", false, errInvalidForgeResponse
		}
		s = s[:tab]
	}
	p, e := reviewGitPath(s)
	if e != nil || !strings.HasPrefix(p, prefix) {
		return "", false, errInvalidForgeResponse
	}
	p = strings.TrimPrefix(p, prefix)
	if p == "" || !validSourcePath(p) {
		return "", false, errInvalidForgeResponse
	}
	return p, false, nil
}

func reviewHunkRows(h *reviewDiffHunk, body []string, incomplete bool) error {
	if len(body) > 12000 || h.oldCount > 12000 || h.newCount > 12000 {
		return errInvalidForgeResponse
	}
	oldLeft, newLeft := h.oldCount, h.newCount
	oldLine, newLine := h.oldStart, h.newStart
	oldEnded, newEnded := false, false
	for _, line := range body {
		if line == `\ No newline at end of file` {
			if len(h.rows) == 0 || h.rows[len(h.rows)-1].kind == '\\' {
				return errInvalidForgeResponse
			}
			h.rows = append(h.rows, reviewDiffRow{kind: '\\', text: line})
			previous := h.rows[len(h.rows)-2].kind
			oldEnded = oldEnded || previous == '-' || previous == ' '
			newEnded = newEnded || previous == '+' || previous == ' '
			continue
		}
		if line == "" {
			return errInvalidForgeResponse
		}
		r := reviewDiffRow{kind: line[0], text: line[1:]}
		switch r.kind {
		case ' ':
			if oldLeft == 0 || newLeft == 0 || oldEnded || newEnded {
				return errInvalidForgeResponse
			}
			r.oldLine, r.newLine = oldLine, newLine
			oldLine++
			newLine++
			oldLeft--
			newLeft--
		case '-':
			if oldLeft == 0 || oldEnded {
				return errInvalidForgeResponse
			}
			r.oldLine = oldLine
			oldLine++
			oldLeft--
		case '+':
			if newLeft == 0 || newEnded {
				return errInvalidForgeResponse
			}
			r.newLine = newLine
			newLine++
			newLeft--
		default:
			return errInvalidForgeResponse
		}
		h.rows = append(h.rows, r)
	}
	if len(h.rows) == 0 || (!incomplete && (oldLeft != 0 || newLeft != 0)) {
		return errInvalidForgeResponse
	}
	return nil
}

func parseReviewComparison(diff string) (reviewComparison, error) {
	var c reviewComparison
	if len(diff) > 512*1024 || !utf8.ValidString(diff) || strings.ContainsRune(diff, '\x00') {
		return c, errInvalidForgeResponse
	}
	if diff == "" {
		return c, nil
	}
	lines := strings.Split(strings.TrimSuffix(diff, "\n"), "\n")
	seen, seenOld := map[string]bool{}, map[string]bool{}
	totalRows := 0
	for i := 0; i < len(lines); {
		oldPath, newPath, e := reviewDiffPaths(lines[i])
		if e != nil {
			return reviewComparison{}, e
		}
		if len(c.files) >= 500 || seen[newPath] || seenOld[oldPath] {
			return reviewComparison{}, errInvalidForgeResponse
		}
		seen[newPath] = true
		seenOld[oldPath] = true
		f := reviewDiffFile{oldPath: oldPath, newPath: newPath}
		fileStart := i
		i++
		oldHeader, newHeader := false, false
		metadata := map[string]bool{}
		for i < len(lines) && !strings.HasPrefix(lines[i], "diff --git ") {
			line := lines[i]
			if strings.HasPrefix(line, "@@") {
				if !oldHeader || !newHeader {
					return reviewComparison{}, errInvalidForgeResponse
				}
				h, e := parseReviewRange(line)
				if e != nil {
					return reviewComparison{}, e
				}
				i++
				start := i
				for i < len(lines) && !strings.HasPrefix(lines[i], "@@") && !strings.HasPrefix(lines[i], "diff --git ") {
					i++
				}
				if totalRows+i-start > 12000 {
					return reviewComparison{}, errInvalidForgeResponse
				}
				if e = reviewHunkRows(&h, lines[start:i], false); e != nil {
					return reviewComparison{}, e
				}
				contextBytes := max(len(h.header), reviewNativeCutHeaderBytes) + 1 // Possible final LF.
				if strings.IndexFunc(h.header, func(r rune) bool { return unicode.IsControl(r) && r != '\t' }) >= 0 {
					h.unsupported = true
				}
				for _, bodyLine := range lines[start:i] {
					contextBytes += 1 + len(bodyLine)
					// ScanLines removes trailing CR; other controls also cannot
					// pass the retained receipt's safe-text contract. Keep their
					// exact rows but do not dispatch a knowingly unverifiable cut.
					if strings.IndexFunc(bodyLine, func(r rune) bool { return unicode.IsControl(r) && r != '\t' }) >= 0 {
						h.unsupported = true
					}
				}
				if contextBytes > reviewNativeContextLimit {
					h.unsupported = true
				}
				if !h.unsupported {
					// Default Go JSON encoding is a conservative bound even when
					// the native encoder disables HTML escaping. Include outer
					// quotes and every exact retained row; a cut only removes rows.
					encoded, _ := json.Marshal(h.header + "\n" + strings.Join(lines[start:i], "\n"))
					header, _ := json.Marshal(h.header)
					h.nativeJSONBytes = len(encoded) + 2 + max(0, reviewNativeCutHeaderBytes+2-len(header)) // Final LF JSON escape.
				}
				totalRows += len(h.rows)
				if totalRows > 12000 {
					return reviewComparison{}, errInvalidForgeResponse
				}
				if len(f.hunks) > 0 {
					prev := f.hunks[len(f.hunks)-1]
					if h.oldStart < prev.oldStart+prev.oldCount || h.newStart < prev.newStart+prev.newCount {
						return reviewComparison{}, errInvalidForgeResponse
					}
				}
				if (f.oldMissing && h.oldCount != 0) || (f.newMissing && h.newCount != 0) {
					return reviewComparison{}, errInvalidForgeResponse
				}
				f.hunks = append(f.hunks, h)
				continue
			}
			if len(f.hunks) > 0 {
				return reviewComparison{}, errInvalidForgeResponse
			}
			i++
			switch {
			case strings.HasPrefix(line, "--- "):
				if oldHeader || newHeader {
					return reviewComparison{}, errInvalidForgeResponse
				}
				oldHeader = true
				p, missing, e := reviewSidePath(line[4:], "a/")
				if e != nil || (!missing && p != oldPath) {
					return reviewComparison{}, errInvalidForgeResponse
				}
				f.oldMissing = missing
			case strings.HasPrefix(line, "+++ "):
				if !oldHeader || newHeader {
					return reviewComparison{}, errInvalidForgeResponse
				}
				newHeader = true
				p, missing, e := reviewSidePath(line[4:], "b/")
				if e != nil || (!missing && p != newPath) || (missing && f.oldMissing) {
					return reviewComparison{}, errInvalidForgeResponse
				}
				f.newMissing = missing
			case strings.HasPrefix(line, "index "):
				m := strictReviewIndex.FindStringSubmatch(line)
				if m == nil || metadata["index"] || oldHeader {
					return reviewComparison{}, errInvalidForgeResponse
				}
				metadata["index"] = true
				if m[1] == "160000" || m[1] == "120000" {
					f.unsupported = true
				}
			case strings.HasPrefix(line, "rename from "), strings.HasPrefix(line, "rename to "):
				key, prefix, want := "rename from", "rename from ", oldPath
				if strings.HasPrefix(line, "rename to ") {
					key, prefix, want = "rename to", "rename to ", newPath
				}
				p, e := reviewGitPath(strings.TrimPrefix(line, prefix))
				if e != nil || p != want || metadata[key] || oldHeader {
					return reviewComparison{}, errInvalidForgeResponse
				}
				metadata[key] = true
			case strings.HasPrefix(line, "similarity index "), strings.HasPrefix(line, "dissimilarity index "):
				key, value, ok := strings.Cut(line, " index ")
				if !ok || metadata[key] || oldHeader || !strings.HasSuffix(value, "%") {
					return reviewComparison{}, errInvalidForgeResponse
				}
				n, e := strconv.Atoi(strings.TrimSuffix(value, "%"))
				if e != nil || n < 0 || n > 100 {
					return reviewComparison{}, errInvalidForgeResponse
				}
				metadata[key] = true
			case strings.HasPrefix(line, "old mode "), strings.HasPrefix(line, "new mode "), strings.HasPrefix(line, "new file mode "), strings.HasPrefix(line, "deleted file mode "):
				j := strings.LastIndexByte(line, ' ')
				key, mode := line[:j], line[j+1:]
				if metadata[key] || oldHeader || (mode != "100644" && mode != "100755" && mode != "120000" && mode != "160000") {
					return reviewComparison{}, errInvalidForgeResponse
				}
				metadata[key] = true
				if mode == "120000" || mode == "160000" {
					f.unsupported = true
				}
			case strings.HasPrefix(line, "Binary files ") && strings.HasSuffix(line, " differ"), line == "GIT binary patch":
				f.unsupported = true
				// Binary payload is not coordinate authority. Bound its inventory;
				// a following ordinary diff starts a separately validated file.
				for i < len(lines) && !strings.HasPrefix(lines[i], "diff --git ") {
					i++
					totalRows++
					if totalRows > 12000 {
						return reviewComparison{}, errInvalidForgeResponse
					}
				}
			default:
				return reviewComparison{}, errInvalidForgeResponse
			}
		}
		if oldHeader != newHeader || metadata["rename from"] != metadata["rename to"] || (oldPath != newPath && !metadata["rename from"]) {
			return reviewComparison{}, errInvalidForgeResponse
		}
		if metadata["old mode"] != metadata["new mode"] || (metadata["new file mode"] && metadata["deleted file mode"]) || (oldHeader && ((metadata["new file mode"] && !f.oldMissing) || (metadata["deleted file mode"] && !f.newMissing))) {
			return reviewComparison{}, errInvalidForgeResponse
		}
		// Native scans the path-limited file from its beginning, before it can
		// select a later hunk. An overlong earlier row therefore blocks every
		// coordinate in this file, including an otherwise small later hunk.
		for _, line := range lines[fileStart:i] {
			if len(line) >= reviewNativeContextLimit {
				f.unsupported = true
			}
		}
		c.files = append(c.files, f)
	}
	return c, nil
}

func (c reviewComparison) Allows(path string, line int) bool {
	if line < 1 || line > 2147483647 {
		return false
	}
	for _, f := range c.files {
		// Native path-limited retained context for renames is not qualified.
		// Keep their typed inventory, but deny before dispatch rather than
		// knowingly creating an unverifiable batch.
		if f.newPath != path || f.newMissing || f.unsupported || f.oldPath != f.newPath {
			continue
		}
		for _, h := range f.hunks {
			if h.unsupported {
				continue
			}
			for _, r := range h.rows {
				if r.newLine == line {
					return true
				}
			}
		}
	}
	return false
}

// NativeContextJSONBound includes the quotes/escapes of the complete JSON string
// for any supported cut of this selected hunk. Consumers must also bound the
// body/path/identity envelope and aggregate all children against transport size.
func (c reviewComparison) NativeContextJSONBound(path string, line int) (int, bool) {
	if !c.Allows(path, line) {
		return 0, false
	}
	for _, f := range c.files {
		if f.newPath != path {
			continue
		}
		for _, h := range f.hunks {
			if h.unsupported {
				continue
			}
			for _, r := range h.rows {
				if r.newLine == line {
					return h.nativeJSONBytes, true
				}
			}
		}
	}
	return 0, false
}

// Native may retain the original header while truncating its body. Accept that
// exact prefix, or a correctly declared contiguous cut from ONE known hunk.
// Broken native cut headers and context absent from this comparison are denied.
func (c reviewComparison) MatchesNativeContext(path string, line int, patch string) bool {
	if !c.Allows(path, line) || len(patch) == 0 || len(patch) > 64*1024 || !utf8.ValidString(patch) || strings.ContainsRune(patch, '\x00') {
		return false
	}
	lines := strings.Split(strings.TrimSuffix(patch, "\n"), "\n")
	at := -1
	for i, s := range lines {
		if strings.HasPrefix(s, "@@") {
			if at >= 0 {
				return false
			}
			at = i
		}
	}
	if at < 0 {
		return false
	}
	for _, f := range c.files {
		if f.newPath != path || f.newMissing || f.unsupported || f.oldPath != f.newPath {
			continue
		}
		if at != 0 {
			if at != 3 {
				return false
			}
			a, b, e := reviewDiffPaths(lines[0])
			if e != nil || a != f.oldPath || b != f.newPath || !strings.HasPrefix(lines[1], "--- ") || !strings.HasPrefix(lines[2], "+++ ") {
				return false
			}
			a, missing, e := reviewSidePath(lines[1][4:], "a/")
			if e != nil || missing != f.oldMissing || (!missing && a != f.oldPath) {
				return false
			}
			b, missing, e = reviewSidePath(lines[2][4:], "b/")
			if e != nil || missing != f.newMissing || (!missing && b != f.newPath) {
				return false
			}
		}
		for _, original := range f.hunks {
			if original.unsupported {
				continue
			}
			h, e := parseReviewRange(lines[at])
			if e != nil {
				continue
			}
			prefix := h.header == original.header
			if reviewHunkRows(&h, lines[at+1:], prefix) != nil {
				continue
			}
			contains := false
			for _, r := range h.rows {
				if r.newLine == line {
					contains = true
				}
			}
			if !contains {
				continue
			}
			for start := 0; start+len(h.rows) <= len(original.rows); start++ {
				if prefix && start != 0 {
					break
				}
				if h.rows[0] != original.rows[start] {
					continue
				}
				// A zero-count side has no row coordinate to compare. Bind its
				// insertion anchor to the same original-row boundary explicitly.
				oldBoundary, newBoundary := original.oldStart, original.newStart
				for _, r := range original.rows[:start] {
					if r.oldLine > 0 {
						oldBoundary++
					}
					if r.newLine > 0 {
						newBoundary++
					}
				}
				if oldBoundary > 0 {
					oldBoundary--
				}
				if newBoundary > 0 {
					newBoundary--
				}
				if !prefix && ((h.oldCount == 0 && h.oldStart != oldBoundary) || (h.newCount == 0 && h.newStart != newBoundary)) {
					continue
				}
				matches := true
				for j, r := range h.rows {
					if r != original.rows[start+j] {
						matches = false
						break
					}
				}
				if matches {
					return true
				}
			}
		}
	}
	return false
}

package server

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
)

// This opt-in test consumes supported native API evidence from the Python
// probe. Ordinary test runs create no native fixture and make no network call.
func TestReviewComparisonNativeProof(t *testing.T) {
	path := os.Getenv("GOLF_REVIEW_DIFF_NATIVE_PROOF")
	if path == "" {
		t.Skip("supported native fixture input not provided")
	}
	stat, e := os.Lstat(path)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 4*1024*1024 {
		t.Fatal("native proof input must be a bounded owner-only regular file")
	}
	f, e := os.Open(path)
	if e != nil {
		t.Fatal("native proof input unavailable")
	}
	defer f.Close()
	var proof struct {
		Cases []struct {
			Name    string `json:"name"`
			Diff    string `json:"diff"`
			Path    string `json:"path"`
			Line    int    `json:"line"`
			Hunk    string `json:"hunk"`
			Matches bool   `json:"matches"`
		} `json:"cases"`
	}
	d := json.NewDecoder(io.LimitReader(f, 4*1024*1024+1))
	d.DisallowUnknownFields()
	if d.Decode(&proof) != nil || len(proof.Cases) != 3 {
		t.Fatal("invalid native proof envelope")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		t.Fatal("trailing native proof data")
	}
	want := map[string]bool{"selected-original-context": true, "historical-selected-current-context": false, "current-context": true}
	for _, row := range proof.Cases {
		expected, known := want[row.Name]
		if !known || expected != row.Matches {
			t.Fatal("invalid native proof case identity")
		}
		delete(want, row.Name)
		c, e := parseReviewComparison(row.Diff)
		if e != nil || !c.Allows(row.Path, row.Line) {
			t.Fatalf("native proof %s: exact comparison coordinate rejected", row.Name)
		}
		if c.MatchesNativeContext(row.Path, row.Line, row.Hunk) != expected {
			t.Fatalf("native proof %s: context binding mismatch", row.Name)
		}
	}
	if len(want) != 0 {
		t.Fatal("incomplete native proof cases")
	}
}

func reviewPatch(body string) string {
	return "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n" + body
}

func TestReviewComparisonCoordinates(t *testing.T) {
	// Browser corpus: source content resembling file metadata remains a row.
	text := reviewPatch("@@ -1,2 +1,3 @@\n keep\n-old\n+++ b/forged.py\n+new\n\\ No newline at end of file\n")
	c, e := parseReviewComparison(text)
	if e != nil {
		t.Fatal(e)
	}
	want := []reviewDiffRow{{' ', "keep", 1, 1}, {'-', "old", 2, 0}, {'+', "++ b/forged.py", 0, 2}, {'+', "new", 0, 3}, {'\\', `\ No newline at end of file`, 0, 0}}
	if !reflect.DeepEqual(c.files[0].hunks[0].rows, want) {
		t.Fatalf("rows=%#v", c.files[0].hunks[0].rows)
	}
	for _, line := range []int{1, 2, 3} {
		if !c.Allows("a.py", line) {
			t.Fatalf("missing line %d", line)
		}
	}
	for _, line := range []int{-1, 0, 4, 2147483648} {
		if c.Allows("a.py", line) {
			t.Fatalf("invented line %d", line)
		}
	}
	if c.Allows("forged.py", 2) {
		t.Fatal("source content changed file identity")
	}
}

func TestReviewComparisonGitPathInventory(t *testing.T) {
	text := `diff --git "a/\344\270\226\347\225\214.txt" "b/\344\270\226\347\225\214.txt"
new file mode 100644
--- /dev/null
+++ "b/\344\270\226\347\225\214.txt"
@@ -0,0 +1 @@
+hello
diff --git a/old name b/new name
similarity index 100%
rename from old name
rename to new name
diff --git a/gone b/gone
--- a/gone
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/logo b/logo
Binary files a/logo and b/logo differ
diff --git a/run b/run
old mode 100644
new mode 100755
`
	c, e := parseReviewComparison(text)
	if e != nil {
		t.Fatal(e)
	}
	if len(c.files) != 5 || c.files[0].newPath != "世界.txt" || !c.files[0].oldMissing || c.files[1].oldPath != "old name" || c.files[1].newPath != "new name" || !c.files[2].newMissing || !c.files[3].unsupported {
		t.Fatalf("inventory=%#v", c.files)
	}
	if !c.Allows("世界.txt", 1) {
		t.Fatal("quoted UTF-8 new file denied")
	}
	for _, path := range []string{"gone", "logo", "run", "old name", "new name"} {
		if c.Allows(path, 1) {
			t.Fatalf("metadata/deletion coordinate %s authorized", path)
		}
	}
	// A changed rename retains separate literal old/new identities and coordinates.
	rename := "diff --git a/old name b/new name\nrename from old name\nrename to new name\n--- a/old name\n+++ b/new name\n@@ -7 +9 @@\n-before\n+after\n"
	r, e := parseReviewComparison(rename)
	if e != nil || r.Allows("new name", 9) || r.Allows("old name", 9) || r.files[0].hunks[0].rows[1].newLine != 9 {
		t.Fatalf("rename: %v %#v", e, r)
	}
}

func TestReviewComparisonRejectsMalformedAuthority(t *testing.T) {
	cases := map[string]string{
		"short":                   reviewPatch("@@ -1,2 +1,2 @@\n only one\n"),
		"extra":                   reviewPatch("@@ -1 +1 @@\n-old\n+new\n+overflow\n"),
		"wrong side":              reviewPatch("@@ -1 +1 @@\n+extra\n+overflow\n"),
		"zero line nonzero count": reviewPatch("@@ -0 +1 @@\n-old\n+new\n"),
		"both zero":               reviewPatch("@@ -0,0 +0,0 @@\n"),
		"negative":                reviewPatch("@@ --1 +1 @@\n-old\n+new\n"),
		"overflow start":          reviewPatch("@@ -1 +2147483648 @@\n-old\n+new\n"),
		"overflow end":            reviewPatch("@@ -2147483647,2 +1,2 @@\n one\n two\n"),
		"huge count":              reviewPatch("@@ -1,999999999999999999999 +1 @@\n-old\n+new\n"),
		"notice first":            reviewPatch("@@ -1 +1 @@\n\\ No newline at end of file\n-old\n+new\n"),
		"notice repeated":         reviewPatch("@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n\\ No newline at end of file\n"),
		"row after new EOF":       reviewPatch("@@ -1 +1,2 @@\n-old\n+new\n\\ No newline at end of file\n+after EOF\n"),
		"row after old EOF":       reviewPatch("@@ -1,2 +1 @@\n-old\n\\ No newline at end of file\n-later\n+new\n"),
		"unknown notice":          reviewPatch("@@ -1 +1 @@\n-old\n+new\n\\ other notice\n"),
		"combined":                reviewPatch("@@@ -1 +1 +1 @@@\n+new\n"),
		"missing file headers":    "diff --git a/a.py b/a.py\n@@ -1 +1 @@\n-old\n+new\n",
		"mismatched path":         "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/forged.py\n@@ -1 +1 @@\n-old\n+new\n",
		"duplicate file":          reviewPatch("@@ -1 +1 @@\n-old\n+new\n") + reviewPatch("@@ -4 +4 @@\n-old\n+new\n"),
		"overlapping hunks":       reviewPatch("@@ -1 +1 @@\n-old\n+new\n@@ -1 +1 @@\n-old\n+new\n"),
		"unsafe traversal":        "diff --git a/../bad b/../bad\n",
		"malformed quoting":       `diff --git "a/\x61.py" "b/\x61.py"` + "\n",
		"invalid octal UTF8":      `diff --git "a/\377" "b/\377"` + "\n",
		"short octal":             `diff --git "a/\12" "b/\12"` + "\n",
		"control path":            `diff --git "a/\t" "b/\t"` + "\n",
		"ambiguous delimiter":     "diff --git a/name b/inside b/name\n",
		"preamble":                "commit abc\n" + reviewPatch("@@ -1 +1 @@\n-old\n+new\n"),
		"partial rename":          "diff --git a/old b/new\nrename from old\n",
		"nul source":              reviewPatch("@@ -1 +1 @@\n-old\n+new\x00\n"),
		"blank source":            reviewPatch("@@ -1 +1 @@\n\n"),
	}
	for name, text := range cases {
		t.Run(name, func(t *testing.T) {
			c, e := parseReviewComparison(text)
			if e == nil || c.Allows("a.py", 1) {
				t.Fatalf("malformed diff admitted: %#v %v", c, e)
			}
		})
	}
}

func TestReviewComparisonBoundsAndStableIndices(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 500; i++ {
		fmt.Fprintf(&b, "diff --git a/f%d b/f%d\n--- a/f%d\n+++ b/f%d\n@@ -0,0 +1 @@\n+row%d\n", i, i, i, i, i)
	}
	c, e := parseReviewComparison(b.String())
	if e != nil || !c.Allows("f499", 1) || len(c.files) != 500 {
		t.Fatalf("500 files: %v", e)
	}
	if _, e = parseReviewComparison(b.String() + "diff --git a/extra b/extra\n"); e == nil {
		t.Fatal("501 files admitted")
	}
	body := fmt.Sprintf("@@ -0,0 +1,%d @@\n", 12000) + strings.Repeat("+x\n", 12000)
	c, e = parseReviewComparison(reviewPatch(body))
	if e != nil || !c.Allows("a.py", 12000) {
		t.Fatalf("12000 rows: %v", e)
	}
	if _, e = parseReviewComparison(reviewPatch("@@ -0,0 +1,12001 @@\n" + strings.Repeat("+x\n", 12001))); e == nil {
		t.Fatal("12001 rows admitted")
	}
	if _, e = parseReviewComparison(reviewPatch("@@ -1 +1 @@\n-old\n+" + strings.Repeat("x", 512*1024) + "\n")); e == nil {
		t.Fatal("oversize bytes admitted")
	}
	c, e = parseReviewComparison(reviewPatch("@@ -2147483647 +2147483647 @@\n-old\n+new\n"))
	if e != nil || !c.Allows("a.py", 2147483647) {
		t.Fatalf("INT32 last coordinate: %v", e)
	}
	if _, e = parseReviewComparison(""); e != nil {
		t.Fatal("empty native comparison rejected")
	}
}

func TestReviewComparisonUnsupportedFilesDoNotAuthorizeRows(t *testing.T) {
	for _, mode := range []string{"120000", "160000"} {
		text := "diff --git a/link b/link\nindex 1111111..2222222 " + mode + "\n--- a/link\n+++ b/link\n@@ -1 +1 @@\n-before\n+after\n" + reviewPatch("@@ -4 +5 @@\n-old\n+new\n")
		c, e := parseReviewComparison(text)
		if e != nil || c.Allows("link", 1) || !c.Allows("a.py", 5) || c.files[1].hunks[0].rows[1].newLine != 5 {
			t.Fatalf("unsupported mode %s lost stable inventory: %v %#v", mode, e, c)
		}
		if c.MatchesNativeContext("link", 1, "@@ -1 +1 @@\n-before\n+after") {
			t.Fatal("unsupported native context authorized")
		}
	}
	// Two separated hunks retain their independent positions and cannot be
	// spliced into a native receipt, even when they contain identical text.
	c, e := parseReviewComparison(reviewPatch("@@ -1 +1 @@\n-old\n+same\n@@ -10 +20 @@\n-old\n+same\n"))
	if e != nil || !c.Allows("a.py", 20) || c.Allows("a.py", 2) {
		t.Fatalf("separated hunks: %v", e)
	}
	if c.MatchesNativeContext("a.py", 20, "@@ -1,2 +1,2 @@\n-old\n+same\n-old\n+same") {
		t.Fatal("multi-hunk context splice admitted")
	}
}

func TestReviewComparisonNativeAdmissionProfile(t *testing.T) {
	for _, text := range []string{"CRLF\r", "embedded\rreturn", "escape\x1b", "vertical\vtab", "unicode\u0085control"} {
		diff := reviewPatch("@@ -1 +1 @@\n-old\n+" + text + "\n@@ -10 +20 @@\n-before\n+ordinary\n")
		c, e := parseReviewComparison(diff)
		if e != nil {
			t.Fatalf("readable inventory rejected: %v", e)
		}
		if c.files[0].hunks[0].rows[1].text != text || c.files[0].hunks[0].rows[1].newLine != 1 {
			t.Fatal("unsupported source bytes or coordinate repaired")
		}
		if c.Allows("a.py", 1) || !c.Allows("a.py", 20) {
			t.Fatal("unsupported hunk admission or supported later hunk changed")
		}
		if c.MatchesNativeContext("a.py", 1, "@@ -1 +1 @@\n-old\n+"+strings.TrimSuffix(text, "\r")) {
			t.Fatal("native context normalization authorized")
		}
	}
	// Tabs are preserved by native ScanLines and the receipt text contract.
	c, e := parseReviewComparison(reviewPatch("@@ -1 +1 @@\n-old\n+ordinary\tindent\n"))
	if e != nil || !c.Allows("a.py", 1) || !c.MatchesNativeContext("a.py", 1, "@@ -1 +1 @@\n-old\n+ordinary\tindent") {
		t.Fatalf("supported tab context denied: %v", e)
	}
	// Unsafe function-context header bytes are retained, not normalized away.
	c, e = parseReviewComparison(reviewPatch("@@ -1 +1 @@ function\r\n-old\n+ordinary\n"))
	if e != nil || c.Allows("a.py", 1) || c.files[0].hunks[0].header != "@@ -1 +1 @@ function\r" {
		t.Fatalf("unsafe header handling: %v", e)
	}

	// Header reserve accounts for native's range-rewriting branch. The exact
	// conservative receipt budget admits its boundary and denies one byte more.
	safeBytes := reviewNativeContextLimit - reviewNativeCutHeaderBytes - 3
	for _, size := range []int{safeBytes, safeBytes + 1} {
		c, e := parseReviewComparison(reviewPatch("@@ -0,0 +1 @@\n+" + strings.Repeat("x", size) + "\n"))
		if e != nil || c.Allows("a.py", 1) != (size == safeBytes) {
			t.Fatalf("receipt budget %d: %v", size, e)
		}
		if len(c.files[0].hunks[0].rows[0].text) != size {
			t.Fatal("receipt bound discarded readable source")
		}
	}

	// A large aggregate hunk can exceed the retained JSON-field bound even
	// when every individual scanner token is safe. Other hunks stay usable.
	large := "@@ -0,0 +1,4 @@\n" + strings.Repeat("+"+strings.Repeat("x", 16400)+"\n", 4)
	c, e = parseReviewComparison(reviewPatch(large + "@@ -10 +20 @@\n-before\n+ordinary\n"))
	if e != nil || c.Allows("a.py", 1) || !c.Allows("a.py", 20) {
		t.Fatalf("aggregate receipt bound: %v", e)
	}

	// Native scans from the file's start, so an earlier overlong token also
	// blocks a small later hunk. A different ordinary file remains supported.
	for _, width := range []int{reviewNativeContextLimit - 1, reviewNativeContextLimit} {
		row := "+" + strings.Repeat("x", width-1)
		diff := reviewPatch("@@ -0,0 +1 @@\n"+row+"\n@@ -10 +20 @@\n-before\n+ordinary\n") + "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-before\n+ordinary\n"
		c, e := parseReviewComparison(diff)
		if e != nil || c.Allows("a.py", 1) || c.Allows("a.py", 20) != (width < reviewNativeContextLimit) || !c.Allows("b.py", 1) {
			t.Fatalf("scanner token width %d: %v", width, e)
		}
		if len(c.files[0].hunks[0].rows[0].text) != width-1 {
			t.Fatal("scanner-denied row was not retained")
		}
	}
}

func TestReviewComparisonNativeJSONBudget(t *testing.T) {
	// A raw context within64KiB can be much larger on the wire: HTML bytes,
	// Unicode separators, backslashes and quotes require JSON escaping.
	row := strings.Repeat("<>&", 15000) + "\u2028\\\""
	hunk := "@@ -0,0 +1 @@\n+" + row
	c, e := parseReviewComparison(reviewPatch(hunk + "\n"))
	if e != nil {
		t.Fatal(e)
	}
	bound, ok := c.NativeContextJSONBound("a.py", 1)
	if !ok || bound < 270000 || bound <= len(hunk)*5 {
		t.Fatalf("escaped JSON bound too small: %d", bound)
	}
	actual, _ := json.Marshal(hunk)
	worstHeader := "@@ -2147483647,12000 +2147483647,12000 @@"
	worst, _ := json.Marshal(worstHeader + "\n+" + row + "\n")
	if bound < len(actual) || bound != len(worst) {
		t.Fatalf("native JSON budget %d, expected maximum %d", bound, len(worst))
	}
	withFinalLF, _ := json.Marshal(hunk + "\n")
	if bound < len(withFinalLF) || !c.MatchesNativeContext("a.py", 1, hunk+"\n") {
		t.Fatal("final LF native receipt not bounded/supported")
	}
	// Multiplicity matters to the caller's aggregate budget even when all
	// comments select the same hunk. Ten such contexts exceed2MiB on the wire.
	if 10*bound <= 2<<20 {
		t.Fatal("aggregate escaping hazard not exercised")
	}
	if n, ok := c.NativeContextJSONBound("a.py", 2); ok || n != 0 {
		t.Fatal("invented coordinate acquired JSON budget")
	}
	unsafe, e := parseReviewComparison(reviewPatch("@@ -1 +1 @@\n-old\n+new\r\n"))
	if e != nil {
		t.Fatal(e)
	}
	if n, ok := unsafe.NativeContextJSONBound("a.py", 1); ok || n != 0 {
		t.Fatal("unsupported context acquired JSON budget")
	}
	// Real native fixture's ordinary LF replacement/prefix remains supported
	// under both the raw and escaped receipt budgets.
	fixture := reviewPatch("@@ -1,3 +1,3 @@\n-merge-base one\n+selected-head one\n merge-base two\n stable three\n")
	ordinary, e := parseReviewComparison(fixture)
	if e != nil || !ordinary.Allows("a.py", 1) || !ordinary.MatchesNativeContext("a.py", 1, "@@ -1,3 +1,3 @@\n-merge-base one\n+selected-head one") {
		t.Fatalf("ordinary native fixture profile rejected: %v", e)
	}
	if n, ok := ordinary.NativeContextJSONBound("a.py", 1); !ok || n > 1024 {
		t.Fatal("ordinary fixture JSON bound unavailable/oversized")
	}
}

func FuzzReviewComparison(f *testing.F) {
	for _, seed := range []string{reviewPatch("@@ -1 +1 @@\n-old\n+new\n"), reviewPatch("@@ -0,0 +1 @@\n+new"), "diff --git \"a/\\377\" \"b/\\377\"\n", "\x00\xff", reviewPatch("@@ -1,3 +1 @@\n-only\n+new")} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, text string) {
		c, e := parseReviewComparison(text)
		if e != nil {
			return
		}
		// Successful empty/metadata inventories must remain harmless under any
		// subsequent untrusted receipt, rather than panic or fabricate a line.
		_ = c.Allows("a.py", 1)
		_ = c.MatchesNativeContext("a.py", 1, text)
	})
}

func TestReviewComparisonNativeContextBinding(t *testing.T) {
	full := "@@ -10,4 +20,4 @@ function\n first\n-old\n+selected\n third\n last\n"
	c, e := parseReviewComparison(reviewPatch(full))
	if e != nil {
		t.Fatal(e)
	}
	cases := []struct {
		name, patch string
		line        int
		want        bool
	}{
		{"complete", full, 21, true},
		{"native original-header prefix", "@@ -10,4 +20,4 @@ function\n first\n-old\n+selected", 21, true},
		{"correct recalculated cut", "@@ -11,1 +21,1 @@\n-old\n+selected", 21, true},
		{"new-side only zero-context", "@@ -11,0 +21,1 @@\n+selected", 21, true},
		{"forged zero-side anchor", "@@ -99,0 +21,1 @@\n+selected", 21, false},
		{"context row cut", "@@ -12,1 +22,1 @@\n third", 22, true},
		{"wrong old origin", "@@ -11,1 +21,1 @@\n-base-tip old\n+selected", 21, false},
		{"wrong head origin", "@@ -11,1 +21,1 @@\n-old\n+newer-head", 21, false},
		{"selected absent", "@@ -10,4 +20,4 @@ function\n first", 21, false},
		{"header shifted", "@@ -12,1 +22,1 @@\n-old\n+selected", 21, false},
		{"incorrect recalc count", "@@ -11,2 +21,2 @@\n-old\n+selected", 21, false},
		{"prefix not at start", "@@ -10,4 +20,4 @@ function\n-old\n+selected", 21, false},
		{"extra fabricated row", full + "+forged", 21, false},
		{"two hunks", full + "@@ -30 +30 @@\n-old\n+selected", 21, false},
		{"unbound file headers", "diff --git a/other b/other\n--- a/other\n+++ b/other\n" + full, 21, false},
		{"native file headers", reviewPatch(full), 21, true},
		{"empty", "", 21, false},
		{"no coordinate", full, 0, false},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			if got := c.MatchesNativeContext("a.py", tt.line, tt.patch); got != tt.want {
				t.Fatalf("got %v want %v", got, tt.want)
			}
		})
	}
	// Unterminated added line retains its exact notice; no fuzzy text repair.
	p := reviewPatch("@@ -0,0 +1 @@\n+last\n\\ No newline at end of file\n")
	newFile, e := parseReviewComparison(p)
	if e != nil || !newFile.MatchesNativeContext("a.py", 1, "@@ -0,0 +1 @@\n+last\n\\ No newline at end of file") {
		t.Fatalf("notice context denied: %v", e)
	}
	if newFile.MatchesNativeContext("a.py", 1, "@@ -0,0 +1 @@\n+last ") {
		t.Fatal("trailing source space repaired")
	}
}

func TestReviewComparisonNativeEmptySideDelimiter(t *testing.T) {
	const path = "src/context ü.txt"
	patch := "diff --git a/" + path + " b/" + path + "\nindex 1234..abcd 100644\n--- a/" + path + "\t\n+++ b/" + path + "\t\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n stable\n"
	c, err := parseReviewComparison(patch)
	if err != nil || len(c.files) != 1 || c.files[0].oldPath != path || c.files[0].newPath != path || !c.Allows(path, 2) || c.Allows(path+"\t", 2) {
		t.Fatalf("native empty delimiter changed literal identities or admission: %v", err)
	}
	h := c.files[0].hunks[0]
	if h.rows[1].oldLine != 2 || h.rows[2].newLine != 2 || h.rows[2].text != "new" || !c.MatchesNativeContext(path, 2, "@@ -1,3 +1,3 @@\n context\n-old\n+new\n stable\n") {
		t.Fatal("native empty delimiter changed retained coordinates/context")
	}
	for _, suffix := range []string{"\t\t", "\t2026-10-03 12:00:00", "\tother/path", "\t ", "\t\r", "\tother/path\t"} {
		for _, side := range []string{"--- a/", "+++ b/"} {
			bad := strings.Replace(patch, side+path+"\t\n", side+path+suffix+"\n", 1)
			if parsed, err := parseReviewComparison(bad); err == nil || parsed.Allows(path, 2) {
				t.Fatalf("nonempty/ambiguous side suffix admitted: %q %q", side, suffix)
			}
		}
	}
	// An encoded TAB remains a forbidden path byte, even with an empty delimiter.
	quotedControl := "diff --git a/ordinary b/ordinary\n--- a/ordinary\n+++ \"b/ordinary\\t\"\t\n@@ -1 +1 @@\n-old\n+new\n"
	if _, err := parseReviewComparison(quotedControl); err == nil {
		t.Fatal("quoted path control admitted as a side delimiter")
	}
}

func TestReviewComparisonOldSidePublication(t *testing.T) {
	raw := "diff --git a/src/context.txt b/src/context.txt\n--- a/src/context.txt\n+++ b/src/context.txt\n@@ -10,3 +10,2 @@\n context\n-deleted\n-last old\n+replacement\n"
	c, err := parseReviewComparison(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !c.allowsSide("src/context.txt", 12, true) || c.allowsSide("src/context.txt", 12, false) || c.allowsSide("src/context.txt", 13, true) {
		t.Fatal("old-side coordinates confused with new/source-adjacent rows")
	}
	hunk := "@@ -10,3 +10,2 @@\n context\n-deleted\n-last old\n+replacement\n"
	if !c.matchesNativeContextSide("src/context.txt", 12, true, hunk) || c.matchesNativeContextSide("src/context.txt", 12, false, hunk) {
		t.Fatal("old context selection not exact")
	}
	if c.matchesNativeContextSide("src/context.txt", 12, true, strings.Replace(hunk, "last old", "different", 1)) {
		t.Fatal("mixed old context authorized")
	}
	if n, ok := c.nativeContextJSONBoundSide("src/context.txt", 12, true); !ok || n <= len(hunk) {
		t.Fatal("old-side context budget absent")
	}
	deletion := "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n"
	c, err = parseReviewComparison(deletion)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.files) != 1 || c.files[0].hunks[0].rows[0].oldLine != 1 || c.allowsSide("gone.txt", 1, true) {
		t.Fatal("unqualified deletion inventory was lost or became write authority")
	}
}

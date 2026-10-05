package staticpreview

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

type member struct {
	header tar.Header
	body   []byte
}

func regular(name, body string) member {
	return member{header: tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0444, Format: tar.FormatPAX}, body: []byte(body)}
}
func archive(t *testing.T, members ...member) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := tar.NewWriter(&output)
	for _, entry := range members {
		entry.header.Size = int64(len(entry.body))
		if err := writer.WriteHeader(&entry.header); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(entry.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}
func requireRefusal(t *testing.T, data []byte) {
	t.Helper()
	site, err := Parse(data)
	if site != nil || !errors.Is(err, ErrArchive) {
		t.Fatalf("archive admitted: site=%v error=%v", site, err)
	}
}

func TestNestedSPAAndExplicitRoots(t *testing.T) {
	files := []member{regular("dist/index.html", "<script src=\"app.js\"></script>"), regular("dist/app.js", "console.log('site')"), regular("dist/style.css", "body{color:black}"), regular("other/index.html", "<h1>Other</h1>"), regular("index.html", "Root"), regular("dist/assets/café.txt", "café"), regular("dist/assets/font.woff2", "\x00\x01")}
	data := archive(t, files...)
	site, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	if site.ArchiveSHA256 != digest(data) || site.FileCount != len(files) {
		t.Fatal("archive receipt changed")
	}
	var total int64
	for _, entry := range files {
		total += int64(len(entry.body))
	}
	if site.FileBytes != total {
		t.Fatal("file byte receipt changed")
	}
	roots := site.Roots()
	if len(roots) != 3 || roots[0] != (Root{Path: ".", EntryPath: "index.html"}) || roots[1] != (Root{Path: "dist", EntryPath: "dist/index.html"}) || roots[2].Path != "other" {
		t.Fatalf("wrong explicit roots: %v", roots)
	}
	file, err := site.File("dist", "app.js")
	if err != nil || file.ContentType != "text/javascript; charset=utf-8" || file.SHA256 != digest([]byte("console.log('site')")) || string(file.Bytes) != "console.log('site')" {
		t.Fatal("file metadata/bytes changed")
	}
	roots[1].Path = "changed"
	file.Bytes[0] = 'X'
	clear(data)
	unchanged, err := site.File("dist", "app.js")
	if err != nil || string(unchanged.Bytes) != "console.log('site')" || site.Roots()[1].Path != "dist" {
		t.Fatal("caller mutated retained inventory")
	}
	for _, request := range [][2]string{{"missing", "index.html"}, {"dist", "../other/index.html"}, {"dist", "other/index.html"}, {"dist", "/index.html"}, {"dist", ""}, {"dist", "missing-route"}, {".", "dist"}, {"dist", "%69ndex.html"}} {
		if _, err := site.File(request[0], request[1]); !errors.Is(err, ErrFile) {
			t.Fatalf("guessed or escaped file admitted: %v", request)
		}
	}
	// Entry order does not change the sorted manifest, but the raw artifact hash
	// deliberately still identifies the exact original bytes.
	reversed := append([]member(nil), files...)
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	other, err := Parse(archive(t, reversed...))
	if err != nil || other.ManifestSHA256 != site.ManifestSHA256 || other.ArchiveSHA256 == site.ArchiveSHA256 {
		t.Fatal("manifest order or exact archive binding changed")
	}
	// Independently verify manifest serialization against the documented fields.
	names := []string{"dist/app.js", "dist/assets/café.txt", "dist/assets/font.woff2", "dist/index.html", "dist/style.css", "index.html", "other/index.html"}
	rows := make([]manifestFile, 0, len(names))
	for _, name := range names {
		f := site.files[name]
		rows = append(rows, manifestFile{Name: name, Size: int64(len(f.Bytes)), SHA256: f.SHA256, ContentType: f.ContentType})
	}
	encoded, _ := json.Marshal(rows)
	if site.ManifestSHA256 != digest(encoded) {
		t.Fatal("manifest digest mismatch")
	}
}

func TestArchiveMaliciousPaths(t *testing.T) {
	for _, name := range []string{"../index.html", "/index.html", "./index.html", "dist/../index.html", "dist//index.html", "dist\\index.html", "C:index.html", "dist/%2e%2e/index.html", "dist/index.html?x", "dist/index.html#x", ".git/index.html", "dist/.hidden.txt", "dist/__golf/control.txt", "dist/\n.txt", "dist/\x7f.txt", "dist/\xff.txt", "dist/\u0085.txt", "dist/" + string(bytes.Repeat([]byte("a"), 1024)) + ".txt"} {
		t.Run(name, func(t *testing.T) { requireRefusal(t, archive(t, regular("index.html", "safe"), regular(name, "bad"))) })
	}
}

func TestLongLiteralPathAndNULRefusal(t *testing.T) {
	name := "dist/" + string(bytes.Repeat([]byte("x"), 200)) + ".txt"
	site, err := Parse(archive(t, regular("dist/index.html", "safe"), regular(name, "long")))
	if err != nil {
		t.Fatal("producer PAX path refused", err)
	}
	if _, err := site.File("dist", name[len("dist/"):]); err != nil {
		t.Fatal(err)
	}
	// archive/tar refuses encoding NUL in PAX paths; literal lookup must refuse
	// it too, without collapsing it to the prefix as a C-string decoder would.
	if _, err := site.File("dist", "index.html\x00.txt"); !errors.Is(err, ErrFile) {
		t.Fatal("NUL path adopted")
	}
}

func TestArchiveUnsupportedMembers(t *testing.T) {
	for _, kind := range []byte{tar.TypeDir, tar.TypeSymlink, tar.TypeLink, tar.TypeChar, tar.TypeBlock, tar.TypeFifo} {
		t.Run(string([]byte{kind}), func(t *testing.T) {
			header := tar.Header{Name: "dist/other.txt", Typeflag: kind, Mode: 0444}
			if kind == tar.TypeSymlink || kind == tar.TypeLink {
				header.Linkname = "index.html"
			}
			requireRefusal(t, archive(t, regular("index.html", "safe"), member{header: header}))
		})
	}
	for _, entry := range []member{
		{header: tar.Header{Name: "other.txt", Typeflag: tar.TypeReg, Linkname: "target"}},
		{header: tar.Header{Name: "other.txt", Typeflag: tar.TypeReg, Format: tar.FormatGNU}},
		{header: tar.Header{Name: "other.txt", Typeflag: tar.TypeReg, Format: tar.FormatPAX, PAXRecords: map[string]string{"comment": "extended"}}},
		regular("unknown.bin", "bytes"), regular("script.svg", "<svg/>"), regular("site.wasm", "bytes"), regular("app.js.map", "{}"), regular("app.js", "\xff"), regular("site.json", "\xff"),
	} {
		requireRefusal(t, archive(t, regular("index.html", "safe"), entry))
	}
	// Build a real sparse tar header rather than passing sparse writer metadata
	// that archive/tar deliberately ignores when writing regular files.
	sparse := archive(t, regular("sparse.txt", "x"))
	sparse[156] = tar.TypeGNUSparse
	checksum(sparse[:512])
	valid := archive(t, regular("index.html", "safe"))
	requireRefusal(t, append(bytes.Clone(valid[:len(valid)-1024]), sparse...))
	// PAX sparse metadata must also fail when the reader exposes a regular file.
	record := fmt.Sprintf("%d GNU.sparse.size=1\n", len(" GNU.sparse.size=1\n")+2)
	extension := archive(t, regular("pax", record))
	extension[156] = tar.TypeXHeader
	checksum(extension[:512])
	combined := append(bytes.Clone(extension[:len(extension)-1024]), archive(t, regular("index.html", "x"))...)
	requireRefusal(t, combined)
}

func TestArchiveDuplicatesAndAncestorCollisions(t *testing.T) {
	for _, files := range [][]member{
		{regular("index.html", "a"), regular("index.html", "b")},
		{regular("index.html", "safe"), regular("file.txt", "a"), regular("file.txt/child.txt", "b")},
		{regular("index.html", "safe"), regular("file.txt/child.txt", "b"), regular("file.txt", "a")},
		{regular("app.js", "no index")},
	} {
		requireRefusal(t, archive(t, files...))
	}
}

func TestArchiveBoundsAndTruncation(t *testing.T) {
	valid := archive(t, regular("index.html", "ok"))
	for _, data := range [][]byte{nil, []byte("not tar"), valid[:511], valid[:len(valid)-1024], valid[:len(valid)-1], append(bytes.Clone(valid), 'x'), append(bytes.Clone(valid), make([]byte, 512)...), append(bytes.Clone(valid), valid...)} {
		requireRefusal(t, data)
	}
	corrupt := bytes.Clone(valid)
	corrupt[148] ^= 1
	requireRefusal(t, corrupt)
	var gz bytes.Buffer
	zipped := gzip.NewWriter(&gz)
	_, _ = zipped.Write(valid)
	_ = zipped.Close()
	requireRefusal(t, gz.Bytes())
	requireRefusal(t, make([]byte, MaxArchiveBytes+1))
	files := []member{regular("index.html", "ok")}
	for i := 1; i < MaxFiles; i++ {
		files = append(files, regular(fmt.Sprintf("file-%03d.txt", i), ""))
	}
	if _, err := Parse(archive(t, files...)); err != nil {
		t.Fatal("exact file limit refused", err)
	}
	files = append(files, regular("extra.txt", ""))
	requireRefusal(t, archive(t, files...))
	large := regular("index.html", string(bytes.Repeat([]byte("x"), MaxFileBytes)))
	if _, err := Parse(archive(t, large)); err != nil {
		t.Fatal("exact byte limit refused", err)
	}
	requireRefusal(t, archive(t, large, regular("extra.txt", "x")))
	tooLarge := regular("index.html", string(bytes.Repeat([]byte("x"), MaxFileBytes+1)))
	requireRefusal(t, archive(t, tooLarge))
}

func TestMIMEAllowlist(t *testing.T) {
	for _, extension := range []string{"html", "htm", "js", "mjs", "css", "txt", "json", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "woff", "woff2", "ttf", "otf"} {
		site, err := Parse(archive(t, regular("index.html", "root"), regular("asset."+extension, "asset")))
		if err != nil {
			t.Fatal(extension, err)
		}
		file, err := site.File(".", "asset."+extension)
		if err != nil || file.ContentType == "" || file.SHA256 != digest([]byte("asset")) {
			t.Fatal(extension, err)
		}
	}
	var empty *SiteArchive
	if len(empty.Roots()) != 0 {
		t.Fatal("nil roots")
	}
	if _, err := empty.File(".", "index.html"); !errors.Is(err, ErrFile) {
		t.Fatal("nil lookup")
	}
}

func checksum(header []byte) {
	for i := 148; i < 156; i++ {
		header[i] = ' '
	}
	total := 0
	for _, value := range header {
		total += int(value)
	}
	copy(header[148:156], fmt.Sprintf("%06o\x00 ", total))
}

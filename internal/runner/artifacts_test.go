package runner

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func artifactTar(t *testing.T, headers []*tar.Header) []byte {
	t.Helper()
	var out bytes.Buffer
	w := tar.NewWriter(&out)
	for _, h := range headers {
		if err := w.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Size > 0 {
			if _, err := w.Write(bytes.Repeat([]byte("x"), int(h.Size))); err != nil {
				t.Fatal(err)
			}
		}
	}
	if w.Close() != nil {
		t.Fatal("tar close")
	}
	return out.Bytes()
}

func TestArtifactsCanonicalSelectionAndMetadata(t *testing.T) {
	input := artifactTar(t, []*tar.Header{{Name: "./", Typeflag: tar.TypeDir}, {Name: "source.txt", Typeflag: tar.TypeReg, Size: 5}, {Name: "dist/z.html", Typeflag: tar.TypeReg, Size: 3, Mode: 06777, Uid: 123, ModTime: time.Now()}, {Name: "dist/雪.txt", Typeflag: tar.TypeReg, Size: 2}})
	archive, files, size, err := NormalizeArtifactArchive(input, []string{"dist"})
	if err != nil || files != 2 || size != 5 {
		t.Fatal("selected outputs missing", err)
	}
	reader := tar.NewReader(bytes.NewReader(archive))
	var names []string
	for {
		h, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, h.Name)
		if h.Mode != 0444 || h.Uid != 0 || h.Gid != 0 || !h.ModTime.IsZero() && h.ModTime.Unix() != 0 || h.Linkname != "" {
			t.Fatal("untrusted metadata survived")
		}
	}
	if strings.Join(names, ",") != "dist/z.html,dist/雪.txt" {
		t.Fatal("source leaked or order changed")
	}
	again, _, _, err := NormalizeArtifactArchive(archive, []string{"dist"})
	if err != nil || !bytes.Equal(archive, again) {
		t.Fatal("canonical bytes unstable", err)
	}
}

func TestArtifactsRefuseLinksTraversalMissingAndLimits(t *testing.T) {
	for name, headers := range map[string][]*tar.Header{
		"symlink outside selection": {{Name: "link", Typeflag: tar.TypeSymlink, Linkname: "/etc"}, {Name: "dist/a", Typeflag: tar.TypeReg}},
		"hardlink":                  {{Name: "dist/a", Typeflag: tar.TypeLink, Linkname: "source"}},
		"device":                    {{Name: "dist/a", Typeflag: tar.TypeChar}},
		"parent":                    {{Name: "dist/../a", Typeflag: tar.TypeReg}},
		"absolute":                  {{Name: "/dist/a", Typeflag: tar.TypeReg}},
		"duplicate":                 {{Name: "dist/a", Typeflag: tar.TypeReg}, {Name: "dist/a", Typeflag: tar.TypeReg}},
		"late parent file":          {{Name: "dist/a/b", Typeflag: tar.TypeReg}, {Name: "dist/a", Typeflag: tar.TypeReg}},
		"missing":                   {{Name: "source", Typeflag: tar.TypeReg}},
		"empty directory":           {{Name: "dist/", Typeflag: tar.TypeDir}},
		"bytes":                     {{Name: "dist/a", Typeflag: tar.TypeReg, Size: MaxArtifactBytes + 1}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, _, err := NormalizeArtifactArchive(artifactTar(t, headers), []string{"dist"}); err == nil {
				t.Fatal("unsafe output admitted")
			}
		})
	}
	var headers []*tar.Header
	for range MaxArtifactFiles + 1 {
		headers = append(headers, &tar.Header{Name: "dist/" + testID(), Typeflag: tar.TypeReg})
	}
	if _, _, _, err := NormalizeArtifactArchive(artifactTar(t, headers), []string{"dist"}); err == nil {
		t.Fatal("file cap lost")
	}
	archive := artifactTar(t, []*tar.Header{{Name: "dist/a", Typeflag: tar.TypeReg}})
	if _, _, _, err := NormalizeArtifactArchive(append(archive, byte('x')), []string{"dist"}); err == nil {
		t.Fatal("hidden trailing data")
	}
	for _, paths := range [][]string{nil, {"../outside"}, {"*"}, {"$HOME"}, {"a", "a/b"}, {"a", "a"}, {"a\\b"}, {"a\nb"}} {
		if ValidateArtifactPaths(paths) == nil {
			t.Fatal("nonliteral or overlapping selector admitted")
		}
	}
}

// The actual Docker29.8.1 archive API envelope observed for the paused tmpfs
// contained only this root directory. It must not become an empty success.
func TestArtifactsEmptyDockerTmpfsEnvelopeRefused(t *testing.T) {
	data := artifactTar(t, []*tar.Header{{Name: "./", Typeflag: tar.TypeDir}})
	if _, _, _, err := NormalizeArtifactArchive(data, []string{"dist"}); err == nil {
		t.Fatal("missing tmpfs files accepted")
	}
}

func TestArtifactsCaptureThenFenceOwnedContainer(t *testing.T) {
	for _, mode := range []string{"owned", "initial-foreign", "late-foreign", "not-paused", "empty", "exec-failed", "pause-failed"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			archive, calls := filepath.Join(dir, "workspace.tar"), filepath.Join(dir, "calls")
			paused, executable := filepath.Join(dir, "paused"), filepath.Join(dir, "docker")
			headers := []*tar.Header{{Name: "./", Typeflag: tar.TypeDir}, {Name: "./dist/", Typeflag: tar.TypeDir}, {Name: "./dist/a", Typeflag: tar.TypeReg, Size: 3}}
			if mode == "empty" {
				headers = headers[:1]
			}
			if os.WriteFile(archive, artifactTar(t, headers), 0600) != nil {
				t.Fatal("fixture")
			}
			id, attempt, owner, worker := strings.Repeat("a", 64), testID(), testID(), "artifact-test"
			receipt := func(isPaused, foreign bool) string {
				labels := map[string]string{workerLabel: worker, attemptLabel: attempt, ownerLabel: owner, managedLabel: "true"}
				if foreign {
					labels[ownerLabel] = testID()
				}
				value, _ := json.Marshal([]any{map[string]any{"Id": id, "Config": map[string]any{"Labels": labels}, "State": map[string]bool{"Running": true, "Paused": isPaused}}})
				return string(value)
			}
			// All shell-interpolated paths/IDs are local controlled test fixtures.
			script := "#!/bin/sh\nprintf '%s\\n' \"$2\" >> '" + calls + "'\ncase \"$2\" in\ninspect) if [ -f '" + paused + "' ]; then printf '%s' '" + receipt(mode != "not-paused", mode == "late-foreign") + "'; else printf '%s' '" + receipt(false, mode == "initial-foreign") + "'; fi;;\nexec) "
			if mode == "exec-failed" {
				script += "exit 1"
			} else {
				script += "[ \"$3\" = '--user=1000:1000' ] && [ \"$4\" = '--workdir=/workspace' ] && [ \"$5\" = '" + id + "' ] && [ \"$6\" = '/usr/bin/env' ] && [ \"$7\" = '-i' ] && [ \"$8\" = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' ] && [ \"$9\" = '/bin/tar' ] && [ \"${10}\" = '-C' ] && [ \"${11}\" = '/workspace' ] && [ \"${12}\" = '-cf' ] && [ \"${13}\" = '-' ] && [ \"${14}\" = '.' ] && [ \"$#\" = 14 ] || exit 1\ncat '" + archive + "'"
			}
			script += ";;\npause) "
			if mode == "pause-failed" {
				script += "exit 1"
			} else {
				script += "touch '" + paused + "'"
			}
			script += ";;\n*) exit 1;;\nesac\n"
			if os.WriteFile(executable, []byte(script), 0700) != nil {
				t.Fatal("fixture executable")
			}
			e, _ := New(Config{WorkerID: worker, DockerBinary: executable, ApprovedImages: []string{"alpine@sha256:" + strings.Repeat("b", 64)}})
			data, err := e.collectArtifacts(t.Context(), id, attempt, owner, []string{"dist"})
			observed, _ := os.ReadFile(calls)
			if mode == "owned" {
				if err != nil || len(data) == 0 || string(observed) != "inspect\nexec\npause\ninspect\n" {
					t.Fatal("capture/fence order", err, string(observed))
				}
			} else if err == nil || len(data) != 0 {
				t.Fatal("failed capture/fence delivered output")
			}
			if mode == "initial-foreign" && string(observed) != "inspect\n" {
				t.Fatal("foreign job executed or paused")
			}
			if mode == "exec-failed" && string(observed) != "inspect\nexec\n" {
				t.Fatal("failed capture advanced")
			}
			if strings.Contains(string(observed), "cp") {
				t.Fatal("archive API still used")
			}
		})
	}
}

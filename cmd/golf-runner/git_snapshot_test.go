package main

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitSnapshotBindsRealGitTree(t *testing.T) {
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal("installed Git required for runner preparation proof")
	}
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			directory := t.TempDir()
			command := func(args ...string) []byte {
				cmd := exec.CommandContext(t.Context(), git, append([]string{"-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "user.name=Runner proof", "-c", "user.email=runner@example.invalid"}, args...)...)
				cmd.Dir = directory
				cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin:/sbin", "HOME=" + directory, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", "LANG=C"}
				output, err := cmd.Output()
				if err != nil {
					t.Fatal("owned real Git fixture command failed")
				}
				return output
			}
			command("init", "--template=", "--object-format="+format)
			workflow := ".github/workflows/proof.yml"
			files := map[string]string{workflow: "name: Original workflow\non: push\n", "dir/space file.txt": "original\x00bytes\n", "bin/check": "#!/bin/sh\nprintf ok\n"}
			for name, value := range files {
				if os.MkdirAll(filepath.Dir(filepath.Join(directory, name)), 0700) != nil || os.WriteFile(filepath.Join(directory, name), []byte(value), 0600) != nil {
					t.Fatal("owned source fixture")
				}
			}
			if os.Chmod(filepath.Join(directory, "bin/check"), 0700) != nil {
				t.Fatal("executable source fixture")
			}
			command("add", "--", ".")
			command("commit", "-m", "Owned source proof")
			commit := strings.TrimSpace(string(command("rev-parse", "HEAD")))
			blob := strings.TrimSpace(string(command("rev-parse", commit+":"+workflow)))
			listing := command("ls-tree", "-rz", "--full-tree", commit)
			archive := func(change string) []byte {
				var buffer bytes.Buffer
				writer := tar.NewWriter(&buffer)
				write := func(header tar.Header, value string) {
					if writer.WriteHeader(&header) != nil {
						t.Fatal("owned tar header")
					}
					if _, err := writer.Write([]byte(value)); err != nil {
						t.Fatal("owned tar payload")
					}
				}
				for _, name := range []string{workflow, "dir/space file.txt", "bin/check"} {
					if change == "missing" && name == "bin/check" {
						continue
					}
					value := files[name]
					if change == "content" && name == "dir/space file.txt" {
						value = "changed bytes"
					}
					mode := int64(0644)
					if name == "bin/check" && change != "mode" {
						mode = 0755
					}
					write(tar.Header{Name: name, Mode: mode, Typeflag: tar.TypeReg, Size: int64(len(value))}, value)
					if change == "duplicate" && name == workflow {
						write(tar.Header{Name: name, Mode: mode, Typeflag: tar.TypeReg, Size: int64(len(value))}, value)
					}
				}
				if change == "extra" {
					write(tar.Header{Name: "uncommitted.txt", Mode: 0644, Typeflag: tar.TypeReg, Size: 1}, "x")
				}
				if change == "directory" {
					write(tar.Header{Name: "uncommitted-dir", Mode: 0755, Typeflag: tar.TypeDir}, "")
				}
				if change == "symlink" {
					write(tar.Header{Name: "link", Mode: 0777, Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}, "")
				}
				if writer.Close() != nil {
					t.Fatal("owned tar close")
				}
				result := buffer.Bytes()
				if change == "trailing" {
					result = append(result, []byte("second archive or garbage")...)
				}
				return result
			}
			for _, change := range []string{"", "missing", "content", "mode", "duplicate", "extra", "directory", "symlink", "trailing", "digest", "workflow", "tree-symlink", "tree-git", "tree-object-format", "tree-directories"} {
				t.Run(change, func(t *testing.T) {
					data, tree, expectedBlob := archive(change), listing, blob
					sum := sha256.Sum256(data)
					digest := hex.EncodeToString(sum[:])
					switch change {
					case "digest":
						digest = strings.Repeat("f", 64)
					case "workflow":
						expectedBlob = strings.Repeat("f", len(blob))
					case "tree-symlink":
						tree = append(append([]byte{}, listing...), []byte("120000 blob "+blob+"\tlink\x00")...)
					case "tree-git":
						tree = append(append([]byte{}, listing...), []byte("100644 blob "+blob+"\t.git/config\x00")...)
					case "tree-object-format":
						tree = bytes.ReplaceAll(listing, []byte(blob), []byte(blob+"f"))
					case "tree-directories":
						tree = append([]byte{}, listing...)
						for _, prefix := range []string{"a/", "b/"} {
							tree = append(tree, []byte("100644 blob "+blob+"\t"+prefix+strings.Repeat("d/", 2045)+"x\x00")...)
						}
					}
					err := verifyGitSnapshot(data, tree, digest, commit, workflow, expectedBlob)
					if (err == nil) != (change == "") {
						t.Fatal("real tree/archive identity boundary failed")
					}
				})
			}
		})
	}
}

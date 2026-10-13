package main

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
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
			for _, change := range []string{"", "missing", "content", "mode", "duplicate", "extra", "directory", "symlink", "trailing", "digest", "workflow", "tree-symlink", "tree-git", "tree-git-case", "tree-git-space", "tree-control-format", "tree-case-collision", "tree-object-format", "tree-directories"} {
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
					case "tree-git-case":
						tree = append(append([]byte{}, listing...), []byte("100644 blob "+blob+"\t.GIT/config\x00")...)
					case "tree-git-space":
						tree = append(append([]byte{}, listing...), []byte("100644 blob "+blob+"\t.git /config\x00")...)
					case "tree-control-format":
						tree = append(append([]byte{}, listing...), []byte("100644 blob "+blob+"\tzero\u200bwidth\x00")...)
					case "tree-case-collision":
						tree = append(append([]byte{}, listing...), []byte("100644 blob "+blob+"\tBIN/other\x00")...)
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

// Native Git produces the tree and exported bytes. Only the ordinary archive
// projection is controlled here; this is source-boundary proof, not Docker or
// job-token network qualification.
func TestGitSnapshotNativeAdversarialSource(t *testing.T) {
	for _, mode := range []string{"nested", "export_ignore", "export_subst", "symlink", "submodule", "lfs_pointer", "hostile_local_config", "git_metadata_path"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			var requests atomic.Int32
			foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.WriteHeader(http.StatusForbidden)
			}))
			defer foreign.Close()
			git := func(input []byte, args ...string) []byte {
				t.Helper()
				// Reuse the same hermetic installed-Git command as preparation.
				if input == nil {
					data, err := preparedGitCommand(t.Context(), dir, 4<<20, args...)
					if err != nil {
						t.Fatal("owned native source fixture", err)
					}
					return data
				}
				// Object construction is fixture-only, with no source configuration.
				cmd := exec.CommandContext(t.Context(), "/usr/bin/git", args...)
				cmd.Dir = dir
				cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + dir, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
				cmd.Stdin = bytes.NewReader(input)
				data, err := cmd.Output()
				if err != nil {
					t.Fatal("owned native object fixture", err)
				}
				return data
			}
			write := func(name, value string) {
				t.Helper()
				if os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0700) != nil || os.WriteFile(filepath.Join(dir, name), []byte(value), 0600) != nil {
					t.Fatal("owned source fixture")
				}
			}
			git(nil, "init", "--quiet", "--template=")
			workflow := ".forgejo/workflows/proof.yml"
			write(workflow, "on: workflow_dispatch\n")
			write("src/nested/message.txt", "$Format:%H$\n")
			switch mode {
			case "export_ignore":
				write(".gitattributes", "src/nested/message.txt export-ignore\n")
			case "export_subst":
				write(".gitattributes", "src/nested/message.txt export-subst\n")
			case "symlink":
				if os.Symlink("../../.git/config", filepath.Join(dir, "src", "link")) != nil {
					t.Fatal("owned symlink fixture")
				}
			case "lfs_pointer":
				write(".gitattributes", "src/nested/message.txt filter=lfs diff=lfs merge=lfs -text\n")
				write(".lfsconfig", "[lfs]\nurl = "+foreign.URL+"/private-lfs\n")
				write("src/nested/message.txt", "version https://git-lfs.github.com/spec/v1\noid sha256:"+strings.Repeat("a", 64)+"\nsize 100\n")
			case "submodule":
				write(".gitmodules", "[submodule \"private\"]\npath = private\nurl = "+foreign.URL+"/other-private.git\n")
			}
			git(nil, "add", ".")
			commit := func() {
				git(nil, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "owned source")
			}
			commit()
			if mode == "submodule" {
				h := strings.TrimSpace(string(git(nil, "rev-parse", "HEAD")))
				git(nil, "update-index", "--add", "--cacheinfo", "160000,"+h+",private")
				commit()
			}
			if mode == "hostile_local_config" {
				marker := filepath.Join(dir, "callback-ran")
				write("hooks/post-commit", "#!/bin/sh\ntouch "+marker+"\n")
				if os.Chmod(filepath.Join(dir, "hooks/post-commit"), 0700) != nil {
					t.Fatal("owned hook fixture")
				}
				git(nil, "config", "--local", "core.hooksPath", filepath.Join(dir, "hooks"))
				git(nil, "config", "--local", "credential.helper", "!touch "+marker)
				git(nil, "config", "--local", "remote.origin.url", foreign.URL+"/other-private.git")
				git(nil, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "hermetic commit")
				if _, err := os.Stat(marker); !os.IsNotExist(err) {
					t.Fatal("native preparation ran a configured callback")
				}
			}
			if mode == "git_metadata_path" {
				blob := strings.TrimSpace(string(git([]byte("[credential]\nhelper = attacker\n"), "hash-object", "-w", "--stdin")))
				subtree := strings.TrimSpace(string(git([]byte("100644 blob "+blob+"\tconfig\n"), "mktree")))
				root := git(append(git(nil, "ls-tree", "HEAD"), []byte("040000 tree "+subtree+"\t.git\n")...), "mktree")
				h := git([]byte("owned malicious tree\n"), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", strings.TrimSpace(string(root)))
				git(nil, "update-ref", "HEAD", strings.TrimSpace(string(h)))
			}
			h := strings.TrimSpace(string(git(nil, "rev-parse", "HEAD")))
			blob := strings.TrimSpace(string(git(nil, "rev-parse", "HEAD:"+workflow)))
			listing := git(nil, "ls-tree", "-rz", "--full-tree", "HEAD")
			if mode == "git_metadata_path" {
				// Native Git itself refuses to archive the forged .git tree;
				// a failed native export cannot be replaced with another source.
				if _, err := preparedGitCommand(t.Context(), dir, 4<<20, "archive", "--format=tar", "HEAD"); err == nil || requests.Load() != 0 {
					t.Fatal("native Git exported source-controlled Git metadata")
				}
				return
			}
			reader := tar.NewReader(bytes.NewReader(git(nil, "archive", "--format=tar", "HEAD")))
			var archive bytes.Buffer
			writer := tar.NewWriter(&archive)
			for {
				header, err := reader.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				if header.Typeflag == tar.TypeXGlobalHeader {
					continue // Native provider archive projection omits global metadata.
				}
				header.Name = strings.TrimSuffix(header.Name, "/")
				header.PAXRecords = nil
				if writer.WriteHeader(header) != nil {
					t.Fatal("owned archive projection")
				}
				if _, err := io.Copy(writer, reader); err != nil {
					t.Fatal(err)
				}
			}
			if writer.Close() != nil {
				t.Fatal("owned archive closure")
			}
			digest := sha256.Sum256(archive.Bytes())
			err := verifyGitSnapshot(archive.Bytes(), listing, hex.EncodeToString(digest[:]), h, workflow, blob)
			want := mode == "nested" || mode == "lfs_pointer" || mode == "hostile_local_config"
			if (err == nil) != want || requests.Load() != 0 {
				t.Fatal("native source boundary transformed source or contacted a source-controlled private endpoint")
			}
		})
	}
}

package runner

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"
)

func sourceEnvelopeFixture(t *testing.T, format string) (*GitSourceManifest, GitPreparationResult, []byte) {
	t.Helper()
	p, _ := nativePreparationFixture(t, format)
	docker, _ := preparationDocker(t, "")
	e, err := New(Config{WorkerID: "worker", DockerBinary: docker, ApprovedImages: []string{p.ImageDigest}})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := e.PrepareGit(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	writer := tar.NewWriter(&archive)
	for _, file := range []struct{ name, body string }{{"README.md", "controlled source\n"}, {"workflow.yml", "name: controlled\n"}} {
		if err = writer.WriteHeader(&tar.Header{Name: file.name, Typeflag: tar.TypeReg, Mode: 0644, Size: int64(len(file.body))}); err != nil {
			t.Fatal(err)
		}
		writer.Write([]byte(file.body))
	}
	writer.Close()
	digest := sha256.Sum256(archive.Bytes())
	manifest, err := NewGitSourceManifest(prepared, archive.Bytes(), hex.EncodeToString(digest[:]), p.CommitID, p.WorkflowPath, p.WorkflowBlobID)
	if err != nil {
		t.Fatal(err)
	}
	return manifest, prepared, archive.Bytes()
}

func TestGitSourceEnvelopeNativeIdentity(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			m, p, archive := sourceEnvelopeFixture(t, format)
			if err := ValidateGitSource(m, p.Metadata, archive, m.CommitID, m.WorkflowPath, m.WorkflowBlobID); err != nil {
				t.Fatal(err)
			}
			if m.Profile != GitSourceProfile || m.TreeID != p.TreeID || m.ArchiveSHA256 == m.MetadataSHA256 {
				t.Fatal("source identities conflated")
			}
			sourceBefore := append([]byte(nil), archive...)
			metadataBefore := append([]byte(nil), p.Metadata...)
			for _, tc := range []struct {
				name   string
				mutate func(*GitSourceManifest)
			}{
				{"profile", func(m *GitSourceManifest) { m.Profile = "arbitrary" }},
				{"commit", func(m *GitSourceManifest) { m.CommitID = strings.Repeat("0", len(m.CommitID)) }},
				{"tree_format", func(m *GitSourceManifest) { m.TreeID = "tag" }},
				{"archive", func(m *GitSourceManifest) { m.ArchiveSHA256 = strings.Repeat("0", 64) }},
				{"workflow", func(m *GitSourceManifest) { m.WorkflowPath = "README.md" }},
				{"blob", func(m *GitSourceManifest) { m.WorkflowBlobID = m.CommitID }},
				{"metadata", func(m *GitSourceManifest) { m.MetadataSHA256 = strings.Repeat("0", 64) }},
			} {
				t.Run(tc.name, func(t *testing.T) {
					changed := *m
					tc.mutate(&changed)
					if !errors.Is(ValidateGitSource(&changed, p.Metadata, archive, m.CommitID, m.WorkflowPath, m.WorkflowBlobID), ErrSource) {
						t.Fatal("foreign identity accepted")
					}
				})
			}
			if ValidateGitSource(nil, p.Metadata, archive, m.CommitID, m.WorkflowPath, m.WorkflowBlobID) == nil {
				t.Fatal("missing manifest accepted")
			}
			changedSource := append([]byte(nil), archive...)
			changedSource[len(changedSource)/2] ^= 1
			if ValidateGitSource(m, p.Metadata, changedSource, m.CommitID, m.WorkflowPath, m.WorkflowBlobID) == nil {
				t.Fatal("changed original archive accepted")
			}
			if !bytes.Equal(sourceBefore, archive) || !bytes.Equal(metadataBefore, p.Metadata) {
				t.Fatal("validation mutated source")
			}
		})
	}
}

func TestGitSourceEnvelopeClosedMetadata(t *testing.T) {
	m, p, archive := sourceEnvelopeFixture(t, "sha1")
	for _, mode := range []string{"credentials", "owner", "writable", "remote", "duplicate", "link", "padding", "wrongpackpath", "changedindex"} {
		t.Run(mode, func(t *testing.T) {
			reader := tar.NewReader(bytes.NewReader(p.Metadata))
			var raw bytes.Buffer
			writer := tar.NewWriter(&raw)
			for {
				h, err := reader.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(reader)
				if err != nil {
					t.Fatal(err)
				}
				if h.Name == ".git/HEAD" {
					if mode == "owner" {
						h.Uid = 1000
					}
					if mode == "writable" {
						h.Mode = 0644
					}
					if mode == "link" {
						h.Typeflag = tar.TypeSymlink
						h.Linkname = "/private"
						h.Size = 0
						data = nil
					}
				}
				if strings.HasSuffix(h.Name, ".pack") && mode == "wrongpackpath" {
					h.Name = ".git/objects/pack/pack-" + strings.Repeat("0", 40) + ".pack"
				}
				if strings.HasSuffix(h.Name, ".idx") && mode == "changedindex" {
					data[12] ^= 1
				}
				if err = writer.WriteHeader(h); err != nil {
					t.Fatal(err)
				}
				writer.Write(data)
				if mode == "duplicate" && h.Name == ".git/HEAD" {
					writer.WriteHeader(h)
					writer.Write(data)
				}
			}
			if mode == "credentials" || mode == "remote" {
				name := ".git/config"
				if mode == "credentials" {
					name = ".git/credentials"
				}
				writer.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0444, Size: 1})
				writer.Write([]byte("x"))
			}
			writer.Close()
			if mode == "padding" {
				raw.Write(make([]byte, 512))
			}
			changed := *m
			sum := sha256.Sum256(raw.Bytes())
			changed.MetadataSHA256 = hex.EncodeToString(sum[:])
			if ValidateGitSource(&changed, raw.Bytes(), archive, m.CommitID, m.WorkflowPath, m.WorkflowBlobID) == nil {
				t.Fatal("noncanonical or foreign metadata accepted despite matching metadata SHA")
			}
		})
	}
}

func TestGitSourceSnapshotMaterializationBoundary(t *testing.T) {
	m, p, archive := sourceEnvelopeFixture(t, "sha1")
	for _, name := range []string{".git", ".GIT/config", "nested/.git /config", "nested/.git./config", "nested/.g\u200cit/config", "README.md.", "README.md "} {
		t.Run(name, func(t *testing.T) {
			if ValidGitSourcePath(name) {
				t.Fatal("metadata alias admitted")
			}
		})
	}
	// A forged case-colliding listing is rejected even when each row is regular.
	listing := append([]byte(nil), p.Listing...)
	for _, row := range bytes.Split(p.Listing[:len(p.Listing)-1], []byte{0}) {
		if bytes.HasSuffix(row, []byte("\tREADME.md")) {
			listing = append(listing, bytes.Replace(row, []byte("\tREADME.md"), []byte("\treadme.md"), 1)...)
			listing = append(listing, 0)
			break
		}
	}
	if VerifyGitSourceSnapshot(archive, listing, m.ArchiveSHA256, m.CommitID, m.WorkflowPath, m.WorkflowBlobID) == nil {
		t.Fatal("case-colliding source accepted")
	}
	bad := p
	bad.Listing = listing
	if _, err := NewGitSourceManifest(bad, archive, m.ArchiveSHA256, m.CommitID, m.WorkflowPath, m.WorkflowBlobID); err == nil {
		t.Fatal("manifest bypassed source tree comparison")
	}
}

// Actual tar bytes distinguish confined certificate links from links that can
// redirect native extraction or later file reads outside the admitted source.
func TestGitSourceContainedLinks(t *testing.T) {
	for _, target := range []string{"../ordinary/ca", "../../private", "/private", "../link/../ordinary/ca", "../missing"} {
		var body bytes.Buffer
		writer := tar.NewWriter(&body)
		for _, h := range []*tar.Header{
			{Name: "ordinary", Typeflag: tar.TypeDir, Mode: 0755},
			{Name: "ordinary/ca", Typeflag: tar.TypeReg, Mode: 0644, Size: 1},
			{Name: "cert", Typeflag: tar.TypeDir, Mode: 0755},
			{Name: "cert/ca", Typeflag: tar.TypeSymlink, Mode: 0777, Linkname: target},
		} {
			if writer.WriteHeader(h) != nil {
				t.Fatal("tar header")
			}
			if h.Size == 1 {
				writer.Write([]byte("x"))
			}
		}
		writer.Close()
		if (ValidateGitSourceArchive(body.Bytes()) == nil) != (target == "../ordinary/ca") {
			t.Fatal("link containment differs", target)
		}
	}
}

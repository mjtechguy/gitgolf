package server

import (
	"archive/tar"
	"bytes"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
)

func TestWorkflowSourceRemoteContainedLinks(t *testing.T) {
	for _, target := range []string{"../ordinary/", "/outside", "../../outside", "../missing"} {
		var archive bytes.Buffer
		writer := tar.NewWriter(&archive)
		for _, header := range []*tar.Header{
			{Name: "repo/", Typeflag: tar.TypeDir, Mode: 0755},
			{Name: "repo/ordinary/", Typeflag: tar.TypeDir, Mode: 0755},
			{Name: "repo/certs/", Typeflag: tar.TypeDir, Mode: 0755},
			{Name: "repo/certs/ca", Typeflag: tar.TypeSymlink, Mode: 0777, Linkname: target},
		} {
			if writer.WriteHeader(header) != nil {
				t.Fatal("tar header")
			}
		}
		writer.Close()
		if _, err := normalizeWorkflowSource(bytes.NewReader(archive.Bytes()), strings.Repeat("a", 40), "", "", nil); err == nil {
			t.Fatal("legacy source profile silently widened")
		}
		_, err := normalizeWorkflowSourceProfile(bytes.NewReader(archive.Bytes()), strings.Repeat("a", 40), "", "", nil, true)
		if (err == nil) != (target == "../ordinary/") {
			t.Fatal("contained remote source link differs", target, err)
		}
	}
}

// Stable pages are important here: each request recreates an immutable fixture
// from a map, and native direct-tree paging must not reorder it between reads.
func workflowSourceObjects(commit string, files map[string]string, kinds map[string]string) *sourceObjectFixture {
	objects := newSourceObjectFixture(commit, files, kinds)
	ordered := func(rows []sourceTreeEntry) {
		sort.Slice(rows, func(i, j int) bool { return rows[i].Path < rows[j].Path })
	}
	ordered(objects.root)
	for _, rows := range objects.trees {
		ordered(rows)
	}
	return objects
}

// A SHA-looking branch's contents endpoint must never provide workflow bytes.
func TestWorkflowSourceExactObjectsAndAdmission(t *testing.T) {
	for _, mode := range []string{"ordinary", "symlink", "submodule", "oversize", "lfs", "lfs-crlf", "corrupt"} {
		t.Run(mode, func(t *testing.T) {
			const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			text, kind := workflowActionsFixture, ""
			switch mode {
			case "symlink", "submodule":
				kind = mode
			case "oversize":
				text = strings.Repeat("x", maxWorkflowBytes+1)
			case "lfs", "lfs-crlf":
				text = "version https://git-lfs.github.com/spec/v1\noid sha256:" + strings.Repeat("b", 64) + "\nsize 99999999\n"
				if mode == "lfs-crlf" {
					text = strings.ReplaceAll(text, "\n", "\r\n")
				}
			}
			objects := workflowSourceObjects(commit, map[string]string{runWorkflowPath: text}, map[string]string{runWorkflowPath: kind})
			var blobReads, mutableReads atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/contents-ext") {
					mutableReads.Add(1)
					http.Error(w, "shadow branch bytes", http.StatusInternalServerError)
					return
				}
				if strings.Contains(r.URL.Path, "/git/blobs/") {
					blobReads.Add(1)
					if mode == "corrupt" {
						for id, data := range objects.blobs {
							objects.blobs[id] = []byte(strings.Repeat("z", len(data)))
						}
					}
				}
				if !objects.serve(w, r, "/api/v1/repos/alice/example") {
					t.Error("unexpected workflow source endpoint")
					w.WriteHeader(500)
				}
			}))
			defer provider.Close()
			server, err := New(testConfig(provider.URL), nil)
			if err != nil {
				t.Fatal(err)
			}
			token := forgeCredential{Kind: "pat", Token: "workflow-source-fixture"}
			metadata, err := server.workflowContents(t.Context(), token, "/repos/alice/example", commit, runWorkflowPath, false)
			if err != nil || metadata.File == nil || metadata.File.SHA != sourceBlobHash([]byte(text), 40) || blobReads.Load() != 0 {
				t.Fatal("metadata source or premature content read", err)
			}
			content, err := server.workflowContents(t.Context(), token, "/repos/alice/example", commit, runWorkflowPath, true)
			if mode == "corrupt" {
				if err == nil {
					t.Fatal("corrupted workflow object accepted")
				}
			} else {
				if err != nil || content.File == nil {
					t.Fatal("source read", err)
				}
				if kind != "" || mode == "oversize" {
					if blobReads.Load() != 0 || content.File.Content != "" || content.File.Encoding != "" {
						t.Fatal("unsupported metadata triggered blob fetch")
					}
				} else {
					data, err := base64.StdEncoding.DecodeString(content.File.Content)
					if err != nil || string(data) != text || blobReads.Load() != 1 {
						t.Fatal("workflow source bytes changed", err)
					}
					if strings.HasPrefix(mode, "lfs") && (!workflowLFSPointer(data) || content.File.LFSOID != strings.Repeat("b", 64)) {
						t.Fatal("LFS pointer metadata lost")
					}
				}
			}
			if mutableReads.Load() != 0 {
				t.Fatal("mutable source endpoint used")
			}
			_, err = server.workflowContents(t.Context(), token, "/repos/alice/example", commit, "absent.yml", false)
			if !workflowMissing(err) {
				t.Fatal("exact path absence lost", err)
			}
		})
	}
}

func TestWorkflowSourceMalformedLFSDeniesRunPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	// Native trees cannot report LFS metadata, and a malformed pointer has no
	// valid OID to retain. The raw source prefix still forbids execution.
	f.mu.Lock()
	f.workflow = []byte("version https://git-lfs.github.com/spec/v1\r\noid sha256:invalid\r\nsize 99999999\r\n")
	f.mu.Unlock()
	_, _, plan, snapshot, err := f.server.prepareWorkflowRun(t.Context(), forgeCredential{Kind: "pat", Token: "run-fixture"}, repositoryKey{Owner: "alice", Name: "example"}, f.commit, runWorkflowPath)
	if !errors.Is(err, errWorkflowExecutionUnsupported) || plan != nil || snapshot != nil {
		t.Fatal("malformed LFS source prepared execution", err)
	}
	if _, err = f.dispatch(t, "12345678-1234-4234-8234-123456789abc"); err == nil {
		t.Fatal("malformed LFS source admitted run")
	}
	if f.archives != 0 {
		t.Fatal("LFS source fetched execution archive")
	}
	var runs int
	if err = f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_runs`).Scan(&runs); err != nil || runs != 0 {
		t.Fatal("LFS refusal persisted run", runs, err)
	}
}

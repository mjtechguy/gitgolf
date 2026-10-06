package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func batchFixtureRequest() *golfv1.SubmitRepositoryFileBatchRequest {
	return &golfv1.SubmitRepositoryFileBatchRequest{Repository: pullKey, RepositoryId: "11", OwnerId: "42", AccessRevision: strings.Repeat("a", 64), OperationId: uuid.NewString(), Branch: "main", ExpectedCommitId: strings.Repeat("c", 40), CommitMessage: "One exact native batch", CommitMessageSha256: fileMutationHash([]byte("One exact native batch")), Changes: []*golfv1.RepositoryFileBatchChange{{Kind: 1, Path: "new.txt", Content: []byte("new bytes"), ContentSha256: fileMutationHash([]byte("new bytes"))}, {Kind: 2, Path: "renamed.txt", FromPath: "old.txt", ExpectedBlobId: sourceBlobHash([]byte("old"), 40), Content: []byte("renamed"), ContentSha256: fileMutationHash([]byte("renamed"))}, {Kind: 3, Path: "delete.txt", ExpectedBlobId: sourceBlobHash([]byte("delete"), 40), ContentSha256: fileMutationHash(nil)}}}
}
func TestFileBatchInputAndOriginal(t *testing.T) {
	m := batchFixtureRequest()
	if e := validateFileBatch(m, false); e != nil {
		t.Fatal(e)
	}
	original := fileBatchOriginal(m)
	if bytes.Contains(original, []byte("new bytes")) || bytes.Contains(original, []byte(m.CommitMessage)) {
		t.Fatal("plaintext retained")
	}
	r := new(golfv1.SubmitRepositoryFileBatchRequest)
	if proto.Unmarshal(original, r) != nil || validateFileBatch(r, true) != nil {
		t.Fatal("retained metadata")
	}
	for _, change := range []func(*golfv1.SubmitRepositoryFileBatchRequest){func(m *golfv1.SubmitRepositoryFileBatchRequest) { m.Changes[1].Path = m.Changes[0].Path }, func(m *golfv1.SubmitRepositoryFileBatchRequest) { m.Changes[0].Path = ".git/config" }, func(m *golfv1.SubmitRepositoryFileBatchRequest) { m.Changes[0].Path = "old.txt/child" }, func(m *golfv1.SubmitRepositoryFileBatchRequest) {
		m.Changes[0].Content = make([]byte, maxPreviewBytes+1)
	}, func(m *golfv1.SubmitRepositoryFileBatchRequest) { m.Changes[1].FromPath = m.Changes[1].Path }, func(m *golfv1.SubmitRepositoryFileBatchRequest) { m.Changes[0].ContentSha256 = strings.Repeat("f", 64) }, func(m *golfv1.SubmitRepositoryFileBatchRequest) { m.CommitMessage += "changed" }} {
		c := proto.Clone(m).(*golfv1.SubmitRepositoryFileBatchRequest)
		change(c)
		if validateFileBatch(c, false) == nil {
			t.Fatal("invalid batch accepted")
		}
	}
	payload, _ := json.Marshal(fileBatchNative(m))
	if strings.Contains(string(payload), "last_commit") || strings.Contains(string(payload), "author") || !strings.Contains(string(payload), `"from_path":"old.txt"`) {
		t.Fatal("invented native batch", string(payload))
	}
}
func TestFileBatchJournalAndUncertaintyPostgres(t *testing.T) {
	for _, mode := range []string{"", "lost", "ignored", "wrong-parent", "protected", "stale"} {
		t.Run(mode, func(t *testing.T) {
			f := newFileMutationFixture(t, 1)
			native, _ := url.Parse(f.s.config.GiteaURL)
			proxy := httputil.NewSingleHostReverseProxy(native)
			files := map[string][]byte{"old.txt": []byte("old"), "delete.txt": []byte("delete")}
			writes := 0
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				base := "/api/v1/repos/alice/private"
				w.Header().Set("Content-Type", "application/json")
				if strings.HasPrefix(r.URL.Path, base+"/git/trees/") {
					rows := []sourceTreeEntry{}
					for p, b := range files {
						rows = append(rows, sourceTreeEntry{Path: p, Mode: "100644", Type: "blob", SHA: sourceBlobHash(b, 40), Size: int64(len(b))})
					}
					json.NewEncoder(w).Encode(sourceTree{SHA: strings.TrimPrefix(r.URL.Path, base+"/git/trees/"), Entries: rows, Page: 1, Total: len(rows)})
					return
				}
				if strings.HasPrefix(r.URL.Path, base+"/git/blobs/") {
					for _, b := range files {
						sha := sourceBlobHash(b, 40)
						if sha == strings.TrimPrefix(r.URL.Path, base+"/git/blobs/") {
							json.NewEncoder(w).Encode(map[string]any{"sha": sha, "size": len(b), "encoding": "base64", "content": base64.StdEncoding.EncodeToString(b)})
							return
						}
					}
					w.WriteHeader(404)
					return
				}
				if r.URL.Path == base+"/contents" && r.Method == "POST" {
					writes++
					var payload struct {
						Message string
						Files   []struct{ Operation, Path, FromPath, SHA, Content string }
					}
					var raw map[string]json.RawMessage
					json.NewDecoder(r.Body).Decode(&raw)
					json.Unmarshal(raw["message"], &payload.Message)
					var specs []map[string]string
					json.Unmarshal(raw["files"], &specs)
					if mode != "ignored" {
						for _, c := range specs {
							if c["operation"] == "delete" {
								delete(files, c["path"])
							} else {
								b, _ := base64.StdEncoding.DecodeString(c["content"])
								files[c["path"]] = b
								if c["from_path"] != "" {
									delete(files, c["from_path"])
								}
							}
						}
						f.mu.Lock()
						f.head = strings.Repeat("d", 40)
						f.mu.Unlock()
					}
					if mode == "lost" {
						w.WriteHeader(500)
						return
					}
					parent := strings.Repeat("c", 40)
					if mode == "wrong-parent" {
						parent = strings.Repeat("f", 40)
					}
					w.WriteHeader(201)
					json.NewEncoder(w).Encode(map[string]any{"commit": map[string]any{"sha": strings.Repeat("d", 40), "message": payload.Message + "\n", "parents": []any{map[string]string{"sha": parent}}}})
					return
				}
				proxy.ServeHTTP(w, r)
			}))
			t.Cleanup(provider.Close)
			config := f.s.config
			config.GiteaURL = provider.URL
			config.GiteaPublicURL = provider.URL
			var e error
			f.s, e = New(config, f.db)
			if e != nil {
				t.Fatal(e)
			}
			session := f.session(t, "pat")
			m := batchFixtureRequest()
			m.AccessRevision = f.request(t, session).AccessRevision
			if mode == "protected" {
				f.fileMode.Store("protected")
			}
			if mode == "stale" {
				m.ExpectedCommitId = strings.Repeat("f", 40)
			}
			ctx, _, h := f.scope(session)
			submit := func() (*golfv1.RepositoryFileBatchOperation, error) {
				req := connect.NewRequest(m)
				req.Header().Set("Cookie", h.Get("Cookie"))
				req.Header().Set("Origin", h.Get("Origin"))
				r, e := f.s.SubmitRepositoryFileBatch(ctx, req)
				if e != nil {
					return nil, e
				}
				return r.Msg.Operation, nil
			}
			first, e := submit()
			if mode == "protected" || mode == "stale" {
				if e == nil || writes != 0 {
					t.Fatal("preflight dispatched", e, writes)
				}
				return
			}
			want := golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_SUCCEEDED
			if mode != "" {
				want = golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_DISPATCH_UNKNOWN
			}
			if e != nil || first == nil || first.Phase != want {
				t.Fatal("batch outcome", e, first)
			}
			again, e := submit()
			if e != nil || !proto.Equal(first, again) || writes != 1 {
				t.Fatal("original resent", e, writes)
			}
			var signals int
			if e = f.db.QueryRow(`SELECT count(*) FROM golf_repository_activity`).Scan(&signals); e != nil || mode == "" && signals != 1 || mode != "" && signals != 0 {
				t.Fatal("unqualified or duplicate activity", e, signals)
			}
			if _, e = f.db.Exec(`UPDATE golf_repository_file_mutations SET batch_original='changed'::bytea`); e == nil {
				t.Fatal("batch original mutable")
			}
			m.OperationId = uuid.NewString()
			if mode != "" {
				if _, e = submit(); e == nil || writes != 1 {
					t.Fatal("unknown overlapping dispatch")
				}
			}
		})
	}
}

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
)

func TestAttachmentUploadBoundOriginal(t *testing.T) {
	m := &golfv1.SubmitDiscussionAttachmentUploadRequest{Target: &golfv1.DiscussionTarget{Repository: pullKey, RepositoryId: "11", IssueId: "77", Number: 7, PullRequest: true}, ExpectedTargetRevision: strings.Repeat("a", 64), ExpectedAttachmentsRevision: strings.Repeat("b", 64), OperationId: uuid.NewString(), Name: "雪%25.txt", Content: []byte("private bytes"), ContentSha256: fileMutationHash([]byte("private bytes")), ContentSizeBytes: 13}
	if e := validateAttachmentUpload(m, false); e != nil {
		t.Fatal(e)
	}
	original := attachmentUploadOriginalBytes(m)
	if bytes.Contains(original, m.Content) {
		t.Fatal("bytes retained")
	}
	retained := new(golfv1.SubmitDiscussionAttachmentUploadRequest)
	proto.Unmarshal(original, retained)
	if e := validateAttachmentUpload(retained, true); e != nil {
		t.Fatal(e)
	}
	for _, change := range []func(*golfv1.SubmitDiscussionAttachmentUploadRequest){func(m *golfv1.SubmitDiscussionAttachmentUploadRequest) { m.Name = "../outside" }, func(m *golfv1.SubmitDiscussionAttachmentUploadRequest) { m.ContentSizeBytes = 0 }, func(m *golfv1.SubmitDiscussionAttachmentUploadRequest) { m.ContentSha256 = strings.Repeat("f", 64) }, func(m *golfv1.SubmitDiscussionAttachmentUploadRequest) { m.Content = make([]byte, maxPreviewBytes+1) }, func(m *golfv1.SubmitDiscussionAttachmentUploadRequest) { m.Target.IssueId = "0" }} {
		c := proto.Clone(m).(*golfv1.SubmitDiscussionAttachmentUploadRequest)
		change(c)
		if validateAttachmentUpload(c, false) == nil {
			t.Fatal("malformed upload accepted")
		}
	}
	c := proto.Clone(m).(*golfv1.SubmitDiscussionAttachmentUploadRequest)
	c.OperationId = uuid.NewString()
	if !bytes.Equal(attachmentUploadFingerprint(m), attachmentUploadFingerprint(c)) {
		t.Fatal("operation key fingerprint")
	}
	c.Target.CommentId = "31"
	if bytes.Equal(attachmentUploadFingerprint(m), attachmentUploadFingerprint(c)) {
		t.Fatal("unbound comment target")
	}
}
func TestAttachmentUploadJournalPostgres(t *testing.T) {
	for _, mode := range []string{"body", "comment", "lost", "ignored", "wrong-bytes", "late-denied", "disabled", "stale"} {
		t.Run(mode, func(t *testing.T) {
			f := newEngagementFixture(t)
			var mu sync.Mutex
			version := int64(1)
			writes := 0
			var asset *forgeReleaseDownloadAsset
			var content []byte
			blocked := false
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				base := "/api/v1/repos/alice/private"
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/v1/user" {
					json.NewEncoder(w).Encode(map[string]any{"id": 42, "login": "alice", "is_admin": false})
					return
				}
				if r.URL.Path == "/api/v1/settings/attachment" {
					json.NewEncoder(w).Encode(map[string]any{"enabled": mode != "disabled", "allowed_types": "*/*", "max_size": 4})
					return
				}
				if r.URL.Path == base {
					mu.Lock()
					deny := blocked
					mu.Unlock()
					if deny {
						w.WriteHeader(404)
						return
					}
					row := settingsFixtureRow()
					row.ID = 11
					row.Name = "private"
					row.FullName = "alice/private"
					row.HTMLURL = "https://forge.invalid/alice/private"
					data, _ := json.Marshal(row)
					var value map[string]any
					json.Unmarshal(data, &value)
					value["permissions"] = map[string]bool{"admin": true, "push": true, "pull": true}
					value["owner"] = map[string]any{"id": 42, "login": "alice"}
					value["has_issues"] = true
					value["has_pull_requests"] = true
					json.NewEncoder(w).Encode(value)
					return
				}
				if r.URL.Path == base+"/issues/7" {
					rec := httptest.NewRecorder()
					f.serveEngagement(rec, r)
					var value map[string]any
					json.Unmarshal(rec.Body.Bytes(), &value)
					mu.Lock()
					value["content_version"] = version
					mu.Unlock()
					w.WriteHeader(rec.Code)
					json.NewEncoder(w).Encode(value)
					return
				}
				if strings.Contains(r.URL.Path, "/assets") {
					if r.Method == "POST" {
						file, header, e := r.FormFile("attachment")
						if e != nil {
							t.Error(e)
							w.WriteHeader(500)
							return
						}
						data, _ := io.ReadAll(file)
						file.Close()
						mu.Lock()
						writes++
						row := releaseDownloadFixture()
						row.ID = 91
						row.Name = header.Filename
						size := int64(len(data))
						row.Size = &size
						if mode != "ignored" {
							asset = &row
							content = append([]byte(nil), data...)
							if mode != "comment" {
								version++
							}
						}
						if mode == "late-denied" {
							blocked = true
						}
						mu.Unlock()
						if mode == "lost" {
							w.WriteHeader(500)
							return
						}
						w.WriteHeader(201)
						json.NewEncoder(w).Encode(row)
						return
					}
					mu.Lock()
					var row *forgeReleaseDownloadAsset
					if asset != nil {
						copy := *asset
						row = &copy
					}
					mu.Unlock()
					if strings.HasSuffix(r.URL.Path, "/assets") {
						rows := []forgeReleaseDownloadAsset{}
						if row != nil {
							rows = append(rows, *row)
						}
						json.NewEncoder(w).Encode(rows)
						return
					}
					if row == nil {
						w.WriteHeader(404)
						return
					}
					json.NewEncoder(w).Encode(row)
					return
				}
				if strings.HasPrefix(r.URL.Path, "/attachments/") {
					mu.Lock()
					data := append([]byte(nil), content...)
					mu.Unlock()
					if r.Header.Get("Authorization") != "Bearer pull-pat" {
						t.Error("raw native credential boundary")
					}
					if mode == "wrong-bytes" && len(data) > 0 {
						data[0] ^= 1
					}
					w.Write(data)
					return
				}
				f.serveEngagement(w, r)
			}))
			t.Cleanup(provider.Close)
			config := f.s.config
			config.ForgeURL = provider.URL
			config.ForgePublicURL = provider.URL
			var e error
			f.s, e = New(config, f.db)
			if e != nil {
				t.Fatal(e)
			}
			session := f.session(t, "pat")
			_, _, _, transport, origin := testRPCClients(t, f.s)
			transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
			client := golfv1connect.NewDiscussionAttachmentUploadServiceClient(transport, origin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
				return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
					req.Header().Set("Origin", f.s.config.PublicURL)
					return next(ctx, req)
				}
			})))
			target := &golfv1.DiscussionTarget{Repository: pullKey, RepositoryId: "11", IssueId: "77", Number: 7, PullRequest: true}
			if mode == "comment" {
				target.CommentId = "31"
			}
			state, e := client.GetDiscussionAttachmentUploadState(t.Context(), connect.NewRequest(&golfv1.GetDiscussionAttachmentUploadStateRequest{Target: target}))
			if e != nil {
				t.Fatal("state", e)
			}
			if state.Msg.CanUpload == (mode == "disabled") {
				t.Fatal("capability", state.Msg)
			}
			m := &golfv1.SubmitDiscussionAttachmentUploadRequest{Target: target, ExpectedTargetRevision: state.Msg.TargetRevision, ExpectedAttachmentsRevision: state.Msg.AttachmentsRevision, OperationId: uuid.NewString(), Name: "exact.txt", Content: []byte("uploaded"), ContentSha256: fileMutationHash([]byte("uploaded")), ContentSizeBytes: 8}
			if mode == "stale" {
				m.ExpectedTargetRevision = strings.Repeat("f", 64)
			}
			first, e := client.SubmitDiscussionAttachmentUpload(t.Context(), connect.NewRequest(m))
			mu.Lock()
			count := writes
			mu.Unlock()
			if mode == "stale" || mode == "disabled" {
				if e == nil || count != 0 {
					t.Fatal("preflight dispatched", e, count)
				}
				return
			}
			if mode == "late-denied" {
				if e == nil || count != 1 {
					t.Fatal("late denial exposed metadata", e, count)
				}
				var phase string
				f.db.QueryRow(`SELECT phase FROM golf_attachment_upload_operations`).Scan(&phase)
				if phase != "DISPATCH_UNKNOWN" {
					t.Fatal("late denial lost original", phase)
				}
				return
			}
			want := golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED
			if mode != "body" && mode != "comment" {
				want = golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_DISPATCH_UNKNOWN
			}
			if e != nil || first.Msg.Operation.Phase != want {
				t.Fatal("outcome", e, first)
			}
			again, e := client.SubmitDiscussionAttachmentUpload(t.Context(), connect.NewRequest(m))
			mu.Lock()
			count = writes
			mu.Unlock()
			if e != nil || !proto.Equal(first.Msg.Operation, again.Msg.Operation) || count != 1 {
				t.Fatal("resent original", e, count)
			}
			if _, e = f.db.Exec(`UPDATE golf_attachment_upload_operations SET original='changed'::bytea`); e == nil {
				t.Fatal("mutable upload original")
			}
			if _, e = f.db.Exec(`DELETE FROM golf_attachment_upload_events`); e == nil {
				t.Fatal("deleted audit")
			}
			var signals int
			f.db.QueryRow(`SELECT count(*) FROM golf_repository_activity`).Scan(&signals)
			if want == golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED && signals != 1 || want != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED && signals != 0 {
				t.Fatal("unverified/duplicate activity", signals)
			}
			if want != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
				m.OperationId = uuid.NewString()
				if _, e = client.SubmitDiscussionAttachmentUpload(t.Context(), connect.NewRequest(m)); e == nil {
					t.Fatal("overlapping unknown upload")
				}
			}
		})
	}
}

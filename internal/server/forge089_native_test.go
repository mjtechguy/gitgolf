package server

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
)

func qualifyForge089Native(t *testing.T, s *Server, httpClient *http.Client, origin *url.URL, owner forgeCredential, key *golfv1.RepositoryKey, pull *golfv1.PullReviewDraftTarget, branch string) {
	t.Helper()
	base, _ := repositoryPath(keyFrom(key))
	ctx := t.Context()
	accessClient := golfv1connect.NewRepositoryAccessServiceClient(httpClient, origin.String()+"/rpc")
	accessReq := connect.NewRequest(&golfv1.GetRepositoryAccessRequest{Repository: key})
	accessReq.Header().Set("Origin", s.config.PublicURL)
	access, e := accessClient.GetRepositoryAccess(ctx, accessReq)
	if e != nil {
		t.Fatalf("Native file batch access %s", connect.CodeOf(e))
	}
	head, e := s.exactSourceBranch(ctx, base, owner, branch)
	if e != nil {
		t.Fatal("Native file batch original")
	}
	if _, e := s.forgeJSON(ctx, http.MethodPost, base+"/branches", owner, map[string]string{"new_branch_name": "forge-batch089", "old_ref_name": head}, nil, http.StatusCreated); e != nil {
		t.Fatal("Native batch fixture branch")
	}
	branch = "forge-batch089"
	batchClient := golfv1connect.NewRepositoryFileBatchServiceClient(httpClient, origin.String()+"/rpc")
	submit := func(m *golfv1.SubmitRepositoryFileBatchRequest) *golfv1.RepositoryFileBatchOperation {
		t.Helper()
		req := connect.NewRequest(m)
		req.Header().Set("Origin", s.config.PublicURL)
		out, e := batchClient.SubmitRepositoryFileBatch(ctx, req)
		if e != nil || out.Msg.Operation.Phase != golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_SUCCEEDED {
			t.Fatalf("Native file batch submit %s %#v", connect.CodeOf(e), out)
		}
		replay := connect.NewRequest(m)
		replay.Header().Set("Origin", s.config.PublicURL)
		again, e := batchClient.SubmitRepositoryFileBatch(ctx, replay)
		if e != nil || !proto.Equal(out.Msg.Operation, again.Msg.Operation) {
			t.Fatal("Native file batch original replay")
		}
		return out.Msg.Operation
	}
	change := func(k golfv1.RepositoryFileMutationKind, path, from, blob, content string) *golfv1.RepositoryFileBatchChange {
		return &golfv1.RepositoryFileBatchChange{Kind: k, Path: path, FromPath: from, ExpectedBlobId: blob, Content: []byte(content), ContentSha256: fileMutationHash([]byte(content))}
	}
	m := &golfv1.SubmitRepositoryFileBatchRequest{Repository: key, RepositoryId: pull.RepositoryId, OwnerId: access.Msg.Access.OwnerId, AccessRevision: access.Msg.Access.Revision, OperationId: uuid.NewString(), Branch: branch, ExpectedCommitId: head, CommitMessage: "Owned three-file native batch089", CommitMessageSha256: fileMutationHash([]byte("Owned three-file native batch089")), Changes: []*golfv1.RepositoryFileBatchChange{change(1, "batch089-a.txt", "", "", "first"), change(1, "batch089-雪%25.txt", "", "", "second"), change(1, "batch089-delete.txt", "", "", "third")}}
	first := submit(m)
	head = first.CommitId
	m.OperationId = uuid.NewString()
	m.ExpectedCommitId = head
	m.CommitMessage = "Owned rename update delete089"
	m.CommitMessageSha256 = fileMutationHash([]byte(m.CommitMessage))
	m.Changes = []*golfv1.RepositoryFileBatchChange{change(2, "batch089-renamed.txt", "batch089-a.txt", sourceBlobHash([]byte("first"), 40), "first"), change(2, "batch089-雪%25.txt", "", sourceBlobHash([]byte("second"), 40), "changed"), change(3, "batch089-delete.txt", "", sourceBlobHash([]byte("third"), 40), "")}
	second := submit(m)
	if second.CommitId == head {
		t.Fatal("Native batch commit did not change")
	}
	stale := proto.Clone(m).(*golfv1.SubmitRepositoryFileBatchRequest)
	stale.OperationId = uuid.NewString()
	req := connect.NewRequest(stale)
	req.Header().Set("Origin", s.config.PublicURL)
	if _, e = batchClient.SubmitRepositoryFileBatch(ctx, req); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatalf("Native batch stale head accepted %s", connect.CodeOf(e))
	}
	// Fixture attachment uses the supported API; product reads exercise current exact association.
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, e := writer.CreateFormFile("attachment", "owned-attachment089.txt")
	if e != nil {
		t.Fatal(e)
	}
	part.Write([]byte("owned attachment bytes089"))
	writer.Close()
	native, e := http.NewRequestWithContext(ctx, "POST", s.config.ForgeURL+"/api/v1"+base+"/issues/"+strconv.FormatUint(uint64(pull.Number), 10)+"/assets", &body)
	if e != nil {
		t.Fatal(e)
	}
	native.Header.Set("Authorization", "token "+owner.Token)
	native.Header.Set("Content-Type", writer.FormDataContentType())
	response, e := s.client.Do(native)
	if e != nil {
		t.Fatal("Native fixture attachment")
	}
	defer response.Body.Close()
	var attachment forgeReleaseDownloadAsset
	if response.StatusCode != 201 || json.NewDecoder(response.Body).Decode(&attachment) != nil {
		t.Fatalf("Native fixture attachment %d", response.StatusCode)
	}
	repo, e := s.readRepository(ctx, base, owner)
	if e != nil {
		t.Fatal("Native attachment repository")
	}
	issue, e := s.readDiscussionIssue(context.WithValue(ctx, pullDiscussionKey{}, true), owner, base, repo, pull.Number)
	if e != nil {
		t.Fatal("Native attachment discussion")
	}
	target := &golfv1.DiscussionTarget{Repository: key, RepositoryId: pull.RepositoryId, IssueId: strconv.FormatInt(issue.ID, 10), Number: pull.Number, PullRequest: true}
	client := golfv1connect.NewDiscussionAttachmentServiceClient(httpClient, origin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			req.Header().Set("Origin", s.config.PublicURL)
			return next(ctx, req)
		}
	})))
	listed, e := client.ListDiscussionAttachments(ctx, connect.NewRequest(&golfv1.ListDiscussionAttachmentsRequest{Target: target}))
	if e != nil || len(listed.Msg.Attachments) != 1 || listed.Msg.Attachments[0].Id != strconv.FormatInt(attachment.ID, 10) {
		t.Fatalf("Native attachment inventory %s", connect.CodeOf(e))
	}
	row := listed.Msg.Attachments[0]
	download, e := client.DownloadDiscussionAttachment(ctx, connect.NewRequest(&golfv1.DownloadDiscussionAttachmentRequest{Target: target, AttachmentId: row.Id, ExpectedRevision: row.Revision}))
	if e != nil || string(download.Msg.Content) != "owned attachment bytes089" || download.Msg.ContentSha256 != fileMutationHash(download.Msg.Content) {
		t.Fatalf("Native attachment download %s", connect.CodeOf(e))
	}
	wrong := proto.Clone(target).(*golfv1.DiscussionTarget)
	wrong.IssueId = "999999"
	if _, e = client.ListDiscussionAttachments(ctx, connect.NewRequest(&golfv1.ListDiscussionAttachmentsRequest{Target: wrong})); e == nil {
		t.Fatal("Native attachment wrong association accepted")
	}
	qualifyAttachmentUpload089Native(t, s, httpClient, origin, owner, key, target)
	// Keep fixture diagnostics free of volatile upload bytes and tokens.
}

func qualifyAttachmentUpload089Native(t *testing.T, s *Server, httpClient *http.Client, origin *url.URL, owner forgeCredential, key *golfv1.RepositoryKey, target *golfv1.DiscussionTarget) {
	t.Helper()
	ctx := t.Context()
	client := golfv1connect.NewDiscussionAttachmentUploadServiceClient(httpClient, origin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			req.Header().Set("Origin", s.config.PublicURL)
			return next(ctx, req)
		}
	})))
	submit := func(target *golfv1.DiscussionTarget, name string) {
		t.Helper()
		state, e := client.GetDiscussionAttachmentUploadState(ctx, connect.NewRequest(&golfv1.GetDiscussionAttachmentUploadStateRequest{Target: target}))
		if e != nil || !state.Msg.CanUpload {
			t.Fatalf("Native upload state %s %v", connect.CodeOf(e), e)
		}
		content := []byte("native uploaded exact bytes089")
		m := &golfv1.SubmitDiscussionAttachmentUploadRequest{Target: target, ExpectedTargetRevision: state.Msg.TargetRevision, ExpectedAttachmentsRevision: state.Msg.AttachmentsRevision, OperationId: uuid.NewString(), Name: name, Content: content, ContentSha256: fileMutationHash(content), ContentSizeBytes: uint64(len(content))}
		out, e := client.SubmitDiscussionAttachmentUpload(ctx, connect.NewRequest(m))
		if e != nil || out.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
			t.Fatalf("Native upload outcome %s %v %#v", connect.CodeOf(e), e, out)
		}
		again, e := client.SubmitDiscussionAttachmentUpload(ctx, connect.NewRequest(m))
		if e != nil || !proto.Equal(out.Msg.Operation, again.Msg.Operation) {
			t.Fatal("Native upload original resend/rebind")
		}
		inspected, e := client.GetDiscussionAttachmentUploadOperation(ctx, connect.NewRequest(&golfv1.GetDiscussionAttachmentUploadOperationRequest{Target: target, OperationId: m.OperationId}))
		if e != nil || !proto.Equal(out.Msg.Operation, inspected.Msg.Operation) {
			t.Fatal("Native upload original inspection")
		}
		m.OperationId = uuid.NewString()
		if _, e = client.SubmitDiscussionAttachmentUpload(ctx, connect.NewRequest(m)); connect.CodeOf(e) != connect.CodeFailedPrecondition {
			t.Fatalf("Native upload stale proposal accepted %s", connect.CodeOf(e))
		}
	}
	submit(target, "golf-uploaded-body089.txt")
	base, _ := repositoryPath(keyFrom(key))
	var comment forgeIssueComment
	if _, e := s.forgeJSON(ctx, http.MethodPost, base+"/issues/"+strconv.FormatUint(uint64(target.Number), 10)+"/comments", owner, map[string]string{"body": "Owned native comment089"}, &comment, http.StatusCreated); e != nil {
		t.Fatal("Native comment upload fixture")
	}
	commentTarget := proto.Clone(target).(*golfv1.DiscussionTarget)
	commentTarget.CommentId = strconv.FormatInt(comment.ID, 10)
	submit(commentTarget, "golf-uploaded-comment089.txt")
}

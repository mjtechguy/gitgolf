package server

import (
	"bytes"
	"strings"
	"testing"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func TestReviewAppendExactSavedIntent(t *testing.T) {
	m := &golfv1.SubmitPullReviewAuthoringOperationRequest{Target: authoringTarget(), Kind: authorAppend, ReviewId: "9", ReviewCommitId: strings.Repeat("a", 40), ExpectedPullRevision: strings.Repeat("b", 64), ExpectedSnapshotRevision: strings.Repeat("c", 64), OperationId: uuid.NewString(), GolfDraftId: uuid.NewString(), ExpectedDraftVersion: "3", ExpectedTargetGeneration: "4"}
	if e := validateReviewAuthoring(m); e != nil {
		t.Fatal(e)
	}
	method, path := authoringRoute("/repos/alice/private", m)
	if method != "POST" || path != "/repos/alice/private/pulls/7/reviews" {
		t.Fatal("append route", method, path)
	}
	for _, mutate := range []func(*golfv1.SubmitPullReviewAuthoringOperationRequest){func(m *golfv1.SubmitPullReviewAuthoringOperationRequest) { m.ReviewId = "10" }, func(m *golfv1.SubmitPullReviewAuthoringOperationRequest) { m.ExpectedDraftVersion = "4" }, func(m *golfv1.SubmitPullReviewAuthoringOperationRequest) {
		m.ExpectedSnapshotRevision = strings.Repeat("f", 64)
	}, func(m *golfv1.SubmitPullReviewAuthoringOperationRequest) { m.GolfDraftId = uuid.NewString() }} {
		c := proto.Clone(m).(*golfv1.SubmitPullReviewAuthoringOperationRequest)
		mutate(c)
		if bytes.Equal(reviewAuthoringFingerprint(c), reviewAuthoringFingerprint(m)) {
			t.Fatal("unbound append original")
		}
	}
	for _, mutate := range []func(*golfv1.SubmitPullReviewAuthoringOperationRequest){func(m *golfv1.SubmitPullReviewAuthoringOperationRequest) { m.ReviewId = "" }, func(m *golfv1.SubmitPullReviewAuthoringOperationRequest) { m.CommentId = "90" }, func(m *golfv1.SubmitPullReviewAuthoringOperationRequest) { m.Body = "replacement" }, func(m *golfv1.SubmitPullReviewAuthoringOperationRequest) { m.Decision = 1 }, func(m *golfv1.SubmitPullReviewAuthoringOperationRequest) { m.ExpectedTargetGeneration = "0" }} {
		c := proto.Clone(m).(*golfv1.SubmitPullReviewAuthoringOperationRequest)
		mutate(c)
		if validateReviewAuthoring(c) == nil {
			t.Fatal("malformed append accepted")
		}
	}
}

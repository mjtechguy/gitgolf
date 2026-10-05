package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func TestStandardMergeMethods(t *testing.T) {
	legacy := standardMergeFixtureRequest()
	original := standardMergeFingerprint(legacy)
	legacy.Method = "merge"
	if err := validateStandardMerge(legacy); err != nil || !bytes.Equal(original, standardMergeFingerprint(legacy)) {
		t.Fatal("explicit merge changed legacy intent", err)
	}
	legacy.Method = "squash"
	if err := validateStandardMerge(legacy); err != nil || bytes.Equal(original, standardMergeFingerprint(legacy)) {
		t.Fatal("squash did not bind method", err)
	}
	for _, method := range []string{"rebase", "Merge", " squash", "squash\x00"} {
		legacy.Method = method
		if validateStandardMerge(legacy) == nil {
			t.Fatal("unsupported method accepted")
		}
	}
	for _, method := range []string{"merge", "squash"} {
		allowed := &golfv1.RepositoryMergeConfiguration{AllowMergeCommits: method == "merge", AllowSquashMerge: method == "squash"}
		if !standardPullMergeAllowed(method, allowed) || standardPullMergeAllowed(map[string]string{"merge": "squash", "squash": "merge"}[method], allowed) {
			t.Fatal("method permission substituted")
		}
		record := standardMergeRecord{Method: method}
		if standardMergeWire(record).Method != method {
			t.Fatal("recorded method lost")
		}
	}
	head, base := strings.Repeat("a", 40), strings.Repeat("b", 40)
	if !standardPullMergeParents("merge", head, []string{base, head}) || !standardPullMergeParents("squash", head, []string{base}) {
		t.Fatal("native receipt rejected")
	}
	for _, tc := range []struct {
		method  string
		parents []string
	}{{"merge", []string{base}}, {"merge", []string{base, base}}, {"squash", []string{base, head}}, {"squash", nil}, {"squash", []string{"bad"}}, {"squash", []string{strings.Repeat("b", 64)}}, {"rebase", []string{base}}} {
		if standardPullMergeParents(tc.method, head, tc.parents) {
			t.Fatal("unqualified parent receipt accepted")
		}
	}
}

func TestStandardMergeSameNamedForkRefs(t *testing.T) {
	fork := forkMergeRequest()
	fork.SourceRef = fork.TargetRef
	if err := validateStandardMerge(fork); err != nil {
		t.Fatal("distinct bound fork may share branch name", err)
	}
	for _, alter := range []func(*golfv1.SubmitStandardPullMergeRequest){
		func(m *golfv1.SubmitStandardPullMergeRequest) {
			m.SourceRepository = nil
			m.SourceRepositoryId = ""
			m.SourceOwnerId = ""
		},
		func(m *golfv1.SubmitStandardPullMergeRequest) { m.SourceRepositoryId = m.Selection.RepositoryId },
		func(m *golfv1.SubmitStandardPullMergeRequest) { m.SourceRepositoryId = "023" },
		func(m *golfv1.SubmitStandardPullMergeRequest) { m.SourceOwnerId = "" },
		func(m *golfv1.SubmitStandardPullMergeRequest) { m.SourceRepository = nil },
	} {
		m := proto.Clone(fork).(*golfv1.SubmitStandardPullMergeRequest)
		alter(m)
		if validateStandardMerge(m) == nil {
			t.Fatal("same-name source identity shortcut")
		}
	}
}

// Authored Postgres qualification; root owns execution/resources.
func TestStandardMergeSquashOncePostgres(t *testing.T) {
	for _, fork := range []bool{false, true} {
		name := "same-repository"
		if fork {
			name = "fork"
		}
		t.Run(name, func(t *testing.T) {
			var f *standardMergeFixture
			m := standardMergeFixtureRequest()
			if fork {
				f, _ = newForkMergeFixture(t)
				m = forkMergeRequest()
			} else {
				f = newStandardMergeFixture(t)
			}
			f.method.Store("squash")
			f.mode.Store("squash-only")
			m.Method = "squash"
			session := f.session(t, "pat")
			receipt, err := f.submit(t, session, m)
			if err != nil || receipt.Method != "squash" || receipt.Phase != golfv1.StandardPullMergePhase_STANDARD_PULL_MERGE_PHASE_SUCCEEDED || receipt.MergeCommitId != strings.Repeat("c", 40) || receipt.ActualBaseCommitId != f.actualBase || receipt.HeadCommitId != m.Selection.HeadCommitId || f.calls.Load() != 1 {
				t.Fatal("single native squash", err)
			}
			replay, err := f.submit(t, session, m)
			if err != nil || replay.Method != "squash" || f.calls.Load() != 1 {
				t.Fatal("squash replay resent", err)
			}
			changed := proto.Clone(m).(*golfv1.SubmitStandardPullMergeRequest)
			changed.Method = "merge"
			if _, err = f.submit(t, session, changed); connect.CodeOf(err) != connect.CodeFailedPrecondition || f.calls.Load() != 1 {
				t.Fatal("method change adopted", err)
			}
			status, err := f.status(t, session, standardMergeStatusRequest(m))
			if err != nil || status.Method != "squash" || status.MergeCommitId != receipt.MergeCommitId {
				t.Fatal("original method disappeared", err)
			}
			if _, err = f.db.Exec(`UPDATE golf_standard_pull_merges SET method='merge' WHERE operation_id=$1`, m.OperationId); err == nil {
				t.Fatal("durable method mutable")
			}
		})
	}
}

func TestStandardMergeSquashRefusalAndUnknownPostgres(t *testing.T) {
	for _, mode := range []string{"no-squash", "protected", "reader", "lost-response", "bad-receipt"} {
		t.Run(mode, func(t *testing.T) {
			f := newStandardMergeFixture(t)
			f.method.Store("squash")
			f.mode.Store(mode)
			session := f.session(t, "pat")
			m := standardMergeFixtureRequest()
			m.Method = "squash"
			receipt, err := f.submit(t, session, m)
			if mode == "reader" {
				if connect.CodeOf(err) != connect.CodeNotFound || f.calls.Load() != 0 {
					t.Fatal("reader squash", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			phase := golfv1.StandardPullMergePhase_STANDARD_PULL_MERGE_PHASE_REJECTED
			calls := int32(0)
			if mode == "lost-response" || mode == "bad-receipt" {
				phase = golfv1.StandardPullMergePhase_STANDARD_PULL_MERGE_PHASE_DISPATCH_UNKNOWN
				calls = 1
			}
			if receipt.Method != "squash" || receipt.Phase != phase || receipt.MergeCommitId != "" || receipt.ActualBaseCommitId != "" || f.calls.Load() != calls {
				t.Fatal("unqualified squash outcome", receipt)
			}
			replay, err := f.submit(t, session, m)
			if err != nil || replay.Phase != phase || f.calls.Load() != calls {
				t.Fatal("unknown/rejected squash resent", err)
			}
		})
	}
}

func TestStandardMergeSameNamedForkRefsPostgres(t *testing.T) {
	for _, method := range []string{"merge", "squash"} {
		t.Run(method, func(t *testing.T) {
			f, _ := newForkMergeFixture(t)
			f.method.Store(method)
			original := f.s.client.Transport
			f.s.client.Transport = forkMergeTransport(func(req *http.Request) (*http.Response, error) {
				respond := func(value any) (*http.Response, error) {
					data, _ := json.Marshal(value)
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(data)), Request: req}, nil
				}
				if req.URL.Path == "/api/v1/repos/author/fork/git/refs/heads/main" {
					return respond([]any{map[string]any{"ref": "refs/heads/main", "object": map[string]string{"type": "commit", "sha": strings.Repeat("a", 40)}}})
				}
				response, err := original.RoundTrip(req)
				if err != nil {
					return nil, err
				}
				if req.URL.Path == "/api/v1/repos/alice/private/pulls/7" && req.Method == http.MethodGet {
					defer response.Body.Close()
					var p forgePull
					if err = json.NewDecoder(response.Body).Decode(&p); err != nil {
						return nil, err
					}
					p.Head.Ref = "main"
					return respond(p)
				}
				return response, nil
			})
			p := standardMergeFixturePull(false)
			bindForkPull(&p)
			p.Head.Ref = "main"
			m := forkMergeRequest()
			m.SourceRef = "main"
			m.ExpectedPullRevision = pullRevision(p)
			m.Method = method
			receipt, err := f.submit(t, f.session(t, "pat"), m)
			if err != nil || receipt.Phase != golfv1.StandardPullMergePhase_STANDARD_PULL_MERGE_PHASE_SUCCEEDED || receipt.SourceRepositoryId != "23" || receipt.SourceRef != "main" || receipt.TargetRef != "main" || receipt.Method != method || f.calls.Load() != 1 {
				t.Fatal("same named distinct fork refs", err)
			}
		})
	}
}

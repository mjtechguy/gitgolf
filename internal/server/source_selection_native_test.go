package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Supported-native object proof. The launcher owns ordinary actors/Git and
// purges them; all Golf state is in testDatabase's disposable schema.
func TestSourceSelectionNativeProof(t *testing.T) {
	name := os.Getenv("GOLF_SOURCE_SELECTION_NATIVE_PROOF")
	if name == "" {
		t.Skip("native envelope not supplied")
	}
	stat, e := os.Lstat(name)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 64<<10 {
		t.Fatal("bounded owner-only native envelope required")
	}
	file, e := os.Open(name)
	if e != nil {
		t.Fatal("native envelope unavailable")
	}
	defer file.Close()
	var in struct {
		URL, Owner, Reader, OwnerToken, ReaderToken, Commit, NewCommit, AnnotatedTagObject, Path, Text, Image string
		RepositoryID                                                                                          int64
	}
	decoder := json.NewDecoder(io.LimitReader(file, 64<<10+1))
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&in) != nil || decoder.Decode(&extra) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.Owner, "golf-source-probe-") || !strings.HasPrefix(in.Reader, "golf-source-probe-") || in.Commit == in.NewCommit || in.RepositoryID <= 0 {
		t.Fatal("invalid native fixture")
	}
	config := testConfig(in.URL)
	config.ForgePublicURL = in.URL
	config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = "fixture-client", "fixture-secret"
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal("native source server initialization failed")
	}
	if _, e = ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.Reader, Password: localTestPassword, ForgeToken: in.ReaderToken}); e != nil {
		t.Fatal("managed source reader enrollment failed")
	}
	session, c, _, _, _ := testRPCClients(t, s)
	if _, e = session.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Reader, Password: localTestPassword})); e != nil {
		t.Fatal("managed source reader login failed")
	}
	t.Cleanup(func() {
		if _, e := session.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
			t.Error("native reader logout failed")
		}
	})
	key := &golfv1.RepositoryKey{Owner: in.Owner, Name: "private"}
	id := strconv.FormatInt(in.RepositoryID, 10)
	for _, tc := range []struct {
		kind              golfv1.RepositorySourceRefKind
		name, commit, tag string
	}{
		{golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_DEFAULT_BRANCH, "", in.NewCommit, ""},
		{golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH, "release/雪", in.Commit, ""},
		{golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_TAG, "release/雪", in.NewCommit, in.AnnotatedTagObject},
		{golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_TAG, "lightweight", in.Commit, in.Commit},
		{golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH, in.Commit, in.NewCommit, ""},
		{golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_COMMIT, in.Commit, in.Commit, ""},
	} {
		result, e := c.ResolveRepositorySource(t.Context(), connect.NewRequest(&golfv1.ResolveRepositorySourceRequest{Repository: key, RepositoryId: id, Selector: &golfv1.RepositorySourceSelector{Kind: tc.kind, Name: tc.name}, Path: in.Path}))
		if e != nil || result.Msg.RepositoryId != id || result.Msg.Repository.Owner != in.Owner || result.Msg.Selection.Kind != tc.kind || result.Msg.Selection.CommitId != tc.commit || result.Msg.Selection.GetTagObjectId() != tc.tag || result.Msg.Path != in.Path {
			t.Fatal("typed native ref selection differs from independent Git")
		}
	}
	// The SHA-named branch is newer, but immutable reads must use the old object.
	for _, path := range []string{"", "src", in.Path, "empty.txt"} {
		result, e := c.GetContents(t.Context(), connect.NewRequest(&golfv1.GetContentsRequest{Repository: key, RepositoryId: id, Ref: in.Commit, Path: path}))
		if e != nil || result.Msg.RepositoryId != id || result.Msg.CommitId != in.Commit || result.Msg.Path != path {
			t.Fatal("exact native content receipt failed")
		}
		if path == in.Path && (result.Msg.File == nil || result.Msg.File.GetContent() != in.Text) {
			t.Fatal("native exact source bytes differ from independent Git")
		}
		if path == "empty.txt" && (result.Msg.File == nil || result.Msg.File.Content == nil || result.Msg.File.GetContent() != "") {
			t.Fatal("native empty blob was not retained")
		}
		if path == "" && len(result.Msg.Entries) != 4 {
			t.Fatal("native root inventory differs from independent Git")
		}
		if path == "src" && (len(result.Msg.Entries) != 1 || result.Msg.Entries[0].Path != in.Path) {
			t.Fatal("native child tree differs from independent Git")
		}
	}
	image, e := c.GetRepositoryImage(t.Context(), connect.NewRequest(&golfv1.GetRepositoryImageRequest{Repository: key, RepositoryId: id, CommitId: in.Commit, DocumentPath: "README.md", ImageUrl: "logo.svg"}))
	if e != nil || image.Msg.RepositoryId != id || image.Msg.CommitId != in.Commit || image.Msg.DocumentPath != "README.md" || image.Msg.ImageUrl != "logo.svg" || string(image.Msg.Content) != in.Image {
		t.Fatal("native exact image receipt or bytes differ from independent Git")
	}
	for _, input := range []*golfv1.GetContentsRequest{{Repository: key, Ref: "release/雪"}, {Repository: key, RepositoryId: strconv.FormatInt(in.RepositoryID+1, 10), Ref: in.Commit}, {Repository: key, RepositoryId: id, Ref: "release/雪"}} {
		_, e = c.GetContents(t.Context(), connect.NewRequest(input))
		if e == nil {
			t.Fatal("ambiguous legacy or mismatched exact native target admitted")
		}
	}
	base, _ := repositoryPath(keyFrom(key))
	_, e = s.forgeJSON(t.Context(), http.MethodDelete, base+"/collaborators/"+in.Reader, forgeCredential{Kind: "pat", Token: in.OwnerToken}, nil, nil, http.StatusNoContent)
	if e != nil {
		t.Fatal("ordinary native reader revocation failed")
	}
	_, e = c.GetContents(t.Context(), connect.NewRequest(&golfv1.GetContentsRequest{Repository: key, RepositoryId: id, Ref: in.Commit, Path: in.Path}))
	if connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("revoked native authority exposed source")
	}
	_, e = c.GetRepositoryImage(t.Context(), connect.NewRequest(&golfv1.GetRepositoryImageRequest{Repository: key, RepositoryId: id, CommitId: in.Commit, DocumentPath: "README.md", ImageUrl: "logo.svg"}))
	if connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("revoked native authority exposed image")
	}
	t.Log("supported native typed refs, SHA-shadowed exact object reads, literal UTF-8 path, complete inventories, empty blob, image receipts and revocation verified")
}

package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestWikiNativeProof(t *testing.T) {
	name := os.Getenv("GOLF_FILE_WRITER_NATIVE_PROOF")
	if name == "" {
		t.Skip("owned native wiki envelope not supplied")
	}
	stat, e := os.Lstat(name)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 64<<10 {
		t.Fatal("private wiki envelope required")
	}
	file, e := os.Open(name)
	if e != nil {
		t.Fatal("native wiki envelope unavailable")
	}
	defer file.Close()
	var in struct {
		URL, Owner, Writer, OwnerToken, WriterToken, Branch string
		RepositoryID, OwnerID                               int64
	}
	d := json.NewDecoder(io.LimitReader(file, 64<<10+1))
	d.DisallowUnknownFields()
	var extra any
	if d.Decode(&in) != nil || d.Decode(&extra) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.Owner, "golf-writer-probe-") {
		t.Fatal("invalid owned wiki fixture")
	}
	config := testConfig(in.URL)
	config.GiteaPublicURL = in.URL
	config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = "fixture-client", "fixture-secret"
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal("wiki server initialization failed")
	}
	key := &golfv1.RepositoryKey{Owner: in.Owner, Name: "private"}
	base, _ := repositoryPath(keyFrom(key))
	owner := forgeCredential{Kind: "pat", Token: in.OwnerToken}
	// Supported setup writes belong solely to this disposable native repository.
	text := "# Useful wiki\n\n| Function | Status |\n| --- | --- |\n| Local forge | Working |\n\n```go\nfmt.Println(\"Golf\")\n```\n"
	var page nativeWikiPage
	for _, title := range []string{"Home", "100% Free 雪", "Empty"} {
		content := text
		if title == "Empty" {
			content = ""
		}
		if _, e = s.forgeJSON(t.Context(), http.MethodPost, base+"/wiki/new", owner, map[string]string{"title": title, "content_base64": base64.StdEncoding.EncodeToString([]byte(content)), "message": "Owned native wiki fixture"}, &page, http.StatusCreated); e != nil {
			t.Fatal("owned wiki setup failed")
		}
	}
	if _, e = s.forgeJSON(t.Context(), http.MethodPut, base+"/collaborators/"+in.Writer, owner, map[string]string{"permission": "read"}, nil, http.StatusNoContent); e != nil {
		t.Fatal("owned wiki reader setup failed")
	}
	if _, e = ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.Writer, Password: localTestPassword, ForgeToken: in.WriterToken}); e != nil {
		t.Fatal("owned wiki reader enrollment failed")
	}
	session, _, _, transport, origin := testRPCClients(t, s)
	if _, e = session.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Writer, Password: localTestPassword})); e != nil {
		t.Fatal("owned wiki reader login failed")
	}
	t.Cleanup(func() {
		if _, e := session.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
			t.Error("owned wiki reader logout failed")
		}
	})
	client := golfv1connect.NewRepositoryWikiServiceClient(transport, origin.String()+"/rpc")
	id := strconv.FormatInt(in.RepositoryID, 10)
	req := connect.NewRequest(&golfv1.ListRepositoryWikiPagesRequest{Repository: key, RepositoryId: id, Page: &golfv1.PageRequest{Limit: 20}})
	req.Header().Set("Origin", s.config.PublicURL)
	inventory, e := client.ListRepositoryWikiPages(t.Context(), req)
	if e != nil || len(inventory.Msg.Pages) != 3 || inventory.Msg.NativeEntryCount != "3" {
		t.Fatal("native wiki inventory differs")
	}
	for _, metadata := range inventory.Msg.Pages {
		get := connect.NewRequest(&golfv1.GetRepositoryWikiPageRequest{Repository: key, RepositoryId: id, Slug: metadata.Slug})
		get.Header().Set("Origin", s.config.PublicURL)
		result, e := client.GetRepositoryWikiPage(t.Context(), get)
		if e != nil || result.Msg.Page.Slug != metadata.Slug || result.Msg.Page.LastCommitId != metadata.LastCommitId {
			t.Fatal("native exact wiki identity differs")
		}
		if metadata.Title == "Empty" {
			if result.Msg.Markdown != nil || result.Msg.ContentUnavailableReason == "" {
				t.Fatal("ambiguous empty wiki manufactured exact content")
			}
		} else if result.Msg.GetMarkdown() != text {
			t.Fatal("native wiki Markdown bytes differ")
		}
	}
	if _, e = s.forgeJSON(t.Context(), http.MethodDelete, base+"/collaborators/"+in.Writer, owner, nil, nil, http.StatusNoContent); e != nil {
		t.Fatal("native wiki reader revocation failed")
	}
	if _, e = client.ListRepositoryWikiPages(t.Context(), req); connect.CodeOf(e) != connect.CodeNotFound && connect.CodeOf(e) != connect.CodeUnauthenticated && connect.CodeOf(e) != connect.CodePermissionDenied {
		t.Fatal("revoked native wiki reader refusal code", connect.CodeOf(e))
	}
	t.Log("actual native wiki reader inventory, UTF-8/percent segment, exact Markdown, omitted-empty ambiguity and revocation pass")
}

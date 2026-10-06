package server

import (
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestProtectedReviewNative087(t *testing.T) {
	path := os.Getenv("GOLF_PROTECTED087_NATIVE_FIXTURE")
	if path == "" {
		t.Skip("owned native fixture not supplied")
	}
	stat, e := os.Lstat(path)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 64<<10 {
		t.Fatal("private owned fixture required")
	}
	file, e := os.Open(path)
	if e != nil {
		t.Fatal("owned fixture unavailable")
	}
	defer file.Close()
	var in struct {
		URL, Token, FullName, Head, OldHead string
		Number                              int64
	}
	d := json.NewDecoder(io.LimitReader(file, 64<<10+1))
	d.DisallowUnknownFields()
	if d.Decode(&in) != nil || d.Decode(new(any)) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.FullName, "golf-protection-") || !objectID.MatchString(in.Head) || !objectID.MatchString(in.OldHead) || in.Head == in.OldHead || in.Number <= 0 {
		t.Fatal("owned fixture invalid")
	}
	s, e := New(testConfig(in.URL), nil)
	if e != nil {
		t.Fatal("owned native consumer unavailable")
	}
	pull := forgePull{Number: in.Number, HTMLURL: in.URL + "/" + in.FullName + "/pulls/" + strconv.FormatInt(in.Number, 10)}
	// The read API supplies the actual native PR URL rather than assuming the
	// configured external origin equals the supported API connection origin.
	var native forgePull
	credential := forgeCredential{Kind: "pat", Token: in.Token}
	base := "/repos/" + in.FullName
	if _, e = s.forge(t.Context(), "GET", base+"/pulls/"+strconv.FormatInt(in.Number, 10), credential, nil, &native); e != nil || native.Number != in.Number || native.Head == nil || native.Head.SHA != in.Head {
		t.Fatal("owned native current PR binding unavailable")
	}
	pull.HTMLURL, pull.User = native.HTMLURL, native.User
	out, e := s.protectedReviewObservation(t.Context(), credential, base, pull, in.Head)
	if e != nil || out.UnavailableReason != "" || out.ExactHeadOfficialApprovals != 0 || out.ObservedReviews == 0 {
		t.Fatal("native old-head approvals inflated current-head observation")
	}
	found := false
	for _, row := range out.Exclusions {
		if row.ReviewedCommitId == in.OldHead && row.Reason == "stale_head" {
			found = true
		}
	}
	if !found {
		t.Fatal("native original review identity lost")
	}
	t.Log("actual supported native review pages exclude original H1 approval at selected H2 regardless of asynchronous stale/dismissal flags; no merge authority issued")
}

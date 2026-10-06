package server

import (
	"testing"
	"time"
)

func TestPackageExactOwnerBinding(t *testing.T) {
	repo := Repository{ID: 11, Name: "private", FullName: "alice/private", HTMLURL: "https://forge.invalid/alice/private", DefaultBranch: "main", UpdatedAt: time.Now()}
	row := nativePackage{ID: 71, Name: "useful", Type: "generic", Version: "1.0", Created: "2026-10-05T12:00:00Z", Owner: &User{ID: 42, Login: "alice"}, Creator: &User{ID: 43, Login: "publisher"}, Repository: &repo}
	if _, e := packageWire(row, repo, 42); e != nil {
		t.Fatal(e)
	}
	if _, e := packageWire(row, repo, 99); e == nil {
		t.Fatal("same owner login with foreign numeric ID admitted")
	}
	row.Owner = &User{ID: 42, Login: "bob"}
	if _, e := packageWire(row, repo, 42); e == nil {
		t.Fatal("foreign owner login admitted")
	}
}

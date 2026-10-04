package main

import (
	"encoding/json"
	"testing"
)

const project = "golf-gitread-0123456789"

func TestOwnedAPIAllowlist(t *testing.T) {
	for _, v := range []input{
		{Project: project, Method: "GET", Path: "/api/v1/version"},
		{Project: project, Token: "synthetic", Method: "GET", Path: "/api/v1/user"},
		{Project: project, Token: "synthetic", Method: "POST", Path: "/api/v1/user/repos", Body: json.RawMessage(`{"name":"proof","private":true,"auto_init":true}`)},
		{Project: project, Token: "synthetic", Method: "PUT", Path: "/api/v1/repos/" + project + "-owner/proof/collaborators/" + project + "-reader", Body: json.RawMessage(`{"permission":"read"}`)},
		{Project: project, Token: "synthetic", Method: "GET", Path: "/api/v1/repos/" + project + "-owner/proof/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?page=1&per_page=100"},
	} {
		if e := validate(v); e != nil {
			t.Fatalf("owned supported shape refused: %s", v.Method)
		}
	}
}
func TestUnownedAndUnclassifiedRefused(t *testing.T) {
	base := input{Project: project, Token: "synthetic", Method: "GET", Path: "/api/v1/repos/" + project + "-owner/proof"}
	for _, path := range []string{"https://other.invalid/api/v1/user", "//other.invalid/api/v1/user", "/api/v1/repos/retained/proof", "/api/v1/repos/" + project + "-owner/retained", "/api/v1/admin/users", "/api/v1/repos/" + project + "-owner/proof.git/git-receive-pack", "/api/v1/repos/" + project + "-owner/proof/../../users", "/api/v1/repos/" + project + "-owner/proof%2fother", "/api/v1/repos/" + project + "-owner/proof?token=synthetic"} {
		v := base
		v.Path = path
		if validate(v) == nil {
			t.Fatal("unowned/unclassified target accepted")
		}
	}
	for _, body := range []string{`{"name":"proof","private":false,"auto_init":true}`, `{"name":"proof","private":true,"auto_init":true,"mirror":true}`, `{"name":"proof","private":true,"auto_init":true} {}`} {
		v := base
		v.Method = "POST"
		v.Path = "/api/v1/user/repos"
		v.Body = json.RawMessage(body)
		if validate(v) == nil {
			t.Fatal("unclassified repository write accepted")
		}
	}
	v := base
	v.Method = "PUT"
	v.Path += "/collaborators/" + project + "-reader"
	v.Body = json.RawMessage(`{"permission":"admin"}`)
	if validate(v) == nil {
		t.Fatal("broader native grant accepted")
	}
}
func TestStrictEnvelope(t *testing.T) {
	for _, raw := range []string{`{"project":"` + project + `","method":"GET","path":"/api/v1/version","extra":true}`, `{} {}`} {
		if decode([]byte(raw), new(input)) == nil {
			t.Fatal("ambiguous envelope accepted")
		}
	}
}
func TestCurrentOwnedNativeActor(t *testing.T) {
	if !ownedIdentity(project, []byte(`{"id":1,"login":"`+project+`-owner","is_admin":false}`)) {
		t.Fatal("ordinary owned actor refused")
	}
	for _, raw := range []string{`{"id":1,"login":"retained","is_admin":true}`, `{"id":0,"login":"` + project + `-owner"}`, `{"id":1,"login":"` + project + `-owner-more"}`, `{}`} {
		if ownedIdentity(project, []byte(raw)) {
			t.Fatal("unowned native identity accepted")
		}
	}
}

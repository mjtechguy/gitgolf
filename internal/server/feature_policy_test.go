package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

// The portable server has no feature policy store yet: the procedures are authenticated like every
// other private RPC and then answer Unimplemented, so the web keeps its current repository behaviour.
func TestFeaturePolicyProceduresArePortableUnimplemented(t *testing.T) {
	s, err := New(testConfig("http://native.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range []string{golfv1connect.FeaturePolicyServiceGetFeaturePolicyProcedure, golfv1connect.FeaturePolicyServiceUpdateFeaturePolicyProcedure, golfv1connect.RepositoryFeatureServiceGetRepositoryFeaturesProcedure, golfv1connect.RepositoryFeatureServiceUpdateRepositoryFeaturesProcedure} {
		for _, boundary := range []bool{false, true} {
			path, handler, want := procedure, s.rpcHandler(), "unimplemented"
			if boundary {
				path, handler, want = "/rpc"+procedure, s.rpcBoundary(s.rpcHandler()), "unauthenticated"
			}
			r := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Connect-Protocol-Version", "1")
			r.Header.Set("Origin", s.config.PublicURL)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			var response struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response.Code != want {
				t.Fatalf("%s boundary=%v: got %q (%v), want %s", procedure, boundary, response.Code, err, want)
			}
		}
	}
}

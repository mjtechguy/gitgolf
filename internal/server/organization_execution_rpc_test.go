package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestOrganizationExecutionRPCValueTransportBounds(t *testing.T) {
	s, err := New(testConfig("http://native.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range []string{golfv1connect.OrganizationExecutionValueServiceSaveOrganizationExecutionValueProcedure, golfv1connect.RepositoryExecutionValueServiceSaveRepositoryExecutionValueProcedure} {
		for _, size := range []int{8192, 40000} {
			// Quotes double under JSON encoding. The supported domain's 8-KiB
			// value must reach domain validation; oversized input must not decode.
			payload := map[string]any{"id": "2d40f2fd-c269-4acb-85ad-7acf4d71daaa", "operationId": "2d40f2fd-c269-4acb-85ad-7acf4d71daab", "expectedVersion": "0", "expectedBrokerRevision": "0", "name": "invalid-name", "kind": "REPOSITORY_EXECUTION_VALUE_KIND_SECRET", "value": strings.Repeat("\"", size)}
			if procedure == golfv1connect.OrganizationExecutionValueServiceSaveOrganizationExecutionValueProcedure {
				payload["target"] = map[string]string{"organization": "club", "organizationId": "73"}
				payload["expiresAt"] = "2026-10-05T00:00:00Z"
			} else {
				payload["target"] = map[string]any{"repository": map[string]string{"owner": "club", "name": "example"}, "repositoryId": "74", "ownerId": "73", "accessRevision": strings.Repeat("a", 64)}
			}
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			if size == 8192 && (len(body) <= 16<<10 || len(body) >= 64<<10) {
				t.Fatal("fixture does not exercise escaped transport bound")
			}
			r := httptest.NewRequest(http.MethodPost, procedure, bytes.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Connect-Protocol-Version", "1")
			r.Header.Set("Origin", s.config.PublicURL)
			w := httptest.NewRecorder()
			s.rpcHandler().ServeHTTP(w, r)
			var response struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal("missing bounded Connect error", err)
			}
			want := "invalid_argument"
			if size == 40000 {
				want = "resource_exhausted"
			}
			if response.Code != want {
				t.Fatalf("transport %s size%d: got%s want%s", procedure, size, response.Code, want)
			}
		}
	}
}

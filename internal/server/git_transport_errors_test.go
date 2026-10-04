package server

import (
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManagedGitHTTPNativeDenials(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
	}{
		{forgeError{404}, 404}, {forgeError{401}, 401}, {forgeError{403}, 401},
		{forgeError{500}, 503}, {errors.New("private SQL details"), 503},
	} {
		w := httptest.NewRecorder()
		gitHTTPFailure(w, fmt.Errorf("private upstream details: %w", tc.err))
		if w.Code != tc.status || strings.Contains(w.Body.String(), "private") || (w.Header().Get("WWW-Authenticate") != "") != (tc.status == 401) {
			t.Fatalf("native denial mapping: got%d want%d", w.Code, tc.status)
		}
	}
}

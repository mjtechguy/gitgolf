package server

import (
	"errors"
	"net/http"
	"strconv"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestWorkflowRunHistoricalRedirectPostgres(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			f := newWorkflowRunFixture(t)
			f.enable(t)
			created, err := f.dispatch(t, uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			f.repositoryStatus = status
			f.mu.Unlock()
			_, err = f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: created.Msg.Run.Id}))
			want := connect.CodeNotFound
			if status == http.StatusInternalServerError {
				want = connect.CodeUnavailable
			}
			if connect.CodeOf(err) != want {
				t.Fatalf("historical target status %d mapped to %s", status, connect.CodeOf(err))
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.redirectReads != 0 {
				t.Fatal("historical workflow adopted a redirected repository")
			}
		})
	}
}

func TestWorkflowRepositoryReadError(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		if !errors.Is(workflowRepositoryReadError(forgeError{status}), errResourceNotFound) {
			t.Fatal("historical redirect was not denied", status)
		}
	}
	for _, err := range []error{nil, errForgeUnavailable, errInvalidForgeResponse, forgeError{401}, forgeError{403}, forgeError{404}, forgeError{500}} {
		if workflowRepositoryReadError(err) != err {
			t.Fatal("unknown or ordinary error was relabeled", err)
		}
	}
}

func TestWorkflowRunHistoricalAddressAliasPostgres(t *testing.T) {
	for _, scenario := range []string{"transfer", "rename", "malformed"} {
		t.Run(scenario, func(t *testing.T) {
			f := newWorkflowRunFixture(t)
			f.enable(t)
			created, err := f.dispatch(t, uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			switch scenario {
			case "transfer":
				f.row.Owner = &User{ID: 43, Login: "moved"}
				f.row.FullName = "moved/example"
			case "rename":
				f.row.Name = "renamed"
				f.row.FullName = "alice/renamed"
			case "malformed":
				f.row.Owner = nil
			}
			f.mu.Unlock()
			_, err = f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: created.Msg.Run.Id}))
			want := connect.CodeNotFound
			if scenario == "malformed" {
				want = connect.CodeUnavailable
			}
			if connect.CodeOf(err) != want {
				t.Fatalf("historical alias %s mapped to %s", scenario, connect.CodeOf(err))
			}
		})
	}
}

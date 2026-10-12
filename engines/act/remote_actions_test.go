package actionsengine

import (
	"archive/tar"
	"bytes"
	"encoding/hex"
	"strings"
	"testing"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
)

func TestRemoteWorkflowAdmissionKeepsItsDeclaredBounds(t *testing.T) {
	bundle := remoteBundle(t)
	workflow := "on: [push, pull_request]\npermissions: {contents: read}\njobs:\n  check:\n    runs-on: linux\n    timeout-minutes: 1\n    steps:\n      - uses: " + bundle.Uses + "\n      - run: echo proof\n"
	for _, change := range []string{"valid", "write", "timeout", "token-context", "pr-event", "legacy"} {
		source := workflow
		switch change {
		case "write":
			source = strings.Replace(source, "contents: read", "contents: write", 1)
		case "timeout":
			source = strings.Replace(source, "timeout-minutes: 1", "timeout-minutes: 16", 1)
		case "token-context":
			source = strings.Replace(source, "echo proof", "echo '${{ github.token }}'", 1)
		}
		input := testInput(t, source, nil)
		input.Catalog, input.Event, input.Ref = protocol.ActionsRemoteCatalog, "push", "refs/heads/proof"
		input.RemoteActions = []protocol.ActionBundle{bundle}
		if change == "pr-event" {
			input.Event = "pull_request"
		}
		if change == "legacy" {
			input.Catalog = protocol.ActionsCatalog
		}
		plan, err := Plan(input)
		if change == "valid" {
			if err != nil || len(plan.Jobs) != 1 || plan.Jobs[0].TimeoutSeconds != 60 || len(plan.RemoteActions) != 1 {
				t.Fatal("bounded public action plan refused", err)
			}
		} else if err == nil || len(plan.Jobs) != 0 {
			t.Fatal("unsupported source gained a partial executable graph", change)
		}
	}
}

func remoteBundle(t *testing.T) protocol.ActionBundle {
	t.Helper()
	files := map[string]file{"action.yml": {body: []byte("name: proof\ndescription: proof\ninputs:\n  text:\n    default: '${{ github.token }}'\nruns:\n  using: node24\n  pre: dist/pre.js\n  main: dist/main.js\n  post: dist/post.js\n"), mode: 0644}}
	for _, name := range []string{"pre", "main", "post"} {
		files["dist/"+name+".js"] = file{body: []byte("console.log('" + name + "');\n"), mode: 0644}
	}
	var body bytes.Buffer
	tw := tar.NewWriter(&body)
	for name, f := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: f.mode, Size: int64(len(f.body))}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write(f.body)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	commit := []byte("tree " + hex.EncodeToString(actionTree(files, "")) + "\nauthor Proof <proof@example.invalid> 1 +0000\ncommitter Proof <proof@example.invalid> 1 +0000\n\nproof\n")
	id := hex.EncodeToString(gitObject("commit", commit))
	return protocol.ActionBundle{Uses: "example/proof@" + id, CommitID: id, Commit: commit, Archive: body.Bytes(), ArchiveSHA256: digest(body.Bytes())}
}

func TestRemoteActionGitBindingsAndNativeCache(t *testing.T) {
	bundle := remoteBundle(t)
	for _, mode := range []string{"valid", "archive", "rehashed", "commit", "ref", "missing-main", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			input := protocol.ActionPlanInput{Catalog: protocol.ActionsRemoteCatalog, RemoteActions: []protocol.ActionBundle{bundle}}
			switch mode {
			case "archive":
				input.RemoteActions[0].Archive = append([]byte{}, bundle.Archive...)
				input.RemoteActions[0].Archive[512] ^= 1
			case "rehashed":
				input.RemoteActions[0].Archive = append([]byte{}, bundle.Archive...)
				input.RemoteActions[0].Archive[512] ^= 1
				input.RemoteActions[0].ArchiveSHA256 = digest(input.RemoteActions[0].Archive)
			case "commit":
				input.RemoteActions[0].Commit = append([]byte{}, bundle.Commit...)
				input.RemoteActions[0].Commit[6] ^= 1
			case "ref":
				input.RemoteActions[0].Uses = "example/proof@0000000000000000000000000000000000000000"
			case "missing-main":
				input.RemoteActions = nil
			case "legacy":
				input.Catalog = protocol.ActionsCatalog
			}
			actions, err := admitRemoteActions(input)
			if (err == nil) != (mode == "valid") {
				t.Fatal("incorrect immutable cache admission")
			}
			if err != nil {
				return
			}
			cache := immutableActionCache{actions: actions}
			if _, err = cache.Fetch(t.Context(), "example/proof", "https://github.com/example/proof", bundle.CommitID, "ignored-job-token"); err != nil {
				t.Fatal(err)
			}
			if _, err = cache.Fetch(t.Context(), "example/proof", "https://private.invalid/example/proof", bundle.CommitID, ""); err == nil {
				t.Fatal("cache accepted a different origin")
			}
			stream, err := cache.GetTarArchive(t.Context(), "example/proof", bundle.CommitID, "dist/main.js")
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Close()
			header, err := tar.NewReader(stream).Next()
			if err != nil || header.Name != "dist/main.js" {
				t.Fatal("native cache file lookup changed")
			}
		})
	}
}

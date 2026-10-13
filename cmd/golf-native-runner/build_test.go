package main

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestSocketlessDockerfileKeepsOneApprovedLocalBase(t *testing.T) {
	base := "alpine:3.23@sha256:" + "85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0"
	for name, source := range map[string]string{
		"unpinned":        "FROM alpine:latest\nRUN true\n",
		"another_stage":   "FROM " + base + "\nFROM " + base + "\n",
		"remote_add":      "FROM " + base + "\nADD https://example.invalid/file /file\n",
		"external_copy":   "FROM " + base + "\nCOPY --from=other /x /x\n",
		"custom_frontend": "# syntax=docker/dockerfile:1\nFROM " + base + "\n",
		"continued":       "FROM " + base + "\\\nRUN true\n",
		"host_network":    "FROM " + base + "\nRUN --network=host true\n",
		"external_mount":  "FROM " + base + "\nRUN --mount=type=bind,from=other true\n",
		"insecure_run":    "FROM " + base + "\nRUN --security=insecure true\n",
	} {
		if approvedDockerfile(source, base) {
			t.Fatalf("admitted %s", name)
		}
	}
	if !approvedDockerfile("# approved\nFROM "+base+"\nCOPY README.md /source.txt\nRUN test -f /source.txt\n", base) {
		t.Fatal("refused an approved single-base Dockerfile")
	}
}

func TestSocketlessBuildRejectsMissingDockerfileAsJobFailure(t *testing.T) {
	_, _, err := socketlessBuild(context.Background(), t.TempDir(), "alpine:3.23@sha256:"+"85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0", "", filepath.Join(t.TempDir(), "image.tar"))
	if !errors.Is(err, errBuildRejected) {
		t.Fatalf("missing Dockerfile classification: %v", err)
	}
}

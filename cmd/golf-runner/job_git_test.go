package main

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestJobGitTranscriptMasksRotatedAndSplitCredentials(t *testing.T) {
	transcript := &jobGitTranscript{}
	first := "golf_job_git_" + strings.Repeat("first", 12)
	second := "golf_job_git_" + strings.Repeat("second", 12)
	for _, token := range []string{first, second} {
		transcript.issued(&runner.JobGitCredential{GitToken: token})
	}
	encoded := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + first))
	chunks := []string{"start " + first[:20], first[20:] + " " + second + " " + encoded[:15], encoded[15:] + " end"}
	masked, err := runner.MaskExecutionOutput(chunks, transcript.secrets)
	if err != nil || strings.Join(masked, "") != "start "+strings.Repeat("*", len(first))+" "+strings.Repeat("*", len(second))+" "+strings.Repeat("*", len(encoded))+" end" {
		t.Fatal("rotated/split capsule escaped masking")
	}
	for i, chunk := range masked {
		if len(chunk) != len(chunks[i]) {
			t.Fatal("frame coordinates changed")
		}
	}
	if err := transcript.append(runner.ActionFrame{Kind: "log", Text: strings.Repeat("x", logLimit+1)}); err == nil {
		t.Fatal("unbounded transcript accepted")
	}
}

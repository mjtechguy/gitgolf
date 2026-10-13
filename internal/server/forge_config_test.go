package server

import (
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/internal/workflowpath"
)

func TestForgeConfigurationTransition(t *testing.T) {
	id := "ba09ae45-092f-4b4d-9e17-c6b848e5d95c"
	for _, test := range []struct {
		name               string
		config             Config
		kind, origin, dirs string
		denied             bool
	}{
		{"default requires identity", Config{GiteaURL: "https://old.invalid"}, "", "", "", true},
		{"default is forgejo", Config{ForgeInstanceID: id, ForgeURL: "https://new.invalid"}, "forgejo", "https://new.invalid", workflowpath.DefaultDirectories, false},
		{"fresh", Config{ForgeKind: "forgejo", ForgeInstanceID: id, ForgeURL: "https://new.invalid"}, "forgejo", "https://new.invalid", workflowpath.ForgejoDirectories, false},
		{"explicit selection", Config{ForgeKind: "forgejo", ForgeInstanceID: id, ForgeWorkflowDirs: ".github/workflows"}, "forgejo", "http://forgejo:3000", ".github/workflows", false},
		{"unknown", Config{ForgeKind: "guess"}, "", "", "", true},
		{"gitea refused", Config{ForgeKind: "gitea", ForgeInstanceID: id}, "", "", "", true},
		{"no identity", Config{ForgeKind: "forgejo"}, "", "", "", true},
		{"bad identity", Config{ForgeKind: "forgejo", ForgeInstanceID: "https://secret.invalid"}, "", "", "", true},
		{"URL conflict", Config{ForgeURL: "https://new.invalid", GiteaURL: "https://old.invalid"}, "", "", "", true},
		{"secret conflict", Config{ForgeOAuthClientSecret: "secret-one", GiteaOAuthClientSecret: "secret-two"}, "", "", "", true},
		{"workflow conflict", Config{ForgeWorkflowDirs: ".forgejo/workflows", GiteaWorkflowDirs: ".github/workflows"}, "", "", "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := NormalizeForgeConfig(test.config)
			if (err != nil) != test.denied {
				t.Fatalf("unexpected result: %v", err)
			}
			if err != nil {
				if strings.Contains(err.Error(), "secret-one") || strings.Contains(err.Error(), "secret-two") {
					t.Fatal("credential in error")
				}
				return
			}
			if got.ForgeKind != test.kind || got.GiteaURL != test.origin || got.GiteaWorkflowDirs != test.dirs {
				t.Fatal("configuration changed")
			}
			again, err := NormalizeForgeConfig(got)
			if err != nil || again.ForgeURL != got.ForgeURL || again.ForgeWorkflowDirs != got.ForgeWorkflowDirs {
				t.Fatal("not idempotent")
			}
		})
	}
}

func TestForgeVersionQualification(t *testing.T) {
	for _, tc := range []struct {
		kind, version string
		ok            bool
	}{
		{"forgejo", "15.0.9", true}, {"forgejo", "15.0.9+gitea-1.22.0", true}, {"gitea", "1.27.3", false},
		{"forgejo", "1.27.3", false}, {"gitea", "15.0.9", false}, {"forgejo", "15.0.10", false}, {"forgejo", "15.0.9-evil", false},
	} {
		if supportedForgeVersion(tc.kind, tc.version) != tc.ok {
			t.Fatal(tc)
		}
	}
}

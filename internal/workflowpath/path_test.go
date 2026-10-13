package workflowpath

import (
	"reflect"
	"strings"
	"testing"
)

func TestPathsAndDirectoryConfiguration(t *testing.T) {
	for _, prefix := range []string{".forgejo/workflows/", ".github/workflows/"} {
		for _, name := range []string{"check.yml", "golf-test.yaml", "a.b.yml"} {
			if !Actions(prefix+name) || !Valid(prefix+name) {
				t.Fatal("ordinary filename refused", prefix+name)
			}
		}
		for _, name := range []string{"", "*.yml", "a/b.yml", "../check.yml", "a..b.yml", "check.yaml\n", "check.yml?next", "a\\b.yml", "résumé.yml", "check.YML", strings.Repeat("a", 256) + ".yml"} {
			if Actions(prefix+name) || Valid(prefix+name) {
				t.Fatal("unsafe filename accepted", prefix+name)
			}
		}
	}
	if !Valid(".gitlab-ci.yml") || Actions(".gitlab-ci.yml") || Valid(".gitlab-ci.yaml") || Actions(".gitea/workflows/a.yml") || Actions(".gitea/scoped_workflows/a.yml") {
		t.Fatal("format/location boundary changed")
	}
	for _, tc := range []struct {
		setting string
		want    []string
	}{
		{"", []string{".forgejo/workflows", ".github/workflows"}},
		{" .github/workflows, .forgejo/workflows ", []string{".github/workflows", ".forgejo/workflows"}},
		{ForgejoDirectories, []string{".forgejo/workflows", ".github/workflows"}},
		{".forgejo/workflows", []string{".forgejo/workflows"}},
		{".github/workflows", []string{".github/workflows"}},
	} {
		got, err := Directories(tc.setting)
		if err != nil || !reflect.DeepEqual(got, tc.want) {
			t.Fatal("directory order changed", tc.setting, got, err)
		}
	}
	for _, setting := range []string{" ", "custom/workflows", ".gitea/workflows", ".forgejo/workflows,", ".github/workflows,.github/workflows", ".forgejo/workflows/../workflows", ".gitlab-ci.yml"} {
		if _, err := Directories(setting); err == nil {
			t.Fatal("unsupported directory configuration accepted", setting)
		}
	}
}

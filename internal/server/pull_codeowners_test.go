package server

import (
	"reflect"
	"testing"
)

func TestCodeOwnerNativePatterns(t *testing.T) {
	rules, unsupported := parseCodeOwners(".*\\\\.go @alice @org/backend # native regex\n!vendor/.* @reviewer\npath\\ with\\ space @docs\n")
	if unsupported != 0 {
		t.Fatal(unsupported)
	}
	rows := codeOwnerMatches(rules, []string{"src/server.go", "vendor/lib.go", "path with space"})
	if len(rows) != 3 || !reflect.DeepEqual(rows[0].Owners, []string{"@alice", "@org/backend", "@reviewer"}) || !reflect.DeepEqual(rows[1].Owners, []string{"@alice", "@org/backend"}) || !reflect.DeepEqual(rows[2].Owners, []string{"@docs", "@reviewer"}) {
		t.Fatal(rows)
	}
	for _, source := range []string{"[bad @alice", "*.go @alice", ".* user-without-at", ".* @org/team/extra"} {
		_, n := parseCodeOwners(source)
		if n != 1 {
			t.Fatal("unsupported syntax inferred", source)
		}
	}
}

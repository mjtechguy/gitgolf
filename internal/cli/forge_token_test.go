package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestForgeTokenAliasCannotMixCredentialKinds(t *testing.T) {
	for _, env := range []map[string]string{
		{"GOLF_FORGE_TOKEN": "private-provider-token", "GOLF_API_TOKEN": fixtureAPIToken},
		{"GOLF_FORGE_TOKEN": "private-provider-token", "GOLF_NATIVE_TOKEN": "golf_native_example"},
	} {
		var out, diag bytes.Buffer
		if Run(context.Background(), []string{"repo", "list"}, strings.NewReader(""), &out, &diag, func(k string) string { return env[k] }) != 2 {
			t.Fatal("mixed authority accepted")
		}
		if strings.Contains(out.String()+diag.String(), "private-provider-token") {
			t.Fatal("credential leaked")
		}
	}
}

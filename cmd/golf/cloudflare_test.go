package main

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func TestCloudflareCommandRejectsUnsafeConfiguration(t *testing.T) {
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
	for _, args := range [][]string{
		{"cloudflare"}, {"cloudflare", "deploy"}, {"cloudflare", "inspect", "--token", "private-token"},
		{"cloudflare", "inspect", "--account-id", "private-token"},
		{"cloudflare", "inspect", "--profile", "../private-token"},
		{"cloudflare", "inspect", "--account-id", "0123456789abcdef0123456789abcdef", "--namespace", "default"},
	} {
		var out strings.Builder
		err := runCommand(context.Background(), args, &out, zerolog.New(io.Discard))
		if err == nil || out.Len() != 0 || strings.Contains(err.Error(), "private-token") {
			t.Fatal("invalid operator request succeeded or disclosed its input")
		}
	}
}

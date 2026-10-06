package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mjtechguy/golf-git/internal/cli"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func nativeMachineCLI(t *testing.T, origin, token string, args []string, input proto.Message, output proto.Message) {
	t.Helper()
	raw, e := protojson.Marshal(input)
	if e != nil {
		t.Fatal("native machine input")
	}
	file := filepath.Join(t.TempDir(), "request.json")
	if os.WriteFile(file, raw, 0600) != nil {
		t.Fatal("private machine request")
	}
	var out, diagnostic bytes.Buffer
	args = append(append([]string{"--url", origin}, args...), "--input", file)
	code := cli.Run(t.Context(), args, strings.NewReader(""), &out, &diagnostic, func(key string) string {
		if key == "GOLF_API_TOKEN" {
			return token
		}
		return ""
	})
	if code != 0 {
		t.Fatal("actual native machine CLI", code)
	}
	var response struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(out.Bytes(), &response) != nil || protojson.Unmarshal(response.Data, output) != nil {
		t.Fatal("native machine response")
	}
}
func nativeMachineMCP(t *testing.T, origin, token, tool string, input proto.Message, expected string) {
	t.Helper()
	raw, e := protojson.Marshal(input)
	if e != nil {
		t.Fatal("native machine input")
	}
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
		toServer, toServerWriter := io.Pipe()
		fromServer, fromServerWriter := io.Pipe()
		done := make(chan int, 1)
		var diagnostic bytes.Buffer
		go func() {
			done <- cli.Run(ctx, []string{"--url", origin, "mcp"}, toServer, fromServerWriter, &diagnostic, func(key string) string {
				if key == "GOLF_API_TOKEN" {
					return token
				}
				return ""
			})
			fromServerWriter.Close()
		}()
		session, e := mcp.NewClient(&mcp.Implementation{Name: "owned-native-machine-proof", Version: "1"}, nil).Connect(ctx, &mcp.IOTransport{Reader: fromServer, Writer: toServerWriter}, &mcp.ClientSessionOptions{ProtocolVersion: version})
		if e != nil {
			cancel()
			toServer.Close()
			fromServer.Close()
			t.Fatal("native machine MCP handshake")
		}
		result, e := session.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: map[string]any{"request": json.RawMessage(raw)}})
		valid := e == nil && !result.IsError && len(result.Content) > 0 && strings.Contains(result.Content[0].(*mcp.TextContent).Text, expected)
		session.Close()
		cancel()
		toServer.Close()
		fromServer.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("native machine MCP settlement")
		}
		if !valid {
			t.Fatal("native machine MCP original replay", version)
		}
	}
}

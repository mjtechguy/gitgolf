package server

import (
	"context"
	"net/url"
	"strings"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/codexaccount"
)

type agentSelection struct{ Harness, Provider string }
type agentSelectionKey struct{}

func selectAgent(ctx context.Context, harness, provider string) (context.Context, error) {
	if harness == "" {
		harness = "codex"
	}
	if provider == "" {
		provider = "openai"
		if harness == "claude-code" {
			provider = "anthropic"
		}
		if harness == "opencode" {
			provider = "opencode"
		}
	}
	if !((harness == "codex" && provider == "openai") || (harness == "claude-code" && provider == "anthropic") || (harness == "opencode" && (provider == "anthropic" || provider == "openai" || provider == "opencode" || provider == "opencode-go"))) {
		return ctx, invalid("Select a supported harness and provider.")
	}
	return context.WithValue(ctx, agentSelectionKey{}, agentSelection{harness, provider}), nil
}
func selectedAgent(ctx context.Context) agentSelection {
	if v, ok := ctx.Value(agentSelectionKey{}).(agentSelection); ok {
		return v
	}
	return agentSelection{"codex", "openai"}
}
func agentLabel(h string) string {
	switch h {
	case "claude-code":
		return "Claude Code"
	case "opencode":
		return "OpenCode"
	default:
		return "Codex"
	}
}
func (s *Server) agentBinary(r codexRecord) string {
	switch r.Harness {
	case "claude-code":
		return s.config.ClaudeBinary
	case "opencode":
		return s.config.OpenCodeBinary
	default:
		return s.config.CodexBinary
	}
}

// Account adapters never expose inference, shell or arbitrary native RPCs.
type agentAccountProcess interface {
	Account(context.Context, bool) (codexaccount.Account, error)
	StartLogin(context.Context, codexaccount.LoginRequest) (codexaccount.Login, error)
	CancelLogin(context.Context, string) error
	Logout(context.Context) error
	Events() <-chan codexaccount.LoginCompleted
	Snapshot() ([]byte, error)
	Usage(context.Context) (codexaccount.Usage, error)
	Close() error
}

func validAgentLoginURL(harness, raw string) bool {
	if harness == "codex" {
		return raw == "https://auth.openai.com/codex/device"
	}
	if len(raw) > 8192 {
		return false
	}
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" {
		return false
	}
	return harness == "claude-code" && ((u.Host == "claude.com" && u.Path == "/cai/oauth/authorize") || (u.Host == "claude.ai" && u.Path == "/oauth/authorize")) && u.Query().Get("state") != "" && u.Query().Get("code_challenge") != ""
}
func (s *Server) CompleteAgentLogin(ctx context.Context, req *connect.Request[golfv1.CompleteAgentLoginRequest]) (*connect.Response[golfv1.CompleteAgentLoginResponse], error) {
	if req.Msg.ConnectionId == "" || len(req.Msg.AuthorizationCode) == 0 || len(req.Msg.AuthorizationCode) > 4096 || strings.ContainsAny(req.Msg.AuthorizationCode, "\r\n\x00") {
		return nil, rpcError(invalid("Provide the authorization code for this pending login."))
	}
	r, e := s.codexMutate(ctx, req.Header(), req.Msg.ExpectedVersion, "complete", req.Msg.LoginId, req.Msg.ConnectionId, 0, req.Msg.AuthorizationCode)
	req.Msg.AuthorizationCode = ""
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.CompleteAgentLoginResponse{Connection: r}), nil
}

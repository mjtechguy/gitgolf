package server

import (
	"errors"
	"strings"

	"github.com/mjtechguy/golf-git/internal/workflowpath"
)

// NormalizeForgeConfig applies defaults and validates the Forgejo configuration
// before any provider access. Forgejo is the only supported portable forge.
func NormalizeForgeConfig(c Config) (Config, error) {
	if c.ForgeKind == "" {
		c.ForgeKind = "forgejo"
	}
	if c.ForgeKind != "forgejo" {
		return c, errors.New("GOLF_FORGE_KIND must be forgejo; Golf's portable backend is Forgejo")
	}
	if c.ForgeURL == "" {
		c.ForgeURL = "http://forgejo:3000"
	}
	if c.ForgeWorkflowDirs == "" {
		c.ForgeWorkflowDirs = workflowpath.ForgejoDirectories
	}
	dirs, err := workflowpath.Directories(c.ForgeWorkflowDirs)
	if err != nil {
		return c, err
	}
	c.ForgeWorkflowDirs = strings.Join(dirs, ",")
	if !forgeInstanceID.MatchString(c.ForgeInstanceID) {
		return c, errors.New("Forgejo requires GOLF_FORGE_INSTANCE_ID: a stable, unique lowercase UUID for this installation")
	}
	return c, nil
}

func (s *Server) forgeLabel() string {
	return "Forgejo"
}

// API qualification is tied to these exact server releases. A newer image needs
// its own contract and native behavior receipts before readiness can pass.
func supportedForgeVersion(kind, version string) bool {
	version = strings.TrimPrefix(version, "v")
	return kind == "forgejo" && (version == "15.0.9" || version == forgejoReportedVersion)
}

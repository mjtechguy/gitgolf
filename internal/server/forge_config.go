package server

import (
	"errors"
	"strings"

	"github.com/mjtechguy/golf-git/internal/workflowpath"
)

// NormalizeForgeConfig resolves internal storage/API field names before provider access.
func NormalizeForgeConfig(c Config) (Config, error) {
	if c.ForgeKind == "" {
		c.ForgeKind = "forgejo"
	}
	if c.ForgeKind != "forgejo" {
		return c, errors.New("GOLF_FORGE_KIND must be forgejo")
	}
	for _, alias := range []struct {
		current, legacy *string
		name            string
	}{
		{&c.ForgeURL, &c.GiteaURL, "URL"},
		{&c.ForgePublicURL, &c.GiteaPublicURL, "PUBLIC_URL"},
		{&c.ForgeOAuthClientID, &c.GiteaOAuthClientID, "OAUTH_CLIENT_ID"},
		{&c.ForgeOAuthClientSecret, &c.GiteaOAuthClientSecret, "OAUTH_CLIENT_SECRET"},
		{&c.ForgeWorkflowDirs, &c.GiteaWorkflowDirs, "WORKFLOW_DIRS"},
	} {
		if *alias.current != "" && *alias.legacy != "" && *alias.current != *alias.legacy {
			return c, errors.New("conflicting forge configuration aliases: " + alias.name)
		}
		if *alias.current != "" {
			*alias.legacy = *alias.current
		}
	}
	if c.GiteaURL == "" {
		c.GiteaURL = "http://" + c.ForgeKind + ":3000"
	}
	if c.GiteaWorkflowDirs == "" {
		c.GiteaWorkflowDirs = workflowpath.ForgejoDirectories
	}
	dirs, err := workflowpath.Directories(c.GiteaWorkflowDirs)
	if err != nil {
		return c, err
	}
	c.GiteaWorkflowDirs = strings.Join(dirs, ",")
	if !forgeInstanceID.MatchString(c.ForgeInstanceID) {
		return c, errors.New("Forgejo requires GOLF_FORGE_INSTANCE_ID: a stable, unique lowercase UUID for this installation")
	}
	if c.ForgeInstanceID != "" && !forgeInstanceID.MatchString(c.ForgeInstanceID) {
		return c, errors.New("GOLF_FORGE_INSTANCE_ID must be a lowercase UUID")
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
	return kind == "forgejo" && (version == "15.0.9" || version == "15.0.9+gitea-1.22.0")
}

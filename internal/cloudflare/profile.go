package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var profilePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`)
var errProfile = errors.New("Cloudflare inspection requires a valid named OAuth profile with access to the selected account and no environment credential overrides")

// InspectProfile delegates authentication to the installed cf CLI. Golf never
// opens its credential files. This is an operator command, not a product API.
func InspectProfile(ctx context.Context, accountID, namespace, profile string) (Report, error) {
	if !accountPattern.MatchString(accountID) || !namespacePattern.MatchString(namespace) || !profilePattern.MatchString(profile) {
		return Report{}, errProfile
	}
	for _, key := range []string{"CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL"} {
		if os.Getenv(key) != "" {
			return Report{}, errProfile
		}
	}
	data, err := profileCommand(ctx, accountID, profile, "auth", "whoami")
	if ctx.Err() != nil {
		return Report{}, ctx.Err()
	}
	var identity struct {
		Authenticated bool   `json:"authenticated"`
		TokenValid    bool   `json:"tokenValid"`
		AuthSource    string `json:"authSource"`
		Accounts      []struct {
			ID string `json:"id"`
		} `json:"accounts"`
	}
	if err != nil || json.Unmarshal(data, &identity) != nil || !identity.Authenticated || !identity.TokenValid || !strings.HasPrefix(identity.AuthSource, "OAuth token from ") || !strings.HasSuffix(identity.AuthSource, "/"+profile+".json") {
		return Report{}, errProfile
	}
	selected := false
	for _, account := range identity.Accounts {
		selected = selected || account.ID == accountID
	}
	if !selected {
		return Report{}, errProfile
	}

	report := Report{SchemaVersion: "golf.cloudflare.inspection.v1", AccountID: accountID, Namespace: namespace,
		CheckedAt: time.Now().UTC().Format(time.RFC3339Nano), Observations: make([]Observation, 0, 3)}
	for _, target := range []struct {
		service, scope string
		args           []string
	}{
		{"workers", "scripts_search_page_only", []string{"workers", "scripts", "search", "--per-page", "1"}},
		{"r2", "default_jurisdiction_bucket_page_only", []string{"r2", "buckets", "list", "--per-page", "1"}},
		{"artifacts", "namespace_repository_page_only", []string{"artifacts", "namespaces", "repos", "list", "--namespace", namespace, "--limit", "1"}},
	} {
		if ctx.Err() != nil {
			return Report{}, ctx.Err()
		}
		body, err := profileCommand(ctx, accountID, profile, target.args...)
		if ctx.Err() != nil {
			return Report{}, ctx.Err()
		}
		o := Observation{Service: target.service, Scope: target.scope, State: "unavailable"}
		if err == nil {
			o.State = "invalid_response"
			if validCollection(body, target.service == "r2") {
				o.State = "accessible"
			}
		}
		report.Observations = append(report.Observations, o)
	}
	return report, nil
}

func profileCommand(ctx context.Context, accountID, profile string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "cf", append([]string{"--profile", profile}, args...)...)
	cmd.WaitDelay = 250 * time.Millisecond
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case "CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID", "CF_SEND_TELEMETRY", "CI":
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Env = append(cmd.Env, "CLOUDFLARE_ACCOUNT_ID="+accountID, "CF_SEND_TELEMETRY=false", "CI=true")
	output := &profileOutput{cancel: cancel}
	cmd.Stdout, cmd.Stderr = output, io.Discard
	if err := cmd.Run(); err != nil {
		return nil, errors.New("Cloudflare CLI read failed")
	}
	if ctx.Err() != nil {
		return nil, errors.New("Cloudflare CLI read failed")
	}
	return output.buffer.Bytes(), nil
}

type profileOutput struct {
	buffer bytes.Buffer
	cancel context.CancelFunc
}

func (b *profileOutput) Write(p []byte) (int, error) {
	if len(p) > maxResponseBytes-b.buffer.Len() {
		b.cancel()
		return 0, errors.New("Cloudflare CLI output exceeded inspection limit")
	}
	return b.buffer.Write(p)
}

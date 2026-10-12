package cloudflare

import (
	"context"
	"net/http"
	"strings"
	"time"
)

const APIOrigin = "https://api.cloudflare.com"

func ValidManagementTarget(account, namespace string) bool {
	return accountPattern.MatchString(account) && (namespace == "" || namespacePattern.MatchString(namespace))
}

func ValidAPIToken(token string) bool {
	return token != "" && len(token) <= 8192 && strings.IndexFunc(token, func(r rune) bool { return r < 33 || r > 126 }) < 0
}

// InspectManagement reports independent read capabilities in the selected account.
// It creates no resources, does not verify write authority and never returns raw
// provider responses. An absent namespace probes namespace discovery instead.
func InspectManagement(ctx context.Context, account, namespace, token string) (Report, error) {
	client, close := inspectionClient()
	defer close()
	return inspectManagement(ctx, client, account, namespace, token)
}

func inspectManagement(ctx context.Context, client *http.Client, account, namespace, token string) (Report, error) {
	if !ValidManagementTarget(account, namespace) || !ValidAPIToken(token) {
		return Report{}, ErrConfiguration
	}
	client = &http.Client{Transport: client.Transport, Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	r := Report{SchemaVersion: "golf.cloudflare.management-inspection.v1", AccountID: account, Namespace: namespace,
		CheckedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	artifacts, scope := "/artifacts/namespaces?limit=1", "namespace_page_only"
	if namespace != "" {
		artifacts, scope = "/artifacts/namespaces/"+namespace+"/repos?limit=1", "namespace_repository_page_only"
	}
	for _, target := range []struct{ service, path, scope string }{
		{"workers", "/workers/scripts", "scripts_list_only"},
		{"r2", "/r2/buckets?per_page=1", "default_jurisdiction_bucket_page_only"},
		{"d1", "/d1/database?per_page=1", "database_page_only"},
		{"artifacts", artifacts, scope},
	} {
		if err := ctx.Err(); err != nil {
			return Report{}, err
		}
		o := observe(ctx, client, APIOrigin+"/client/v4/accounts/"+account+target.path, token)
		if err := ctx.Err(); err != nil {
			return Report{}, err
		}
		o.Service, o.Scope = target.service, target.scope
		r.Observations = append(r.Observations, o)
	}
	return r, nil
}

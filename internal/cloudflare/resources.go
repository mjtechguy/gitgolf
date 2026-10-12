package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

var ErrNotFound = errors.New("Cloudflare resource not found")
var ErrResponse = errors.New("Cloudflare resource response could not be verified")
var resourceName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)
var databaseID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

// ResourceClient never retries mutations or follows redirects. Its caller must
// journal dispatch before writes, retain ambiguous outcomes, and verify exact
// owned identities before deletion. Tokens and provider messages stay private.
type ResourceClient struct {
	account, token string
	client         *http.Client
	close          func()
}

func NewResourceClient(account, token string) (*ResourceClient, error) {
	if !ValidManagementTarget(account, "") || !ValidAPIToken(token) {
		return nil, ErrConfiguration
	}
	client, close := inspectionClient()
	return &ResourceClient{account: account, token: token, client: client, close: close}, nil
}

func (c *ResourceClient) Close() { c.close() }

func (c *ResourceClient) request(ctx context.Context, method, path string, input, output any) error {
	var raw []byte
	if input != nil {
		var err error
		raw, err = json.Marshal(input)
		if err != nil || len(raw) > 8192 {
			return ErrConfiguration
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, APIOrigin+"/client/v4/accounts/"+c.account+path, bytes.NewReader(raw))
	if err != nil {
		return ErrConfiguration
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	response, err := c.client.Do(req)
	if err != nil {
		return ErrResponse
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound && method == http.MethodGet {
		return ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ErrResponse
	}
	if response.StatusCode == http.StatusNoContent && method == http.MethodDelete {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return ErrResponse
	}
	var envelope struct {
		Success bool              `json:"success"`
		Result  json.RawMessage   `json:"result"`
		Errors  []json.RawMessage `json:"errors"`
	}
	if json.Unmarshal(body, &envelope) != nil || !envelope.Success || len(envelope.Errors) != 0 {
		return ErrResponse
	}
	if output != nil && (len(envelope.Result) == 0 || string(envelope.Result) == "null" || json.Unmarshal(envelope.Result, output) != nil) {
		return ErrResponse
	}
	return nil
}

type D1Database struct {
	ID   string `json:"uuid"`
	Name string `json:"name"`
}

// D1NameAbsent refuses any matching discovery result, including a near-name
// collision. Discovery never adopts resources or supplies deletion authority.
func (c *ResourceClient) D1NameAbsent(ctx context.Context, name string) (bool, error) {
	if !resourceName.MatchString(name) {
		return false, ErrConfiguration
	}
	var result []json.RawMessage
	err := c.request(ctx, http.MethodGet, "/d1/database?name="+url.QueryEscape(name)+"&per_page=1", nil, &result)
	if err == nil && result == nil {
		err = ErrResponse
	}
	return err == nil && len(result) == 0, err
}

func (c *ResourceClient) CreateD1(ctx context.Context, name string) (D1Database, error) {
	var result D1Database
	if !resourceName.MatchString(name) {
		return result, ErrConfiguration
	}
	err := c.request(ctx, http.MethodPost, "/d1/database", map[string]string{"name": name}, &result)
	if err == nil && (result.Name != name || !databaseID.MatchString(result.ID)) {
		err = ErrResponse
	}
	if err != nil {
		return D1Database{}, err
	}
	return result, nil
}

func (c *ResourceClient) GetD1(ctx context.Context, id string) (D1Database, error) {
	var result D1Database
	if !databaseID.MatchString(id) {
		return result, ErrConfiguration
	}
	err := c.request(ctx, http.MethodGet, "/d1/database/"+id, nil, &result)
	if err == nil && (result.ID != id || !resourceName.MatchString(result.Name)) {
		err = ErrResponse
	}
	if err != nil {
		return D1Database{}, err
	}
	return result, nil
}

func (c *ResourceClient) DeleteD1(ctx context.Context, id string) error {
	if !databaseID.MatchString(id) {
		return ErrConfiguration
	}
	return c.request(ctx, http.MethodDelete, "/d1/database/"+id, nil, nil)
}

type R2Bucket struct {
	Name      string `json:"name"`
	CreatedAt string `json:"creation_date"`
}

func (b R2Bucket) valid(name string) bool {
	stamp, e := time.Parse(time.RFC3339Nano, b.CreatedAt)
	return e == nil && !stamp.IsZero() && b.Name == name
}

func (c *ResourceClient) GetR2(ctx context.Context, name string) (R2Bucket, error) {
	var result R2Bucket
	if !resourceName.MatchString(name) {
		return result, ErrConfiguration
	}
	err := c.request(ctx, http.MethodGet, "/r2/buckets/"+name, nil, &result)
	if err == nil && !result.valid(name) {
		err = ErrResponse
	}
	if err != nil {
		return R2Bucket{}, err
	}
	return result, nil
}

func (c *ResourceClient) CreateR2(ctx context.Context, name string) (R2Bucket, error) {
	var result R2Bucket
	if !resourceName.MatchString(name) {
		return result, ErrConfiguration
	}
	err := c.request(ctx, http.MethodPost, "/r2/buckets", map[string]string{"name": name}, &result)
	if err == nil && !result.valid(name) {
		err = ErrResponse
	}
	if err != nil {
		return R2Bucket{}, err
	}
	return result, nil
}

// R2Private verifies both public serving routes without changing their settings.
// Missing fields, denied reads, or any custom domain fail closed.
func (c *ResourceClient) R2Private(ctx context.Context, name string) (bool, error) {
	if !resourceName.MatchString(name) {
		return false, ErrConfiguration
	}
	var managed struct {
		Enabled *bool `json:"enabled"`
	}
	if err := c.request(ctx, http.MethodGet, "/r2/buckets/"+name+"/domains/managed", nil, &managed); err != nil {
		return false, err
	}
	if managed.Enabled == nil {
		return false, ErrResponse
	}
	var custom struct {
		Domains []json.RawMessage `json:"domains"`
	}
	if err := c.request(ctx, http.MethodGet, "/r2/buckets/"+name+"/domains/custom", nil, &custom); err != nil {
		return false, err
	}
	if custom.Domains == nil {
		return false, ErrResponse
	}
	return !*managed.Enabled && len(custom.Domains) == 0, nil
}

func (c *ResourceClient) DeleteR2(ctx context.Context, name string) error {
	if !resourceName.MatchString(name) {
		return ErrConfiguration
	}
	return c.request(ctx, http.MethodDelete, "/r2/buckets/"+name, nil, nil)
}

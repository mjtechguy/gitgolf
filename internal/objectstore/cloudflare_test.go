package objectstore

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Explicit live qualification only. The operator owns provisioning and cleanup;
// the receipt lists every possible object key even when a check fails.
func TestCloudflareR2Live(t *testing.T) {
	if os.Getenv("GOLF_R2_LIVE_QUALIFICATION") != "1" {
		t.Skip("explicit disposable Cloudflare qualification only")
	}
	account, bucket := os.Getenv("GOLF_R2_LIVE_ACCOUNT_ID"), os.Getenv("GOLF_R2_LIVE_BUCKET")
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(account) || !regexp.MustCompile(`^golf-cf1-[0-9]{8}-[a-f0-9]{8}$`).MatchString(bucket) {
		t.Fatal("live qualification requires an explicit owned account and disposable bucket")
	}
	c := Config{Endpoint: "https://" + account + ".r2.cloudflarestorage.com", Bucket: bucket, Region: "auto", PathStyle: true,
		AccessKeyID: os.Getenv("GOLF_R2_LIVE_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("GOLF_R2_LIVE_SECRET_ACCESS_KEY")}
	if c.AccessKeyID == "" || c.SecretAccessKey == "" || os.Getenv("GOLF_R2_LIVE_RECEIPT") == "" {
		t.Fatal("live qualification requires explicit credentials and receipt path")
	}
	data, err := os.ReadFile(os.Getenv("GOLF_R2_LIVE_FIXTURE"))
	if err != nil || len(data) == 0 || len(data) > 64<<10 {
		t.Fatal("bounded source fixture is required")
	}
	sha := digest(data)
	key := "ci-sources/" + sha + ".tar"
	artifactKey := "ci-artifacts/00000000-0000-4000-8000-000000000001/" + strings.Repeat("a", 32) + "/" + sha + ".tar"
	corruptKey := strings.Replace(artifactKey, "/"+strings.Repeat("a", 32)+"/", "/"+strings.Repeat("b", 32)+"/", 1)
	raceKey := "ci-sources/" + strings.Repeat("f", 64) + ".tar"
	receipt := map[string]any{"schema_version": "golf.cloudflare.r2-live.v1", "account_id": account, "bucket": bucket,
		"fixture_sha256": sha, "fixture_bytes": len(data), "object_keys": []string{key, artifactKey, corruptKey, raceKey}, "state": "failed"}
	t.Cleanup(func() {
		encoded, _ := json.MarshalIndent(receipt, "", "  ")
		if err := os.WriteFile(os.Getenv("GOLF_R2_LIVE_RECEIPT"), append(encoded, '\n'), 0600); err != nil {
			t.Error("qualification receipt could not be written")
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	store, err := New(ctx, c)
	if err != nil {
		t.Fatal("R2 store configuration failed", err)
	}
	started := time.Now()
	for {
		err = store.ProbeBucket(ctx)
		if err == nil {
			break
		}
		receipt["initial_probe_state"] = err.Error() // Store errors are sanitized.
		if time.Since(started) >= 15*time.Second || (!errors.Is(err, ErrDenied) && !errors.Is(err, ErrUnavailable) && !errors.Is(err, ErrNotFound)) {
			t.Fatal("fresh R2 credential/bucket did not become ready", err)
		}
		time.Sleep(500 * time.Millisecond)
	}
	receipt["readiness_wait_ms"] = time.Since(started).Milliseconds()
	for range 2 {
		if err = store.PutImmutable(ctx, key, data, sha); err != nil {
			t.Fatal("R2 immutable create/replay failed", err)
		}
	}
	got, err := store.GetVerified(ctx, key, sha, int64(len(data)))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("R2 exact source readback failed", err)
	}
	changed := []byte("different conditional candidate")
	if err = store.PutImmutable(ctx, key, changed, digest(changed)); !errors.Is(err, ErrConflict) {
		t.Fatal("R2 conflicting source overwrote the original", err)
	}
	if _, err = store.GetVerified(ctx, key, sha, int64(len(data)-1)); !errors.Is(err, ErrTooLarge) {
		t.Fatal("R2 download size boundary failed", err)
	}
	if _, err = store.GetVerified(ctx, key, digest(changed), int64(len(data))); !errors.Is(err, ErrIntegrity) {
		t.Fatal("R2 source hash boundary failed", err)
	}
	for range 2 {
		if err = store.PutArtifactImmutable(ctx, artifactKey, data, sha); err != nil {
			t.Fatal("R2 immutable artifact create/replay failed", err)
		}
	}
	got, err = store.GetArtifactVerified(ctx, artifactKey, sha, int64(len(data)))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("R2 exact artifact readback failed", err)
	}
	_, err = store.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(bucket), Key: aws.String(corruptKey), Body: bytes.NewReader(changed), IfNoneMatch: aws.String("*")})
	if err != nil {
		t.Fatal("R2 independent corruption fixture failed", safeError(ctx, err))
	}
	if _, err = store.GetArtifactVerified(ctx, corruptKey, sha, int64(len(data))); !errors.Is(err, ErrIntegrity) {
		t.Fatal("R2 corrupt artifact released unverified bytes", err)
	}
	start, results := make(chan struct{}), make(chan string, 4)
	for i := range 4 {
		go func(i int) {
			<-start
			_, err := store.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(bucket), Key: aws.String(raceKey), Body: strings.NewReader(fmt.Sprintf("candidate-%d", i)), IfNoneMatch: aws.String("*")})
			if err == nil {
				results <- "created"
			} else {
				results <- apiCode(err)
			}
		}(i)
	}
	close(start)
	winners := 0
	for range 4 {
		code := <-results
		if code == "created" {
			winners++
		} else if code != "PreconditionFailed" && code != "ConditionalRequestConflict" {
			t.Fatal("R2 conditional race returned an unexpected state")
		}
	}
	if winners != 1 {
		t.Fatal("R2 conditional create did not have exactly one winner")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, _ := http.NewRequestWithContext(ctx, "GET", c.Endpoint+"/"+bucket+"/"+key, nil)
	response, err := client.Do(req)
	if err != nil {
		t.Fatal("R2 anonymous denial could not be observed")
	}
	var denial struct{ Code, Message string }
	body, readErr := io.ReadAll(io.LimitReader(response.Body, 4097))
	response.Body.Close()
	// R2's S3 endpoint rejects an absent Authorization header as HTTP400,
	// InvalidArgument/Authorization. This is distinct from an unrelated 400.
	missingAuth := readErr == nil && len(body) <= 4096 && xml.Unmarshal(body, &denial) == nil && denial.Code == "InvalidArgument" && denial.Message == "Authorization"
	if response.StatusCode != 401 && response.StatusCode != 403 && !(response.StatusCode == 400 && missingAuth) {
		t.Fatal("R2 anonymous request was not explicitly denied")
	}
	wrong := c
	wrong.SecretAccessKey = strings.Repeat("0", 64)
	denied, err := New(ctx, wrong)
	if err != nil {
		t.Fatal("R2 denial fixture configuration failed")
	}
	if _, err = denied.GetVerified(ctx, key, sha, int64(len(data))); !errors.Is(err, ErrDenied) {
		t.Fatal("R2 wrong credential was not denied", err)
	}
	got, err = store.GetVerified(ctx, key, sha, int64(len(data)))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("R2 conditional/denial checks changed original bytes")
	}
	receipt["state"], receipt["conditional_race_winners"], receipt["anonymous_http_status"] = "passed", winners, response.StatusCode
	t.Log("real R2 source/artifact create, replay, conflict, readback, integrity, size, race and credential denial passed")
}

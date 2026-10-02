package objectstore

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// This proof is deliberately opt-in: it creates and removes only its own Docker
// container and volume. It never reuses an operator bucket or existing service.
func TestRustFSConditionalImmutableStorage(t *testing.T) {
	image := os.Getenv("GOLF_RUSTFS_TEST_IMAGE")
	if image == "" {
		t.Skip("set GOLF_RUSTFS_TEST_IMAGE to the pinned RustFS image for native qualification")
	}
	if image != "rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff" {
		t.Fatal("qualification requires the documented immutable RustFS image")
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		t.Fatal("random fixture identity unavailable")
	}
	suffix := hex.EncodeToString(random)
	name := "golf-rustfs-proof-" + suffix[:12]
	volume := name + "-data"
	secret := hex.EncodeToString(random) + hex.EncodeToString(random)
	envFile := filepath.Join(t.TempDir(), "rustfs.env")
	if err := os.WriteFile(envFile, []byte("RUSTFS_ACCESS_KEY=proof-"+suffix+"\nRUSTFS_SECRET_KEY="+secret+"\nRUSTFS_VOLUMES=/data\nRUSTFS_CONSOLE_ENABLE=false\nRUSTFS_ADDRESS=0.0.0.0:9000\nRUSTFS_OBS_LOGGER_LEVEL=error\n"), 0600); err != nil {
		t.Fatal("fixture configuration unavailable")
	}
	docker := func(args ...string) []byte {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		result, err := exec.CommandContext(ctx, "docker", args...).Output()
		if err != nil {
			t.Fatalf("fixture Docker %s failed (output withheld)", args[0])
		}
		return result
	}
	docker("volume", "create", volume)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := exec.CommandContext(ctx, "docker", "rm", "-f", name).Run(); err != nil {
			t.Error("fixture container cleanup failed")
		}
		if err := exec.CommandContext(ctx, "docker", "volume", "rm", volume).Run(); err != nil {
			t.Error("fixture volume cleanup failed")
		}
	})
	docker("run", "-d", "--name", name, "--env-file", envFile, "--publish", "127.0.0.1::9000", "--mount", "type=volume,source="+volume+",target=/data", "--tmpfs", "/logs:uid=10001,gid=10001,mode=0750,size=32m", "--memory", "1g", "--cpus", "2", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", image)
	var ports map[string][]struct{ HostIP, HostPort string }
	if err := json.Unmarshal(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", name), &ports); err != nil || len(ports["9000/tcp"]) != 1 {
		t.Fatal("fixture loopback port unavailable")
	}
	endpoint := "http://127.0.0.1:" + ports["9000/tcp"][0].HostPort
	ready := func() {
		t.Helper()
		client := &http.Client{Timeout: time.Second}
		deadline := time.Now().Add(45 * time.Second)
		for time.Now().Before(deadline) {
			r, e := client.Get(endpoint + "/health")
			if e == nil {
				r.Body.Close()
				if r.StatusCode == 200 {
					return
				}
			}
			time.Sleep(250 * time.Millisecond)
		}
		t.Logf("fixture state %s", strings.TrimSpace(string(docker("inspect", "--format", "{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}", name))))
		t.Fatal("RustFS health did not become ready (logs withheld)")
	}
	ready()
	c := testConfig(endpoint)
	c.AccessKeyID = "proof-" + suffix
	c.SecretAccessKey = secret
	c.Bucket = "golf-" + suffix[:20]
	store, err := New(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.CreateBucket(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = store.ProbeBucket(context.Background()); err != nil {
		t.Fatal(err)
	}
	data := []byte("private source snapshot\n")
	key := sourceKey(data)
	if err = store.PutImmutable(context.Background(), key, data, digest(data)); err != nil {
		t.Fatal(err)
	}
	if err = store.PutImmutable(context.Background(), key, data, digest(data)); err != nil {
		t.Fatal(err)
	}
	// A raw SDK competing write proves the provider enforced the condition,
	// independently of the adapter's own digest readback.
	objectKey, _ := store.objectKey(key, digest(data))
	_, err = store.client.PutObject(context.Background(), &s3.PutObjectInput{Bucket: aws.String(c.Bucket), Key: aws.String(objectKey), Body: strings.NewReader("replacement"), IfNoneMatch: aws.String("*")})
	if apiCode(err) != "PreconditionFailed" {
		t.Fatal("RustFS did not reject replacement with native PreconditionFailed")
	}
	if err = store.PutImmutable(context.Background(), key, []byte("replacement"), digest([]byte("replacement"))); !errors.Is(err, ErrConflict) {
		t.Fatal("adapter failed to report existing-content conflict")
	}
	got, err := store.GetVerified(context.Background(), key, digest(data), 100)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("original source was not preserved")
	}
	t.Log("native conditional rejection, identical replay and original content verification passed")
	// Simultaneous fresh conditional writes must produce exactly one winner.
	raceKey := "installation-one/ci-sources/" + strings.Repeat("f", 64) + ".tar"
	start := make(chan struct{})
	results := make(chan string, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, e := store.client.PutObject(context.Background(), &s3.PutObjectInput{Bucket: aws.String(c.Bucket), Key: aws.String(raceKey), Body: strings.NewReader(fmt.Sprintf("candidate-%d", i)), IfNoneMatch: aws.String("*")})
			if e == nil {
				results <- "success"
			} else {
				results <- apiCode(e)
			}
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	successes := 0
	for code := range results {
		if code == "success" {
			successes++
		} else if code != "PreconditionFailed" && code != "ConditionalRequestConflict" {
			t.Fatal("unexpected conditional race outcome")
		}
	}
	if successes != 1 {
		t.Fatal("conditional race did not have exactly one winner")
	}
	t.Log("eight native concurrent creates produced one winner")
	if _, err = store.GetVerified(context.Background(), key, digest(data), 1); !errors.Is(err, ErrTooLarge) {
		t.Fatal("download cap not enforced")
	}
	if _, err = store.GetVerified(context.Background(), key, digest([]byte("wrong hash")), 100); !errors.Is(err, ErrIntegrity) {
		t.Fatal("download integrity not enforced")
	}
	wrong := c
	wrong.SecretAccessKey = "wrong-fixture-secret"
	denied, _ := New(context.Background(), wrong)
	if err = denied.ProbeBucket(context.Background()); err != ErrDenied {
		t.Fatal("invalid credentials not denied safely")
	}
	docker("restart", name)
	// Docker can allocate a new host port when an ephemeral port is restarted.
	if err := json.Unmarshal(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", name), &ports); err != nil || len(ports["9000/tcp"]) != 1 {
		t.Fatal("restarted fixture loopback port unavailable")
	}
	endpoint = "http://127.0.0.1:" + ports["9000/tcp"][0].HostPort
	c.Endpoint = endpoint
	store, err = New(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	ready()
	got, err = store.GetVerified(context.Background(), key, digest(data), 100)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("persistent source did not survive restart")
	}
	t.Log("private credential denial, bounds, SHA verification and actual RustFS restart passed")
}

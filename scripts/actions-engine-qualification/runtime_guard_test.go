package actionsengineproof

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/sirupsen/logrus"
)

func TestRuntimeGateOwnedFixtures(t *testing.T) {
	for _, source := range []string{graphFixture, hangFixture, failureFixture} {
		for _, event := range []string{"push", "workflow_dispatch"} {
			if _, err := runtimePlan(source, event); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestRuntimeGateRefusesBeforeEngineExpansion(t *testing.T) {
	cases := map[string]string{
		"host":                    strings.Replace(graphFixture, "golf-qualification", "self-hosted", 1),
		"dynamic label":           strings.Replace(graphFixture, "golf-qualification", "${{ matrix.label }}", 1),
		"remote":                  strings.Replace(graphFixture, "./actions/owned-composite", "actions/checkout@v7", 1),
		"docker":                  strings.Replace(graphFixture, "./actions/owned-composite", "docker://alpine:latest", 1),
		"mount":                   strings.Replace(graphFixture, "    outputs:", "    container:\n      image: alpine\n      volumes: ['/var/run/docker.sock:/var/run/docker.sock']\n    outputs:", 1),
		"service":                 strings.Replace(graphFixture, "    outputs:", "    services:\n      db:\n        image: postgres\n    outputs:", 1),
		"policy not enforced":     "permissions: write-all\n" + graphFixture,
		"unknown":                 "golf_unknown: true\n" + graphFixture,
		"alias":                   strings.Replace(graphFixture, "env:\n  OWNED_ENV: explicit", "env: &owned\n  OWNED_ENV: explicit\nextra: *owned", 1),
		"duplicate":               "name: duplicate\n" + graphFixture,
		"oversize":                strings.Repeat("# owned\n", 5000) + graphFixture,
		"matrix":                  strings.Replace(graphFixture, "cell: [a, b]", "cell: [a,b,c,d,e,f,g,h]\n        second: [a,b]", 1),
		"dynamic matrix":          strings.Replace(graphFixture, "cell: [a, b]", "cell: ['${{ inputs.cell }}']", 1),
		"explicit shell override": strings.Replace(graphFixture, "      - id: emit", "      - id: emit\n        shell: bash", 1),
		"step unknown control":    strings.Replace(graphFixture, "      - id: emit", "      - id: emit\n        timeout-minutes: 5", 1),
	}
	for name, source := range cases {
		t.Run(name, func(t *testing.T) {
			if plan, err := runtimePlan(source, "push"); err == nil || plan != nil {
				t.Fatal("refused fixture reached engine plan")
			}
		})
	}
	if _, err := runtimePlan(graphFixture, "schedule"); err == nil {
		t.Fatal("unsupported event admitted")
	}
}

func TestRuntimeContainerReceipt(t *testing.T) {
	image := "sha256:" + strings.Repeat("a", 64)
	valid := map[string]any{
		"Image":      image,
		"Config":     map[string]any{"User": "1000:1000", "Env": []string{"PATH=/bin", "GITHUB_ACTIONS=true"}},
		"HostConfig": map[string]any{"NetworkMode": "none", "CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges"}, "Memory": 268435456, "MemorySwap": 268435456, "NanoCpus": 1000000000, "PidsLimit": 64},
		"Mounts":     []map[string]string{{"Type": "volume", "Destination": runtimeWorkspace}, {"Type": "volume", "Destination": "/var/run/act"}},
	}
	encode := func() []byte {
		b, err := json.Marshal([]any{valid})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	if err := verifyContainer(encode(), image); err != nil {
		t.Fatal(err)
	}
	host := valid["HostConfig"].(map[string]any)
	for key, value := range map[string]any{"NetworkMode": "host", "Privileged": true, "Binds": []string{"/var/run/docker.sock:/var/run/docker.sock"}, "CapAdd": []string{"SYS_ADMIN"}, "Memory": 0, "MemorySwap": -1, "NanoCpus": 0, "PidsLimit": nil, "Devices": []string{"owned"}} {
		t.Run(key, func(t *testing.T) {
			original := host[key]
			host[key] = value
			defer func() { host[key] = original }()
			if verifyContainer(encode(), image) == nil {
				t.Fatal("unsafe actual receipt accepted")
			}
		})
	}
	valid["Mounts"] = []map[string]string{{"Type": "bind", "Destination": runtimeWorkspace}}
	if verifyContainer(encode(), image) == nil {
		t.Fatal("host mount accepted")
	}
}

func TestRuntimeRawOutputNeverCreatesTrustedProgress(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o := &runtimeObserver{cancel: cancel}
	if err := o.Fire(&logrus.Entry{Data: logrus.Fields{"raw_output": true, "jobID": "invented", "stepResult": "success"}, Message: `{"jobID":"invented","stepResult":"success"}`}); err != nil {
		t.Fatal(err)
	}
	if o.raw != 1 || o.finished != 0 || o.err != nil || ctx.Err() != nil {
		t.Fatal("raw source output promoted to engine progress")
	}
}

func TestRuntimeRefusesAmbientDaemonWithoutDocker(t *testing.T) {
	t.Setenv("DOCKER_HOST", "tcp://127.0.0.1:2375")
	t.Setenv("GOLF_OWNED_ENGINE_DAEMON", "1")
	if _, err := RunOffline("sha256:"+strings.Repeat("a", 64), "graph", "push"); err == nil {
		t.Fatal("ambient daemon accepted")
	}
	if _, err := RunOffline("alpine:latest", "graph", "push"); err == nil {
		t.Fatal("mutable image accepted")
	}
}

func TestRuntimeOwnedSetupRefusesHostPaths(t *testing.T) {
	for _, source := range []string{"/tmp", "/var/run/docker.sock", "/var/lib/docker/volumes/../outside/_data"} {
		body, _ := json.Marshal([]any{map[string]any{"Mounts": []any{map[string]string{"Type": "volume", "Source": source}}}})
		if count, err := initializeOwnedVolumes(body); err == nil || count != 0 {
			t.Fatal("host path admitted as owned setup")
		}
	}
}

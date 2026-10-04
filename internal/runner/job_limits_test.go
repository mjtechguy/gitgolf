package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestJobLimitsBoundedCanonicalProfile(t *testing.T) {
	defaults := DefaultJobLimits()
	lower := JobLimits{250, "67108864", 16, 30}
	if defaults.Validate() != nil || lower.Validate() != nil || !lower.Within(defaults) || defaults.Within(lower) || MinimumJobLimits(defaults, lower) != lower {
		t.Fatal("invalid ceiling intersection")
	}
	for _, edit := range []func(*JobLimits){func(l *JobLimits) { l.CPUMillis = 0 }, func(l *JobLimits) { l.CPUMillis = 1001 }, func(l *JobLimits) { l.MemoryBytes = "067108864" }, func(l *JobLimits) { l.MemoryBytes = "+67108864" }, func(l *JobLimits) { l.MemoryBytes = "67108863" }, func(l *JobLimits) { l.MemoryBytes = "268435457" }, func(l *JobLimits) { l.MemoryBytes = "256m" }, func(l *JobLimits) { l.Pids = 65 }, func(l *JobLimits) { l.Pids = 15 }, func(l *JobLimits) { l.TimeoutSeconds = 0 }, func(l *JobLimits) { l.TimeoutSeconds = 901 }} {
		l := defaults
		edit(&l)
		if l.Validate() == nil {
			t.Fatalf("accepted malformed limits: %+v", l)
		}
	}
	if !reflect.DeepEqual(lower.DockerOptions(), []string{"--cpus=0.250", "--memory=67108864", "--memory-swap=67108864", "--pids-limit=16"}) {
		t.Fatal("limits not forwarded literally")
	}
}
func TestJobResourceBindingRequiresExactImmutableAdmission(t *testing.T) {
	b := JobResourceBinding{Profile: JobLimitsProfile, Limits: DefaultJobLimits(), InstanceVersion: "0", PlacementVersion: "0", Bound: true}
	if b.Validate() != nil {
		t.Fatal("explicit version-zero admission refused")
	}
	for _, edit := range []func(*JobResourceBinding){func(b *JobResourceBinding) { b.Bound = false }, func(b *JobResourceBinding) { b.Profile = "arbitrary" }, func(b *JobResourceBinding) { b.InstanceVersion = "01" }, func(b *JobResourceBinding) { b.PlacementVersion = "-1" }, func(b *JobResourceBinding) { b.PoolID = "-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaaaaa"; b.PoolVersion = "1" }, func(b *JobResourceBinding) { b.PoolVersion = "1" }, func(b *JobResourceBinding) { b.PoolID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; b.PoolVersion = "0" }} {
		v := b
		edit(&v)
		if v.Validate() == nil {
			t.Fatal("invalid binding accepted")
		}
	}
	b.PoolID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	b.PoolVersion = "1"
	b.PlacementVersion = "1"
	if b.Validate() != nil {
		t.Fatal("exact bound pool refused")
	}
}
func TestContainerResourceReceiptBeforeSourceTransfer(t *testing.T) {
	limits := JobLimits{250, "67108864", 16, 30}
	id := strings.Repeat("a", 64)
	base := map[string]any{"Id": id, "HostConfig": map[string]any{"Memory": int64(67108864), "MemorySwap": int64(67108864), "NanoCpus": int64(250000000), "PidsLimit": int64(16)}}
	for _, field := range []string{"", "Memory", "MemorySwap", "NanoCpus", "PidsLimit", "Id"} {
		t.Run(field, func(t *testing.T) {
			receipt := base
			h := map[string]any{}
			for k, v := range base["HostConfig"].(map[string]any) {
				h[k] = v
			}
			receipt = map[string]any{"Id": id, "HostConfig": h}
			if field == "Id" {
				receipt["Id"] = strings.Repeat("b", 64)
			} else if field != "" {
				h[field] = 0
			}
			raw, _ := json.Marshal([]any{receipt})
			script := filepath.Join(t.TempDir(), "docker")
			if os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s' '"+string(raw)+"'\n"), 0700) != nil {
				t.Fatal("fixture")
			}
			e, _ := New(Config{WorkerID: "owned", DockerBinary: script, ApprovedImages: []string{"sha256:" + strings.Repeat("b", 64)}})
			err := e.inspectJobLimits(context.Background(), id, limits)
			if (err == nil) != (field == "") {
				t.Fatal("incorrect resource receipt acceptance")
			}
		})
	}
}

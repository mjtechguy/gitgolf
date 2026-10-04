package runner

import (
	"regexp"
	"strconv"
)

const JobLimitsCapability = "golf.runner.job-limits.v1"

var poolResourceID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

const JobLimitsProfile = "golf.local-docker.restrict.v1"

// Timeout is the entire attempt budget, shared by every shell/Actions job.
// This profile can only restrict the formerly fixed local-Docker bounds.
type JobLimits struct {
	CPUMillis      uint32 `json:"cpuMillis"`
	MemoryBytes    string `json:"memoryBytes"`
	Pids           uint32 `json:"pids"`
	TimeoutSeconds uint32 `json:"timeoutSeconds"`
}

func DefaultJobLimits() JobLimits { return JobLimits{1000, "268435456", 64, 900} }
func (l JobLimits) Memory() int64 { n, _ := strconv.ParseInt(l.MemoryBytes, 10, 64); return n }
func (l JobLimits) Validate() error {
	n, e := strconv.ParseInt(l.MemoryBytes, 10, 64)
	if e != nil || strconv.FormatInt(n, 10) != l.MemoryBytes || n < 64<<20 || n > 256<<20 || l.CPUMillis < 100 || l.CPUMillis > 1000 || l.Pids < 16 || l.Pids > 64 || l.TimeoutSeconds < 1 || l.TimeoutSeconds > 900 {
		return ErrInvalidJob
	}
	return nil
}
func (l JobLimits) Within(parent JobLimits) bool {
	return l.Validate() == nil && parent.Validate() == nil && l.CPUMillis <= parent.CPUMillis && l.Memory() <= parent.Memory() && l.Pids <= parent.Pids && l.TimeoutSeconds <= parent.TimeoutSeconds
}
func MinimumJobLimits(a, b JobLimits) JobLimits {
	return JobLimits{min(a.CPUMillis, b.CPUMillis), strconv.FormatInt(min(a.Memory(), b.Memory()), 10), min(a.Pids, b.Pids), min(a.TimeoutSeconds, b.TimeoutSeconds)}
}
func (l JobLimits) DockerOptions() []string {
	return []string{"--cpus=" + strconv.FormatFloat(float64(l.CPUMillis)/1000, 'f', 3, 64), "--memory=" + l.MemoryBytes, "--memory-swap=" + l.MemoryBytes, "--pids-limit=" + strconv.FormatUint(uint64(l.Pids), 10)}
}

type JobResourceBinding struct {
	Profile          string    `json:"profile"`
	Limits           JobLimits `json:"limits"`
	InstanceVersion  string    `json:"instanceVersion"`
	PoolID           string    `json:"poolId"`
	PoolVersion      string    `json:"poolVersion"`
	PlacementVersion string    `json:"placementVersion"`
	Bound            bool      `json:"bound"`
}

func (b JobResourceBinding) Validate() error {
	version := func(value string) bool {
		n, e := strconv.ParseInt(value, 10, 64)
		return e == nil && n >= 0 && strconv.FormatInt(n, 10) == value
	}
	if !b.Bound || b.Profile != JobLimitsProfile || b.Limits.Validate() != nil || !version(b.InstanceVersion) || !version(b.PlacementVersion) || (b.PoolID == "") != (b.PoolVersion == "") {
		return ErrInvalidJob
	}
	if b.PoolID != "" && (!poolResourceID.MatchString(b.PoolID) || !version(b.PoolVersion) || b.PoolVersion == "0" || b.PlacementVersion == "0") {
		return ErrInvalidJob
	}
	return nil
}

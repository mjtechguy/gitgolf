package actionsengine

import (
	"context"
	"encoding/json"
	"path"
	"regexp"
	"strconv"
)

// Native local-driver tmpfs volumes enforce byte and inode ceilings. These
// options belong to the trusted engine, never to workflow container options.
const jobDiskProfile = "golf.actions.job-disk.tmpfs.v1"
const jobTemporaryTmpfs = "rw,nosuid,nodev,size=33554432,nr_inodes=8192,mode=1777"

var jobVolumeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)

func jobVolumeOptions(destination string) map[string]string {
	return jobVolumeOptionsProfile(destination, false)
}

func jobVolumeOptionsProfile(destination string, remote bool) map[string]string {
	var size int
	inodes := 8192
	switch destination {
	case workspace:
		size = 128 << 20
	case "/var/run/act":
		size = 32 << 20
	case "/opt/hostedtoolcache":
		size = 64 << 20
	default:
		return nil
	}
	if remote {
		inodes = 32768
		if destination == "/var/run/act" || destination == "/opt/hostedtoolcache" {
			size = 256 << 20
		}
	}
	return map[string]string{"type": "tmpfs", "device": "tmpfs", "o": "rw,nosuid,nodev,size=" + strconv.Itoa(size) + ",nr_inodes=" + strconv.Itoa(inodes) + ",uid=1000,gid=1000,mode=0755"}
}

func verifyJobVolume(ctx context.Context, name, destination string) error {
	return verifyJobVolumeProfile(ctx, name, destination, false)
}

func verifyJobVolumeProfile(ctx context.Context, name, destination string, remote bool) error {
	want := jobVolumeOptionsProfile(destination, remote)
	if want == nil || !jobVolumeName.MatchString(name) {
		return ErrExecution
	}
	body, err := docker(ctx, nil, "volume", "inspect", name)
	var rows []struct {
		Name, Driver, Scope, Mountpoint string
		Options, Labels                 map[string]string
	}
	if err != nil || json.Unmarshal(body, &rows) != nil || len(rows) != 1 {
		return ErrExecution
	}
	r := rows[0]
	if r.Name != name || r.Driver != "local" || r.Scope != "local" || r.Mountpoint != path.Join("/var/lib/docker/volumes", name, "_data") || len(r.Options) != len(want) {
		return ErrExecution
	}
	for key, value := range want {
		if r.Options[key] != value {
			return ErrExecution
		}
	}
	return nil
}

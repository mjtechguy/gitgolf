package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const maxOCIBytes = 32 << 20

var ociDigest = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var errBuildRejected = errors.New("approved single-base Dockerfile required")
var errBuildFailed = errors.New("Dockerfile build failed")

// The operator's rootless daemon owns BuildKit. Source containers receive no daemon socket.
func socketlessBuild(ctx context.Context, source, imageRef, imageID, output string) (string, int64, error) {
	info, err := os.ReadFile(filepath.Join(source, "Dockerfile"))
	if err != nil || len(info) < 1 || len(info) > 32<<10 || !approvedDockerfile(string(info), imageRef) {
		return "", 0, errBuildRejected
	}
	security, err := buildCommand(ctx, "info", "--format", "{{json .SecurityOptions}}")
	if err != nil || !bytes.Contains(security, []byte(`"name=rootless"`)) {
		return "", 0, errors.New("socketless build requires a rootless Docker daemon")
	}
	builder, err := buildCommand(ctx, "buildx", "inspect")
	if err != nil || !regexp.MustCompile(`(?m)^Driver:\s+docker\s*$`).Match(builder) {
		return "", 0, errors.New("socketless build requires the local Docker BuildKit driver")
	}
	selected, err := buildCommand(ctx, "context", "show")
	if err != nil || !bytes.Contains(builder, []byte("Endpoint:         "+strings.TrimSpace(string(selected)))) {
		return "", 0, errors.New("builder and rootless daemon differ")
	}
	actual, err := buildCommand(ctx, "image", "inspect", "--format", "{{.Id}}", imageRef)
	if err != nil || strings.TrimSpace(string(actual)) != imageID {
		return "", 0, errors.New("approved local build base changed")
	}
	file, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	complete := false
	defer func() {
		if !complete {
			_ = os.Remove(output)
		}
	}()
	cmd := exec.CommandContext(ctx, "docker", "buildx", "build", "--network", "none", "--pull=false", "--progress", "quiet", "--output", "type=oci,dest=-", "--file", "Dockerfile", source)
	cmd.Dir = source
	cmd.Stderr = io.Discard
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", 0, err
	}
	if err = cmd.Start(); err != nil {
		return "", 0, err
	}
	count, copyErr := io.Copy(file, io.LimitReader(pipe, maxOCIBytes+1))
	if copyErr != nil || count > maxOCIBytes {
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	if waitErr != nil && ctx.Err() == nil && copyErr == nil && count <= maxOCIBytes {
		return "", 0, errBuildFailed
	}
	if copyErr != nil || waitErr != nil || count < 1 || count > maxOCIBytes || file.Sync() != nil {
		return "", 0, errors.New("bounded socketless build failed")
	}
	digest, err := verifyOCI(output)
	if err != nil {
		return "", 0, err
	}
	complete = true
	return digest, count, nil
}

func buildCommand(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Stderr = io.Discard
	var output bytes.Buffer
	cmd.Stdout = &output
	if err := cmd.Run(); err != nil || output.Len() > 16<<10 {
		return nil, errors.New("builder qualification unavailable")
	}
	return output.Bytes(), nil
}

func approvedDockerfile(source, imageRef string) bool {
	if strings.ContainsRune(source, 0) || strings.Contains(source, "\r") || strings.Contains(source, "\\\n") {
		return false
	}
	first := false
	for _, row := range strings.Split(source, "\n") {
		line := strings.TrimSpace(row)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			if strings.HasPrefix(strings.ToLower(line), "# syntax") || strings.HasPrefix(strings.ToLower(line), "# escape") {
				return false
			}
			continue
		}
		parts := strings.Fields(line)
		if len(parts) == 0 {
			continue
		}
		instruction := strings.ToUpper(parts[0])
		if !first {
			if instruction != "FROM" || len(parts) != 2 || parts[1] != imageRef {
				return false
			}
			first = true
			continue
		}
		if !map[string]bool{"RUN": true, "COPY": true, "WORKDIR": true, "ENV": true, "ARG": true, "LABEL": true, "USER": true, "CMD": true, "ENTRYPOINT": true, "EXPOSE": true, "VOLUME": true, "HEALTHCHECK": true, "STOPSIGNAL": true}[instruction] ||
			instruction == "COPY" && strings.Contains(strings.ToLower(line), "--from") ||
			instruction == "RUN" && (strings.Contains(strings.ToLower(line), "--mount") || strings.Contains(strings.ToLower(line), "--network") || strings.Contains(strings.ToLower(line), "--security")) {
			return false
		}
	}
	return first
}

func verifyOCI(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	reader := tar.NewReader(file)
	var index []byte
	layout := false
	blobs := map[string]bool{}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil || header == nil || header.Size < 0 || header.Size > maxOCIBytes {
			return "", errors.New("invalid OCI output")
		}
		if header.Typeflag == tar.TypeDir {
			continue
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return "", errors.New("invalid OCI entry")
		}
		body, err := io.ReadAll(io.LimitReader(reader, header.Size+1))
		if err != nil || int64(len(body)) != header.Size {
			return "", errors.New("truncated OCI output")
		}
		if header.Name == "index.json" {
			if index != nil || len(body) > 64<<10 {
				return "", errors.New("invalid OCI index")
			}
			index = body
		} else if header.Name == "oci-layout" {
			if layout || string(body) != `{"imageLayoutVersion":"1.0.0"}` {
				return "", errors.New("invalid OCI layout")
			}
			layout = true
		} else if strings.HasPrefix(header.Name, "blobs/sha256/") && len(header.Name) == len("blobs/sha256/")+64 {
			sum := sha256.Sum256(body)
			if header.Name != "blobs/sha256/"+hex.EncodeToString(sum[:]) || blobs[header.Name] {
				return "", errors.New("invalid OCI blob")
			}
			blobs[header.Name] = true
		} else {
			return "", errors.New("unexpected OCI output entry")
		}
	}
	var document struct {
		SchemaVersion int `json:"schemaVersion"`
		Manifests     []struct {
			Digest    string `json:"digest"`
			MediaType string `json:"mediaType"`
		} `json:"manifests"`
	}
	if !layout || json.Unmarshal(index, &document) != nil || document.SchemaVersion != 2 || len(document.Manifests) != 1 ||
		!ociDigest.MatchString(document.Manifests[0].Digest) || document.Manifests[0].MediaType != "application/vnd.oci.image.manifest.v1+json" ||
		!blobs["blobs/sha256/"+strings.TrimPrefix(document.Manifests[0].Digest, "sha256:")] {
		return "", errors.New("invalid OCI manifest")
	}
	return document.Manifests[0].Digest, nil
}

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Only the trusted parent talks to Golf. The result is opaque PACK input for
// native index-pack in a network-free, resource-bounded disposable container.
// This preparation contract is not a job checkout token or Actions capability.
func (c *coordinator) fetchGitPack(ctx context.Context, a assignment, workflowBlobID string) ([]byte, error) {
	if !c.verifyingHTTPS() || !safeID.MatchString(c.id) || !tokenOK(c.key) || !attemptID.MatchString(a.AttemptID) || !tokenOK(a.AttemptToken) || !commitID.MatchString(a.CommitID) || !commitID.MatchString(workflowBlobID) || len(a.CommitID) != len(workflowBlobID) {
		return nil, errTransport
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	advertisement, err := c.gitPreparationRead(ctx, a, workflowBlobID, "/info/refs?service=git-upload-pack", nil)
	if err != nil {
		return nil, err
	}
	format, err := gitPackAdvertisement(advertisement, a.CommitID)
	if err != nil {
		return nil, err
	}
	body := preparedGitPacket("want " + a.CommitID + " no-progress ofs-delta" + format + "\n")
	body = append(body, preparedGitPacket("deepen 1\n")...)
	body = append(body, []byte("0000")...)
	body = append(body, preparedGitPacket("done\n")...)
	result, err := c.gitPreparationRead(ctx, a, workflowBlobID, "/git-upload-pack", body)
	if err != nil {
		return nil, err
	}
	return gitPackResult(result, a.CommitID)
}

func (c *coordinator) gitPreparationRead(ctx context.Context, a assignment, blob, suffix string, body []byte) ([]byte, error) {
	method, content, limit := http.MethodGet, "application/x-git-upload-pack-advertisement", int64(2<<20)
	if suffix == "/git-upload-pack" && len(body) > 0 && len(body) <= 4096 {
		method, content, limit = http.MethodPost, "application/x-git-upload-pack-result", 64<<20
	} else if suffix != "/info/refs?service=git-upload-pack" || len(body) != 0 {
		return nil, errTransport
	}
	request, err := http.NewRequestWithContext(ctx, method, c.origin+"/internal/ci/attempt/"+a.AttemptID+"/git"+suffix, bytes.NewReader(body))
	if err != nil {
		return nil, errTransport
	}
	request.Header.Set("Authorization", "Bearer "+c.key)
	request.Header.Set("Golf-Runner-ID", c.id)
	request.Header.Set("Golf-Attempt-Token", a.AttemptToken)
	request.Header.Set("Accept-Encoding", "identity")
	if method == http.MethodPost {
		request.Header.Set("Content-Type", "application/x-git-upload-pack-request")
	}
	client := *c.client
	client.Jar = nil
	if client.Timeout <= 0 || client.Timeout > 15*time.Second {
		client.Timeout = 15 * time.Second
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return nil, errTransport
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || !c.verifiedResponseTLS(response) || response.ContentLength > limit || response.Uncompressed || len(response.Header.Values("Content-Encoding")) != 0 {
		return nil, errTransport
	}
	for name, value := range map[string]string{"Content-Type": content, "Golf-Source-Commit": a.CommitID, "Golf-Workflow-Blob": blob, "Cache-Control": "no-store"} {
		if len(response.Header.Values(name)) != 1 || response.Header.Get(name) != value {
			return nil, errTransport
		}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit || ctx.Err() != nil {
		return nil, errTransport
	}
	return data, nil
}

func preparedGitPacket(value string) []byte {
	return []byte(fmt.Sprintf("%04x%s", len(value)+4, value))
}

// v0 control framing only. Binary PACK contents are never scanned as pkt-lines.
func preparedGitReadPacket(data []byte) (row, rest []byte, flush bool, err error) {
	if len(data) < 4 {
		return nil, nil, false, errTransport
	}
	for _, value := range data[:4] {
		if value < '0' || value > '9' && (value < 'a' || value > 'f') {
			return nil, nil, false, errTransport
		}
	}
	n, parseErr := strconv.ParseUint(string(data[:4]), 16, 16)
	if parseErr != nil || n > 65520 || n > uint64(len(data)) || n > 0 && n < 4 {
		return nil, nil, false, errTransport
	}
	if n == 0 {
		return nil, data[4:], true, nil
	}
	return data[4:n], data[n:], false, nil
}

func gitPackAdvertisement(data []byte, commit string) (format string, err error) {
	if !commitID.MatchString(commit) || len(data) > 2<<20 {
		return "", errTransport
	}
	first, rest, flush, err := preparedGitReadPacket(data)
	if err != nil || flush || string(first) != "# service=git-upload-pack\n" {
		return "", errTransport
	}
	_, rest, flush, err = preparedGitReadPacket(rest)
	if err != nil || !flush {
		return "", errTransport
	}
	row, rest, flush, err := preparedGitReadPacket(rest)
	ref, capabilities, found := bytes.Cut(row, []byte{0})
	if err != nil || flush || !found || !bytes.HasSuffix(capabilities, []byte{'\n'}) || len(ref) < len(commit)+2 || ref[len(commit)] != ' ' || !commitID.MatchString(string(ref[:len(commit)])) {
		return "", errTransport
	}
	seen := map[string]bool{}
	for _, capability := range strings.Split(string(capabilities[:len(capabilities)-1]), " ") {
		if capability == "" || seen[capability] {
			return "", errTransport
		}
		seen[capability] = true
		if strings.HasPrefix(capability, "object-format=") {
			expected := "object-format=sha1"
			if len(commit) == 64 {
				expected = "object-format=sha256"
			}
			if capability != expected || format != "" {
				return "", errTransport
			}
			format = " " + capability
		}
	}
	if !seen["shallow"] || !seen["no-progress"] || !seen["ofs-delta"] || len(commit) == 64 && format == "" {
		return "", errTransport
	}
	for {
		row, rest, flush, err = preparedGitReadPacket(rest)
		if err != nil {
			return "", errTransport
		}
		if flush {
			if len(rest) != 0 {
				return "", errTransport
			}
			return format, nil
		}
		if len(row) < len(commit)+3 || row[len(commit)] != ' ' || !commitID.MatchString(string(row[:len(commit)])) || !bytes.HasSuffix(row, []byte{'\n'}) || bytes.IndexByte(row, 0) >= 0 {
			return "", errTransport
		}
	}
}

func gitPackResult(data []byte, commit string) ([]byte, error) {
	if !commitID.MatchString(commit) || len(data) > 64<<20 {
		return nil, errTransport
	}
	row, rest, flush, err := preparedGitReadPacket(data)
	if err != nil {
		return nil, errTransport
	}
	if !flush {
		if strings.TrimSuffix(string(row), "\n") != "shallow "+commit {
			return nil, errTransport
		}
		_, rest, flush, err = preparedGitReadPacket(rest)
		if err != nil || !flush {
			return nil, errTransport
		}
	}
	row, pack, flush, err := preparedGitReadPacket(rest)
	if err != nil || flush || string(row) != "NAK\n" || len(pack) < 12+len(commit)/2 || len(pack) > 64<<20 || string(pack[:4]) != "PACK" {
		return nil, errTransport
	}
	version, count := binary.BigEndian.Uint32(pack[4:8]), binary.BigEndian.Uint32(pack[8:12])
	if version != 2 && version != 3 || count == 0 || count > 8194 {
		return nil, errTransport
	}
	return pack, nil
}

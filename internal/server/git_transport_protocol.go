package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"
)

const gitReceiveLimit = 64 << 20
const gitReceiveResultLimit = 2 << 20
const gitCommandLimit = 32

var errGitProtocol = errors.New("Unsupported or malformed managed Git protocol")

type gitTransportRoute struct {
	Key           repositoryKey
	Service       string
	Advertisement bool
}

func classifyGitTransport(r *http.Request) (gitTransportRoute, error) {
	var out gitTransportRoute
	// No path cleaning, aliases, double decoding or credential-bearing redirects.
	if r.URL.RawPath != "" || strings.ContainsAny(r.URL.Path, "%\\") || r.URL.Fragment != "" {
		return out, errGitProtocol
	}
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) != 5 && len(parts) != 6 || len(parts) < 5 || parts[1] != "git" {
		return out, errGitProtocol
	}
	if !strings.HasSuffix(parts[3], ".git") {
		return out, errGitProtocol
	}
	out.Key = repositoryKey{parts[2], strings.TrimSuffix(parts[3], ".git")}
	if _, e := repositoryPath(out.Key); e != nil || strings.HasSuffix(out.Key.Name, ".wiki") {
		return out, errGitProtocol
	}
	if len(parts) == 6 && parts[4] == "info" && parts[5] == "refs" && r.Method == http.MethodGet {
		if r.URL.RawQuery == "service=git-upload-pack" {
			out.Service = "git-upload-pack"
		} else if r.URL.RawQuery == "service=git-receive-pack" {
			out.Service = "git-receive-pack"
		} else {
			return out, errGitProtocol
		}
		out.Advertisement = true
	} else if len(parts) == 5 && r.Method == http.MethodPost && r.URL.RawQuery == "" && (parts[4] == "git-upload-pack" || parts[4] == "git-receive-pack") {
		out.Service = parts[4]
		if r.Header.Get("Content-Type") != "application/x-"+out.Service+"-request" {
			return out, errGitProtocol
		}
	} else {
		return out, errGitProtocol
	}
	if len(r.Header.Values("Authorization")) != 1 || len(r.Header.Values("Git-Protocol")) > 1 || r.Header.Get("Git-Protocol") != "" && r.Header.Get("Git-Protocol") != "version=2" {
		return out, errGitProtocol
	}
	if r.Header.Get("Content-Encoding") != "" && (out.Service != "git-upload-pack" || r.Header.Get("Content-Encoding") != "gzip") {
		return out, errGitProtocol
	}
	return out, nil
}

type gitReceiveCommand struct{ Old, New, Ref string }
type gitReceiveRequest struct {
	Commands     []gitReceiveCommand
	Digest       [32]byte
	Sideband     bool
	Capabilities []string
}

func gitPacket(b []byte) (data, rest []byte, flush bool, err error) {
	if len(b) < 4 {
		return nil, nil, false, errGitProtocol
	}
	var header [2]byte
	if _, e := hex.Decode(header[:], b[:4]); e != nil {
		return nil, nil, false, errGitProtocol
	}
	n := int(header[0])*256 + int(header[1])
	if n == 0 {
		return nil, b[4:], true, nil
	}
	if n < 5 || n > 65520 || n > len(b) {
		return nil, nil, false, errGitProtocol
	}
	return b[4:n], b[n:], false, nil
}
func managedGitRef(ref string) bool {
	var name string
	if strings.HasPrefix(ref, "refs/heads/") {
		name = strings.TrimPrefix(ref, "refs/heads/")
	} else if strings.HasPrefix(ref, "refs/tags/") {
		name = strings.TrimPrefix(ref, "refs/tags/")
	} else {
		return false
	}
	return len(ref) <= 1024 && utf8.ValidString(ref) && validRef(name)
}
func receiveRequest(b []byte) (gitReceiveRequest, error) {
	var out gitReceiveRequest
	if len(b) == 0 || len(b) > gitReceiveLimit {
		return out, errGitProtocol
	}
	remaining := b
	consumed := 0
	seen := map[string]bool{}
	report := false
	width := 0
	for {
		row, rest, flush, e := gitPacket(remaining)
		if e != nil {
			return out, e
		}
		consumed += len(remaining) - len(rest)
		remaining = rest
		if consumed > 128<<10 {
			return out, errGitProtocol
		}
		if flush {
			break
		}
		if len(out.Commands) >= gitCommandLimit || len(row) > 4096 {
			return out, errGitProtocol
		}
		text := strings.TrimSuffix(string(row), "\n")
		command, caps, hasCaps := strings.Cut(text, "\x00")
		if len(out.Commands) == 0 {
			if !hasCaps || caps == "" {
				return out, errGitProtocol
			}
			seenCaps := map[string]bool{}
			caps = strings.TrimPrefix(caps, " ")
			for _, cap := range strings.Split(caps, " ") {
				if cap == "" || seenCaps[cap] {
					return out, errGitProtocol
				}
				seenCaps[cap] = true
				switch cap {
				case "report-status":
					report = true
				case "side-band-64k":
					out.Sideband = true
				case "ofs-delta", "atomic", "quiet":
				case "object-format=sha1", "object-format=sha256":
				default:
					if !strings.HasPrefix(cap, "agent=") || len(cap) > 128 || !ruleText(cap, 128, false) || strings.ContainsAny(cap, " \t") {
						return out, errGitProtocol
					}
				}
				if !strings.HasPrefix(cap, "agent=") {
					out.Capabilities = append(out.Capabilities, cap)
				}
			}
		} else if hasCaps {
			return out, errGitProtocol
		}
		fields := strings.Split(command, " ")
		if len(fields) != 3 || !objectID.MatchString(fields[0]) || len(fields[0]) != len(fields[1]) || !objectID.MatchString(fields[1]) || !managedGitRef(fields[2]) || seen[fields[2]] {
			return out, errGitProtocol
		}
		if width == 0 {
			width = len(fields[0])
		}
		if width != len(fields[0]) || fields[0] == fields[1] {
			return out, errGitProtocol
		}
		seen[fields[2]] = true
		out.Commands = append(out.Commands, gitReceiveCommand{fields[0], fields[1], fields[2]})
	}
	if len(out.Commands) == 0 || !report {
		return out, errGitProtocol
	}
	hasObjects := false
	for _, c := range out.Commands {
		if strings.Trim(c.New, "0") != "" {
			hasObjects = true
		}
	}
	if hasObjects {
		if len(remaining) < 12 || !bytes.HasPrefix(remaining, []byte("PACK")) {
			return out, errGitProtocol
		}
	} else if len(remaining) != 0 {
		return out, errGitProtocol
	}
	// Bind relevant requested protocol semantics too; harmless client agent/version metadata is excluded.
	// Pack/source bytes never enter metadata storage.
	sort.Strings(out.Capabilities)
	if width == 40 && strings.Contains(strings.Join(out.Capabilities, " "), "object-format=sha256") || width == 64 && strings.Contains(strings.Join(out.Capabilities, " "), "object-format=sha1") {
		return out, errGitProtocol
	}
	canonical, _ := json.Marshal(struct {
		Commands     []gitReceiveCommand
		Capabilities []string
	}{out.Commands, out.Capabilities})
	out.Digest = sha256.Sum256(canonical)
	return out, nil
}

type gitReceiveReport struct {
	Accepted, Rejected uint32
	RefAccepted        map[string]bool
}

func receiveReport(body []byte, request gitReceiveRequest) (gitReceiveReport, error) {
	out := gitReceiveReport{RefAccepted: map[string]bool{}}
	if len(body) == 0 || len(body) > gitReceiveResultLimit {
		return out, errGitProtocol
	}
	if request.Sideband {
		inner := []byte{}
		remaining := body
		closed := false
		for len(remaining) > 0 {
			row, rest, flush, e := gitPacket(remaining)
			if e != nil {
				return out, e
			}
			remaining = rest
			if flush {
				if len(rest) != 0 {
					return out, errGitProtocol
				}
				closed = true
				break
			}
			if len(row) < 1 {
				return out, errGitProtocol
			}
			switch row[0] {
			case 1:
				inner = append(inner, row[1:]...)
			case 2: // Untrusted progress is discarded.
			default:
				return out, errGitProtocol
			}
		}
		if !closed {
			return out, errGitProtocol
		}
		body = inner
	}
	row, remaining, flush, e := gitPacket(body)
	if e != nil || flush || !bytes.HasPrefix(row, []byte("unpack ")) {
		return out, errGitProtocol
	}
	unpackOK := string(row) == "unpack ok\n"
	expected := map[string]bool{}
	for _, c := range request.Commands {
		expected[c.Ref] = true
	}
	for {
		row, rest, flush, e := gitPacket(remaining)
		if e != nil {
			return out, e
		}
		remaining = rest
		if flush {
			if len(rest) != 0 || len(expected) != 0 {
				return out, errGitProtocol
			}
			break
		}
		if !bytes.HasSuffix(row, []byte{'\n'}) {
			return out, errGitProtocol
		}
		text := string(row[:len(row)-1])
		kind, tail, ok := strings.Cut(text, " ")
		if !ok {
			return out, errGitProtocol
		}
		ref := tail
		if kind == "ng" {
			ref, _, ok = strings.Cut(tail, " ")
			if !ok {
				return out, errGitProtocol
			}
		} else if kind != "ok" || !unpackOK {
			return out, errGitProtocol
		}
		if !expected[ref] {
			return out, errGitProtocol
		}
		delete(expected, ref)
		out.RefAccepted[ref] = kind == "ok"
		if kind == "ok" {
			out.Accepted++
		} else {
			out.Rejected++
		}
	}
	return out, nil
}

func encodeGitPacket(row []byte) []byte {
	n := len(row) + 4
	const alphabet = "0123456789abcdef"
	out := make([]byte, 4, len(row)+4)
	out[0] = alphabet[n>>12&15]
	out[1] = alphabet[n>>8&15]
	out[2] = alphabet[n>>4&15]
	out[3] = alphabet[n&15]
	return append(out, row...)
}

// Restrict advertised receive capabilities to the contract actually classified.
// Forwarding report-status-v2/proc-receive would cause ordinary clients to select
// an unqualified protocol, so these are removed rather than accepted implicitly.
func filterGitAdvertisement(body []byte, service string) ([]byte, error) {
	if service == "git-upload-pack" {
		return body, nil
	}
	first, rest, flush, e := gitPacket(body)
	if e != nil || flush || string(first) != "# service=git-receive-pack\n" {
		return nil, errGitProtocol
	}
	_, rest, flush, e = gitPacket(rest)
	if e != nil || !flush {
		return nil, errGitProtocol
	}
	ref, tail, flush, e := gitPacket(rest)
	if e != nil || flush {
		return nil, errGitProtocol
	}
	prefix, caps, found := bytes.Cut(ref, []byte{0})
	if !found {
		return nil, errGitProtocol
	}
	caps = bytes.TrimSuffix(caps, []byte{'\n'})
	allowed := []string{}
	report := false
	for _, cap := range strings.Split(string(caps), " ") {
		switch cap {
		case "report-status":
			report = true
			allowed = append(allowed, cap)
		case "delete-refs", "side-band-64k", "ofs-delta", "atomic", "quiet", "object-format=sha1", "object-format=sha256", "no-thin":
			allowed = append(allowed, cap)
		default:
			if strings.HasPrefix(cap, "agent=") && len(cap) <= 128 && ruleText(cap, 128, false) {
				allowed = append(allowed, cap)
			}
		}
	}
	if !report {
		return nil, errGitProtocol
	}
	newRef := append(append(append([]byte{}, prefix...), 0), []byte(strings.Join(allowed, " ")+"\n")...)
	out := append(encodeGitPacket(first), []byte("0000")...)
	out = append(out, encodeGitPacket(newRef)...)
	out = append(out, tail...)
	return out, nil
}

// First write admission is deliberately smaller than the framing inventory.
// New/deleted/tag/multi-ref effects require separate native outcome qualification.
func ordinaryGitUpdate(r gitReceiveRequest) bool {
	return len(r.Commands) == 1 && strings.HasPrefix(r.Commands[0].Ref, "refs/heads/") && strings.Trim(r.Commands[0].Old, "0") != "" && strings.Trim(r.Commands[0].New, "0") != ""
}

// Preserve ordinary /git/REPO Golf pages if a native user is named git. Only
// the explicit .git transport marker selects the separate endpoint namespace.
func managedGitRouteNamespace(path string) bool {
	parts := strings.Split(path, "/")
	return len(parts) >= 4 && parts[1] == "git" && strings.HasSuffix(parts[3], ".git")
}

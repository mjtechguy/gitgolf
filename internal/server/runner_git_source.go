package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

// This is a trusted worker preparation read. Enrollment and attempt tokens must
// never enter source jobs, actions, GITHUB_TOKEN or a checkout credential file.
// Its v0 shallow/exact-H contract does not qualify actions/checkout compatibility.
func runnerGitRoute(r *http.Request, attempt string, run workflowRunRecord) (gitTransportRoute, error) {
	var empty gitTransportRoute
	prefix := "/internal/ci/attempt/" + attempt + "/git"
	if !attemptIdentifier.MatchString(attempt) || r.TLS == nil || r.TLS.Version < tls.VersionTLS13 || r.URL.RawPath != "" || r.URL.Fragment != "" || !strings.HasPrefix(r.URL.Path, prefix+"/") || strings.ContainsAny(r.URL.Path, "%\\") || len(r.Header.Values("Cookie")) != 0 || len(r.Header.Values("Origin")) != 0 || len(r.Header.Values("Golf-Runner-ID")) != 1 || len(r.Header.Values("Content-Type")) > 1 || len(r.Header.Values("Git-Protocol")) != 0 || len(r.Header.Values("Content-Encoding")) != 0 || !objectID.MatchString(run.CommitID) {
		return empty, errGitProtocol
	}
	clone := r.Clone(r.Context())
	clone.URL.Path = "/git/" + run.RepositoryOwner + "/" + run.RepositoryName + ".git" + strings.TrimPrefix(r.URL.Path, prefix)
	route, err := classifyGitTransport(clone)
	if err != nil || route.Service != "git-upload-pack" {
		return empty, errGitProtocol
	}
	return route, nil
}

// Reuse pkt-line framing, with a deliberately closed preparation grammar:
// one admitted commit, depth one, no arbitrary haves, filters or Git v2 commands.
func runnerGitNegotiation(body []byte, commit string) error {
	if !objectID.MatchString(commit) || len(body) == 0 || len(body) > 4096 {
		return errGitProtocol
	}
	row, rest, flush, err := gitPacket(body)
	if err != nil || flush || !bytes.HasSuffix(row, []byte{'\n'}) {
		return errGitProtocol
	}
	fields := strings.Split(string(row[:len(row)-1]), " ")
	if len(fields) < 2 || fields[0] != "want" || fields[1] != commit {
		return errGitProtocol
	}
	seen := map[string]bool{}
	for _, capability := range fields[2:] {
		if seen[capability] {
			return errGitProtocol
		}
		seen[capability] = true
		switch capability {
		case "multi_ack", "multi_ack_detailed", "side-band", "side-band-64k", "thin-pack", "ofs-delta", "no-progress":
		case "object-format=sha1":
			if len(commit) != 40 {
				return errGitProtocol
			}
		case "object-format=sha256":
			if len(commit) != 64 {
				return errGitProtocol
			}
		default:
			if !strings.HasPrefix(capability, "agent=") || len(capability) > 128 || !ruleText(capability, 128, false) || strings.ContainsAny(capability, "\t\r\n") {
				return errGitProtocol
			}
		}
	}
	shallow, deepen := false, false
	for {
		row, tail, flush, err := gitPacket(rest)
		if err != nil {
			return errGitProtocol
		}
		rest = tail
		if flush {
			break
		}
		switch strings.TrimSuffix(string(row), "\n") {
		case "shallow " + commit:
			if shallow || deepen {
				return errGitProtocol
			}
			shallow = true
		case "deepen 1":
			if deepen {
				return errGitProtocol
			}
			deepen = true
		default:
			return errGitProtocol
		}
	}
	if !deepen {
		return errGitProtocol
	}
	if len(rest) == 0 {
		return nil
	}
	row, tail, flush, err := gitPacket(rest)
	if err != nil || flush || string(row) != "done\n" || len(tail) != 0 {
		return errGitProtocol
	}
	return nil
}

func (s *Server) runnerGitCredential(ctx context.Context, run workflowRunRecord) (forgeCredential, int64, error) {
	if run.Origin == "push" {
		grant, credential, err := s.automationRunCredential(ctx, run)
		return credential, grant.SponsorNativeUserID, err
	}
	if run.Origin != "manual" {
		return forgeCredential{}, 0, errUnauthenticated
	}
	credential, err := s.sessionCredentialHash(ctx, run.SessionHash)
	if err != nil {
		return credential, 0, err
	}
	row, err := database.New(s.db).GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: run.SessionHash, ForgeURL: s.config.ForgeURL})
	return credential, row.ForgeUserID, err
}

func (s *Server) runnerGitSourceObservation(ctx context.Context, run workflowRunRecord, credential forgeCredential, actorID int64, route gitTransportRoute) (User, error) {
	_, actor, err := s.gitCurrentTarget(ctx, credential, route.Key, strconv.FormatInt(run.RepositoryID, 10), strconv.FormatInt(run.OwnerID, 10), false)
	if err != nil {
		return User{}, err
	}
	if actor.ID != actorID {
		return User{}, errUnauthenticated
	}
	base, err := repositoryPath(route.Key)
	if err != nil {
		return User{}, err
	}
	entry, _, err := s.sourceObjectAtPath(ctx, base, credential, run.CommitID, run.WorkflowPath)
	if err != nil {
		return User{}, err
	}
	if entry.Type != "file" || entry.Path != run.WorkflowPath || entry.SHA != run.BlobID {
		return User{}, errResourceNotFound
	}
	return actor, nil
}

func (s *Server) runnerGitRead(ctx context.Context, r *http.Request, run workflowRunRecord, route gitTransportRoute) ([]byte, error) {
	var body []byte
	var err error
	if !route.Advertisement {
		body, err = io.ReadAll(io.LimitReader(r.Body, 4097))
		negotiation := runnerGitNegotiation
		if r.Header.Get("Git-Protocol") == "version=2" {
			negotiation = jobGitV2Negotiation
		}
		if err != nil || negotiation(body, run.CommitID) != nil {
			return nil, errGitProtocol
		}
	} else if r.ContentLength != 0 {
		return nil, errGitProtocol
	}
	credential, nativeID, err := s.runnerGitCredential(ctx, run)
	if err != nil {
		return nil, err
	}
	actor, err := s.runnerGitSourceObservation(ctx, run, credential, nativeID, route)
	if err != nil {
		return nil, err
	}
	limit := int64(64 << 20)
	if route.Advertisement {
		limit = gitReceiveResultLimit
	}
	response, err := s.forwardGit(ctx, r, credential, actor, route, body, limit)
	if err != nil {
		return nil, err
	}
	if _, err = s.runnerGitSourceObservation(ctx, run, credential, nativeID, route); err != nil {
		return nil, err
	}
	if err = s.runnerRunAuthority(ctx, run); err != nil {
		return nil, err
	}
	if route.Advertisement {
		if r.Header.Get("Git-Protocol") == "version=2" {
			return jobGitV2Advertisement(response, run.CommitID)
		}
		return runnerGitAdvertisement(response)
	}
	return response, nil
}

// Protocol v2 is available only through the separately authenticated job route;
// runnerGitRoute still rejects Git-Protocol. Discovery is repository-scoped,
// while fetch remains exact admitted H/depth1. No server options, foreign haves,
// filters, alternate depths, tags, packfile URLs or other commands are admitted.
func jobGitV2Negotiation(body []byte, commit string) error {
	if !objectID.MatchString(commit) || len(body) == 0 || len(body) > 4096 {
		return errGitProtocol
	}
	row, rest, flush, err := gitPacket(body)
	command := strings.TrimSuffix(string(row), "\n")
	if err != nil || flush || command != "command=fetch" && command != "command=ls-refs" {
		return errGitProtocol
	}
	seen := map[string]bool{}
	for !bytes.HasPrefix(rest, []byte("0001")) {
		row, rest, flush, err = gitPacket(rest)
		if err != nil || flush {
			return errGitProtocol
		}
		capability := strings.TrimSuffix(string(row), "\n")
		key, _, _ := strings.Cut(capability, "=")
		if seen[key] {
			return errGitProtocol
		}
		seen[key] = true
		if key == "agent" && strings.HasPrefix(capability, "agent=") && len(capability) > 6 && len(capability) <= 128 && ruleText(capability, 128, false) && !strings.ContainsAny(capability, "\t\r\n") {
			continue
		}
		format := "sha1"
		if len(commit) == 64 {
			format = "sha256"
		}
		if capability != "object-format="+format {
			return errGitProtocol
		}
	}
	rest = rest[4:]
	seen = map[string]bool{}
	for count := 0; ; count++ {
		row, rest, flush, err = gitPacket(rest)
		if err != nil || count > 32 {
			return errGitProtocol
		}
		if flush {
			if len(rest) != 0 || command == "command=fetch" && (!seen["want "+commit] || !seen["deepen 1"] || !seen["done"] && !seen["have "+commit]) {
				return errGitProtocol
			}
			return nil
		}
		argument := strings.TrimSuffix(string(row), "\n")
		if command == "command=ls-refs" && strings.HasPrefix(argument, "ref-prefix ") && len(argument) <= 1024 && ruleText(argument, 1024, false) && !strings.ContainsAny(argument, "\t\r\n") {
			continue
		}
		if seen[argument] {
			return errGitProtocol
		}
		seen[argument] = true
		if command == "command=ls-refs" {
			if argument != "peel" && argument != "symrefs" && argument != "unborn" {
				return errGitProtocol
			}
			continue
		}
		switch argument {
		case "want " + commit, "have " + commit, "shallow " + commit, "deepen 1", "done", "thin-pack", "ofs-delta", "no-progress":
		default:
			return errGitProtocol
		}
	}
}

func jobGitV2Advertisement(body []byte, commit string) ([]byte, error) {
	row, rest, flush, err := gitPacket(body)
	var preamble []byte
	if err == nil && !flush && string(row) == "# service=git-upload-pack\n" {
		preamble = encodeGitPacket(row)
		_, rest, flush, err = gitPacket(rest)
		if err != nil || !flush {
			return nil, errGitProtocol
		}
		preamble = append(preamble, []byte("0000")...)
		row, rest, flush, err = gitPacket(rest)
	}
	if err != nil || flush || string(row) != "version 2\n" || !objectID.MatchString(commit) {
		return nil, errGitProtocol
	}
	out := append(preamble, encodeGitPacket(row)...)
	seen := map[string]bool{}
	for count := 0; ; count++ {
		row, rest, flush, err = gitPacket(rest)
		if err != nil || count > 32 {
			return nil, errGitProtocol
		}
		if flush {
			if len(rest) != 0 || !seen["fetch"] || !seen["ls-refs"] || !seen["object-format"] {
				return nil, errGitProtocol
			}
			return append(out, []byte("0000")...), nil
		}
		if !bytes.HasSuffix(row, []byte{'\n'}) || !ruleText(string(row[:len(row)-1]), 1024, false) {
			return nil, errGitProtocol
		}
		value := string(row[:len(row)-1])
		key, _, _ := strings.Cut(value, "=")
		if seen[key] {
			return nil, errGitProtocol
		}
		seen[key] = true
		switch key {
		case "fetch":
			if !slices.Contains(strings.Fields(strings.TrimPrefix(value, "fetch=")), "shallow") {
				return nil, errGitProtocol
			}
			out = append(out, encodeGitPacket([]byte("fetch=shallow\n"))...)
		case "ls-refs":
			if value != "ls-refs" && value != "ls-refs=unborn" {
				return nil, errGitProtocol
			}
			out = append(out, encodeGitPacket(row)...)
		case "object-format":
			format := "sha1"
			if len(commit) == 64 {
				format = "sha256"
			}
			if value != "object-format="+format {
				return nil, errGitProtocol
			}
			out = append(out, encodeGitPacket(row)...)
		case "agent":
			if len(value) <= 128 && strings.HasPrefix(value, "agent=") && len(value) > 6 && !strings.ContainsAny(value, "\t\r\n") {
				out = append(out, encodeGitPacket(row)...)
			}
		}
	}
}

// Native upload capabilities are narrowed to this preparation contract, while
// advertised ref/object bytes stay native. The exact-H POST fence is independent.
func runnerGitAdvertisement(body []byte) ([]byte, error) {
	first, rest, flush, err := gitPacket(body)
	if err != nil || flush || string(first) != "# service=git-upload-pack\n" {
		return nil, errGitProtocol
	}
	_, rest, flush, err = gitPacket(rest)
	if err != nil || !flush {
		return nil, errGitProtocol
	}
	ref, tail, flush, err := gitPacket(rest)
	if err != nil || flush {
		return nil, errGitProtocol
	}
	prefix, caps, found := bytes.Cut(ref, []byte{0})
	if !found || !bytes.HasSuffix(caps, []byte{'\n'}) {
		return nil, errGitProtocol
	}
	allowed := []string{}
	for _, capability := range strings.Split(string(bytes.TrimSuffix(caps, []byte{'\n'})), " ") {
		switch capability {
		case "multi_ack", "multi_ack_detailed", "side-band", "side-band-64k", "thin-pack", "ofs-delta", "no-progress", "shallow", "object-format=sha1", "object-format=sha256":
			allowed = append(allowed, capability)
		default:
			if strings.HasPrefix(capability, "agent=") && len(capability) <= 128 && ruleText(capability, 128, false) {
				allowed = append(allowed, capability)
			}
		}
	}
	ref = append(append(append([]byte{}, prefix...), 0), []byte(strings.Join(allowed, " ")+"\n")...)
	out := append(encodeGitPacket(first), []byte("0000")...)
	out = append(out, encodeGitPacket(ref)...)
	return append(out, tail...), nil
}

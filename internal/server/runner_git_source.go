package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"net/http"
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
	row, err := database.New(s.db).GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: run.SessionHash, ForgeURL: s.config.GiteaURL})
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
		if err != nil || runnerGitNegotiation(body, run.CommitID) != nil {
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
		return runnerGitAdvertisement(response)
	}
	return response, nil
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

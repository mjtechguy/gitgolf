// Command mcp-smoke is a disposable native integration client, not a Golf service.
// Fixture credentials arrive only on stdin; the MCP child receives one frozen
// PAT or an owner-issued Golf bearer credential through its environment.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type fixture struct {
	Binary, Golf, Gitea, OwnerToken, ReaderToken, NarrowToken, OutsiderToken           string
	Reader, Repository, RepositoryID, Revision, FilePath, FileContent                  string
	Organization, TeamID, OrgRepositoryID, ReviewID, CreationKey, CreationRepositoryID string
	IssueMutationKey, CommentMutationKey, CommentID, CommentBody                       string
	Issue, Pull                                                                        int
	APICredentials                                                                     bool
}

type object = map[string]any

var stage = "initialization"
var cfg fixture
var apiSecrets []string

func check(ok bool) {
	if !ok {
		panic("assertion failed")
	}
}
func phase(name string)    { stage = name; fmt.Println("CHECK: " + name) }
func obj(value any) object { result, ok := value.(map[string]any); check(ok); return result }
func rows(value any) []any { result, ok := value.([]any); check(ok); return result }
func first(data object, field string) object {
	list := rows(data[field])
	check(len(list) > 0)
	return obj(list[0])
}
func hasID(data object, field, id string) bool {
	for _, row := range rows(data[field]) {
		if obj(row)["id"] == id {
			return true
		}
	}
	return false
}
func safe(data []byte) {
	for _, token := range append([]string{cfg.OwnerToken, cfg.ReaderToken, cfg.NarrowToken, cfg.OutsiderToken}, apiSecrets...) {
		check(token != "" && !bytes.Contains(data, []byte(token)))
	}
}

type boundedDiagnostic struct{ bytes.Buffer }

func (b *boundedDiagnostic) Write(p []byte) (int, error) {
	n := len(p)
	if len(p) > 65536-b.Len() {
		p = p[:65536-b.Len()]
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}

func connect(ctx context.Context, origin, token, version string, api bool) (*mcp.ClientSession, func(), *exec.Cmd) {
	cmd := exec.Command(cfg.Binary, "--url", origin, "mcp")
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "GOLF_GITEA_TOKEN=") && !strings.HasPrefix(entry, "GOLF_API_TOKEN=") && !strings.HasPrefix(entry, "GOLF_URL=") && !strings.HasPrefix(entry, "MCPGODEBUG=") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	variable := "GOLF_GITEA_TOKEN="
	if api {
		variable = "GOLF_API_TOKEN="
	}
	cmd.Env = append(cmd.Env, variable+token)
	diagnostic := new(boundedDiagnostic)
	cmd.Stderr = diagnostic
	client := mcp.NewClient(&mcp.Implementation{Name: "golf-native-smoke", Version: "0.0.0"}, &mcp.ClientOptions{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd, TerminateDuration: 6 * time.Second}, &mcp.ClientSessionOptions{ProtocolVersion: version})
	if err != nil {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
		panic("MCP connection failed")
	}
	check(session.InitializeResult().ProtocolVersion == version)
	check(session.InitializeResult().ServerInfo.Name == "golf")
	return session, func() {
		err := session.Close()
		safe(diagnostic.Bytes())
		check(err == nil)
		check(cmd.ProcessState != nil && cmd.ProcessState.Exited())
	}, cmd
}

func call(ctx context.Context, s *mcp.ClientSession, name string, args object) object {
	result, err := s.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	check(err == nil && result != nil && !result.IsError)
	check(len(result.Content) == 1)
	content, ok := result.Content[0].(*mcp.TextContent)
	check(ok)
	text := []byte(content.Text)
	safe(text)
	var envelope object
	check(json.Unmarshal(text, &envelope) == nil && envelope["schema_version"] == "golf.mcp.v1")
	encoded, err := json.Marshal(result.StructuredContent)
	check(err == nil)
	safe(encoded)
	var structured object
	check(json.Unmarshal(encoded, &structured) == nil && reflect.DeepEqual(envelope, structured))
	check(len(envelope) == 2)
	return obj(envelope["data"])
}

func denied(ctx context.Context, s *mcp.ClientSession, name string, args object, expected string) {
	result, err := s.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	check(err == nil && result != nil && result.IsError && result.StructuredContent == nil && len(result.Content) == 1)
	text, ok := result.Content[0].(*mcp.TextContent)
	check(ok && strings.Contains(text.Text, expected))
	safe([]byte(text.Text))
	check(!strings.Contains(text.Text, cfg.FileContent) && !strings.Contains(text.Text, "DO-NOT-ECHO"))
}

func httpJSON(client *http.Client, method, endpoint string, payload object, headers map[string]string, expected int) object {
	var input io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		check(err == nil)
		input = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, endpoint, input)
	check(err == nil)
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := client.Do(request)
	check(err == nil)
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	check(err == nil && len(body) <= 2<<20 && response.StatusCode == expected)
	if len(body) == 0 {
		return object{}
	}
	var result object
	check(json.Unmarshal(body, &result) == nil)
	return result
}

func rpc(client *http.Client, method string, payload object) object {
	return httpJSON(client, "POST", cfg.Golf+"/rpc/golf.v1."+method, payload, map[string]string{"Origin": cfg.Golf, "Connect-Protocol-Version": "1"}, 200)
}
func sessionIDs(client *http.Client) []string {
	result := rpc(client, "SessionService/ListSessions", object{})
	check(obj(result["page"])["nextPage"] == nil || obj(result["page"])["nextPage"] == float64(0))
	var ids []string
	for _, row := range rows(result["sessions"]) {
		id, ok := obj(row)["id"].(string)
		check(ok)
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

var names = []string{"golf_repo_list", "golf_repo_view", "golf_repo_creation", "golf_repo_branches", "golf_repo_commits", "golf_repo_contents", "golf_commit_diff", "golf_issue_list", "golf_issue_view", "golf_issue_comments", "golf_issue_operation", "golf_pr_list", "golf_pr_view", "golf_pr_reviews", "golf_org_list", "golf_org_view", "golf_org_teams", "golf_team_view", "golf_team_members", "golf_team_repos", "golf_audit_list"}

func catalogue(ctx context.Context, session *mcp.ClientSession) {
	result, err := session.ListTools(ctx, &mcp.ListToolsParams{})
	check(err == nil && len(result.Tools) == len(names) && result.NextCursor == "")
	expected := map[string]bool{}
	for _, name := range names {
		expected[name] = true
	}
	for _, tool := range result.Tools {
		check(expected[tool.Name])
		delete(expected, tool.Name)
		raw, err := json.Marshal(tool.InputSchema)
		check(err == nil)
		var schema object
		check(json.Unmarshal(raw, &schema) == nil)
		check(schema["type"] == "object" && schema["additionalProperties"] == false)
		for _, field := range []string{"token", "origin", "url", "command", "argv"} {
			_, present := obj(schema["properties"])[field]
			check(!present)
		}
		annotations := tool.Annotations
		check(annotations != nil && !annotations.ReadOnlyHint && !annotations.IdempotentHint && annotations.DestructiveHint != nil && !*annotations.DestructiveHint && annotations.OpenWorldHint != nil && *annotations.OpenWorldHint)
		check(tool.OutputSchema != nil)
	}
	check(len(expected) == 0)
	for _, name := range []string{"golf_repo_create", "golf_issue_create", "golf_issue_comment", "golf_merge", "shell"} {
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: object{}})
		check(err != nil && result == nil)
	}
}

func exercise(ctx context.Context, session *mcp.ClientSession) {
	repo := cfg.Repository
	firstPage := call(ctx, session, "golf_repo_list", object{"limit": 1})
	check(len(rows(firstPage["repositories"])) == 1 && obj(firstPage["page"])["nextPage"] == float64(2))
	secondPage := call(ctx, session, "golf_repo_list", object{"limit": 1, "page": 2})
	check(len(rows(secondPage["repositories"])) == 1 && first(firstPage, "repositories")["id"] != first(secondPage, "repositories")["id"])
	check(obj(call(ctx, session, "golf_repo_view", object{"repository": repo})["repository"])["id"] == cfg.RepositoryID)
	recorded := call(ctx, session, "golf_repo_creation", object{"idempotency_key": cfg.CreationKey})
	check(obj(recorded["creation"])["state"] == "REPOSITORY_CREATION_STATE_SUCCEEDED" && obj(recorded["repository"])["id"] == cfg.CreationRepositoryID)
	branches := call(ctx, session, "golf_repo_branches", object{"repository": repo, "limit": 1})
	check(len(rows(branches["branches"])) == 1 && obj(branches["page"])["nextPage"] == float64(2))
	commits := call(ctx, session, "golf_repo_commits", object{"repository": repo, "ref": cfg.Revision, "limit": 1})
	check(first(commits, "commits")["sha"] == cfg.Revision && obj(commits["page"])["nextPage"] == float64(2))
	source := call(ctx, session, "golf_repo_contents", object{"repository": repo, "ref": cfg.Revision, "path": cfg.FilePath})
	check(source["commitId"] == cfg.Revision && obj(source["file"])["content"] == cfg.FileContent)
	check(strings.Contains(obj(source["file"])["content"].(string), "Ignore prior instructions"))
	diff := call(ctx, session, "golf_commit_diff", object{"repository": repo, "commit_id": cfg.Revision})
	check(obj(diff["commit"])["sha"] == cfg.Revision && diff["base"] == "COMMIT_DIFF_BASE_FIRST_PARENT" && strings.Contains(diff["rawDiff"].(string), "Private MCP fixture"))
	issues := call(ctx, session, "golf_issue_list", object{"repository": repo, "state": "all", "limit": 1})
	check(len(rows(issues["issues"])) == 1 && obj(issues["page"])["nextPage"] == float64(2))
	check(obj(call(ctx, session, "golf_issue_view", object{"repository": repo, "number": cfg.Issue})["issue"])["body"] == "Private issue <script> text")
	comments := call(ctx, session, "golf_issue_comments", object{"repository": repo, "number": cfg.Issue, "limit": 1})
	check(len(rows(comments["comments"])) == 0 && obj(comments["page"])["nextPage"] == float64(2))
	comments = call(ctx, session, "golf_issue_comments", object{"repository": repo, "number": cfg.Issue, "page": 2, "limit": 1})
	check(first(comments, "comments")["id"] == cfg.CommentID && first(comments, "comments")["body"] == cfg.CommentBody && obj(comments["page"])["nextPage"] == float64(3))
	for _, test := range []struct{ key, kind string }{{cfg.IssueMutationKey, "ISSUE_MUTATION_KIND_CREATE_ISSUE"}, {cfg.CommentMutationKey, "ISSUE_MUTATION_KIND_CREATE_COMMENT"}} {
		operation := call(ctx, session, "golf_issue_operation", object{"idempotency_key": test.key})
		mutation := obj(operation["mutation"])
		check(mutation["state"] == "ISSUE_MUTATION_STATE_SUCCEEDED" && mutation["kind"] == test.kind && mutation["repositoryId"] == cfg.RepositoryID)
		check(mutation["observedNumber"] == mutation["number"] && mutation["number"].(float64) > 0)
		if test.key == cfg.CommentMutationKey {
			check(obj(operation["comment"])["id"] == cfg.CommentID && mutation["commentId"] == cfg.CommentID && mutation["observedResultId"] == cfg.CommentID)
		} else {
			check(mutation["issueId"] == obj(operation["issue"])["id"] && mutation["observedResultId"] == mutation["issueId"] && mutation["observedNumber"] == obj(operation["issue"])["number"])
		}
	}
	pulls := call(ctx, session, "golf_pr_list", object{"repository": repo, "state": "open"})
	check(obj(first(pulls, "pullRequests")["head"])["retainedSnapshot"] == true)
	pull := obj(call(ctx, session, "golf_pr_view", object{"repository": repo, "number": cfg.Pull})["pullRequest"])
	check(obj(pull["head"])["commitId"] == cfg.Revision && strings.Contains(pull["body"].(string), "<script>"))
	reviews := call(ctx, session, "golf_pr_reviews", object{"repository": repo, "number": cfg.Pull, "limit": 1})
	check(first(reviews, "reviews")["id"] == cfg.ReviewID && obj(reviews["page"])["nextPage"] == float64(2))
	organizations := call(ctx, session, "golf_org_list", object{})
	check(first(organizations, "organizations")["name"] == cfg.Organization)
	check(obj(call(ctx, session, "golf_org_view", object{"organization": cfg.Organization})["organization"])["visibility"] == "ORGANIZATION_VISIBILITY_PRIVATE")
	check(hasID(call(ctx, session, "golf_org_teams", object{"organization": cfg.Organization}), "teams", cfg.TeamID))
	team := object{"organization": cfg.Organization, "team_id": cfg.TeamID}
	check(obj(call(ctx, session, "golf_team_view", team)["team"])["id"] == cfg.TeamID)
	check(first(call(ctx, session, "golf_team_members", team), "members")["login"] == cfg.Reader)
	check(hasID(call(ctx, session, "golf_team_repos", team), "repositories", cfg.OrgRepositoryID))
	audit := call(ctx, session, "golf_audit_list", object{"limit": 1})
	snapshot, ok := audit["snapshotId"].(string)
	check(ok && snapshot != "")
	before, ok := audit["nextBeforeId"].(string)
	check(ok && before != "")
	next := call(ctx, session, "golf_audit_list", object{"limit": 1, "snapshot_id": snapshot, "before_id": before})
	check(next["snapshotId"] == snapshot && first(next, "events")["id"] != first(audit, "events")["id"])
}

func cancellation(ctx context.Context, control *http.Client, baseline []string, terminate bool, token string, api bool) {
	target, err := url.Parse(cfg.Golf)
	check(err == nil)
	reached := make(chan struct{}, 4)
	var logouts atomic.Int32
	proxy := &httputil.ReverseProxy{Rewrite: func(r *httputil.ProxyRequest) { r.SetURL(target); r.Out.Header.Set("Origin", cfg.Golf) }, ErrorLog: log.New(io.Discard, "", 0), ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) { w.WriteHeader(http.StatusBadGateway) }}
	proxy.ModifyResponse = func(response *http.Response) error {
		if response.Request.URL.Path == "/rpc/golf.v1.SessionService/Logout" && response.StatusCode == 200 {
			logouts.Add(1)
		}
		if response.Request.URL.Path == "/rpc/golf.v1.RepositoryService/ListRepositories" {
			if response.StatusCode != 200 {
				return errors.New("native read failed")
			}
			// ponytail: fixture-only response barrier, not a reusable gateway. Native
			// Golf has answered; hold its transport until SDK cancellation reaches HTTP.
			reached <- struct{}{}
			select {
			case <-response.Request.Context().Done():
			case <-ctx.Done():
			}
			_ = response.Body.Close()
			return errors.New("fixture response cancelled")
		}
		return nil
	}
	server := httptest.NewServer(proxy)
	defer server.Close()
	session, closeSession, command := connect(ctx, server.URL, token, "2026-07-28", api)
	defer closeSession()
	calls, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan bool, 4)
	for i := 0; i < 4; i++ {
		go func() {
			result, err := session.CallTool(calls, &mcp.CallToolParams{Name: "golf_repo_list", Arguments: object{}})
			done <- err != nil || (result != nil && result.IsError && result.StructuredContent == nil)
		}()
	}
	for i := 0; i < 4; i++ {
		select {
		case <-reached:
		case <-time.After(15 * time.Second):
			panic("native response barrier timeout")
		}
	}
	createdSessions := 4
	if api {
		createdSessions = 0
	}
	check(len(sessionIDs(control)) == len(baseline)+createdSessions)
	denied(ctx, session, "golf_repo_list", object{}, "busy")
	if terminate {
		check(command.Process.Signal(syscall.SIGTERM) == nil)
	} else {
		cancel()
	}
	for i := 0; i < 4; i++ {
		select {
		case failed := <-done:
			check(failed)
		case <-time.After(10 * time.Second):
			panic("cancellation timeout")
		}
	}
	deadline := time.Now().Add(10 * time.Second)
	for logouts.Load() != int32(createdSessions) || !reflect.DeepEqual(sessionIDs(control), baseline) {
		check(time.Now().Before(deadline))
		time.Sleep(50 * time.Millisecond)
	}
	check(logouts.Load() == int32(createdSessions))
}

func issueAPI(client *http.Client) (string, string) {
	issued := rpc(client, "ApiCredentialService/CreateApiCredential", object{"label": "Disposable MCP qualification", "lifetimeSeconds": 3600})
	token, ok := issued["token"].(string)
	check(ok && strings.HasPrefix(token, "golf_ro_") && len(token) == 51)
	apiSecrets = append(apiSecrets, token)
	id, ok := obj(issued["credential"])["id"].(string)
	check(ok && id != "")
	return token, id
}

func nativeCLI(ctx context.Context, token string, api, stdin, failure bool, resource ...string) {
	args := []string{"--url", cfg.Golf}
	flag, variable := "--token-stdin", "GOLF_GITEA_TOKEN="
	if api {
		flag, variable = "--api-token-stdin", "GOLF_API_TOKEN="
	}
	if stdin {
		args = append(args, flag)
	}
	if len(resource) == 0 {
		resource = []string{"repo", "contents", cfg.Repository, "--ref", cfg.Revision, "--path", cfg.FilePath}
	}
	args = append(args, resource...)
	command := exec.CommandContext(ctx, cfg.Binary, args...)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "GOLF_GITEA_TOKEN=") && !strings.HasPrefix(entry, "GOLF_API_TOKEN=") && !strings.HasPrefix(entry, "GOLF_URL=") {
			command.Env = append(command.Env, entry)
		}
	}
	if stdin {
		command.Stdin = strings.NewReader(token + "\n")
	} else {
		command.Env = append(command.Env, variable+token)
	}
	var output bytes.Buffer
	diagnostic := new(boundedDiagnostic)
	command.Stdout, command.Stderr = &output, diagnostic
	err := command.Run()
	safe(output.Bytes())
	safe(diagnostic.Bytes())
	if failure {
		check(err != nil && output.Len() == 0 && strings.Contains(diagnostic.String(), "unauthenticated"))
		return
	}
	check(err == nil && diagnostic.Len() == 0)
	var envelope object
	check(json.Unmarshal(output.Bytes(), &envelope) == nil && envelope["schema_version"] == "golf.cli.v1")
	data := obj(envelope["data"])
	switch resource[0] + " " + resource[1] {
	case "repo contents":
		check(data["commitId"] == cfg.Revision && obj(data["file"])["content"] == cfg.FileContent)
	case "issue comments":
		check(first(data, "comments")["id"] == cfg.CommentID && first(data, "comments")["body"] == cfg.CommentBody && obj(data["page"])["nextPage"] == float64(3))
	case "issue operation":
		mutation := obj(data["mutation"])
		check(mutation["state"] == "ISSUE_MUTATION_STATE_SUCCEEDED" && obj(data["comment"])["id"] == cfg.CommentID && mutation["observedResultId"] == cfg.CommentID && mutation["observedNumber"] == float64(cfg.Issue))
	default:
		panic("unexpected native CLI fixture")
	}
}

func bearerQualification(ctx context.Context, control *http.Client, baseline []string) (*mcp.ClientSession, func()) {
	phase("owner-issued API credential: all 21 tools in both protocol revisions and CLI stdin/environment")
	token, id := issueAPI(control)
	before := rpc(control, "AuditService/ListAuditEvents", object{"limit": 1})["snapshotId"]
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		func() {
			session, closeSession, _ := connect(ctx, cfg.Golf, token, version, true)
			defer closeSession()
			catalogue(ctx, session)
			exercise(ctx, session)
			denied(ctx, session, "golf_repo_view", object{"repository": cfg.Repository, "api_token": "DO-NOT-ECHO"}, "Invalid tool arguments")
		}()
	}
	nativeCLI(ctx, token, true, false, false)
	nativeCLI(ctx, token, true, true, false)
	nativeCLI(ctx, token, true, true, false, "issue", "comments", cfg.Repository, strconv.Itoa(cfg.Issue), "--page", "2", "--limit", "1")
	nativeCLI(ctx, token, true, false, false, "issue", "operation", cfg.CommentMutationKey)
	check(reflect.DeepEqual(sessionIDs(control), baseline))
	check(rpc(control, "AuditService/ListAuditEvents", object{"limit": 1})["snapshotId"] == before)
	phase("API bearer cancellation and SIGTERM without temporary sessions")
	cancellation(ctx, control, baseline, false, token, true)
	cancellation(ctx, control, baseline, true, token, true)
	check(rpc(control, "AuditService/ListAuditEvents", object{"limit": 1})["snapshotId"] == before)
	phase("credential revocation denies original MCP process and CLI")
	func() {
		session, closeSession, _ := connect(ctx, cfg.Golf, token, "2026-07-28", true)
		defer closeSession()
		call(ctx, session, "golf_repo_view", object{"repository": cfg.Repository})
		rpc(control, "ApiCredentialService/RevokeApiCredential", object{"credentialId": id})
		denied(ctx, session, "golf_repo_view", object{"repository": cfg.Repository}, "unauthenticated")
		nativeCLI(ctx, token, true, true, true)
	}()
	phase("API credential source-session logout denies its original MCP process")
	func() {
		jar, _ := cookiejar.New(nil)
		source := &http.Client{Jar: jar, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		rpc(source, "SessionService/LoginWithGiteaToken", object{"token": cfg.ReaderToken})
		defer rpc(source, "SessionService/Logout", object{})
		sourceToken, _ := issueAPI(source)
		session, closeSession, _ := connect(ctx, cfg.Golf, sourceToken, "2026-07-28", true)
		defer closeSession()
		call(ctx, session, "golf_repo_view", object{"repository": cfg.Repository})
		rpc(source, "SessionService/Logout", object{})
		denied(ctx, session, "golf_repo_view", object{"repository": cfg.Repository}, "unauthenticated")
	}()
	check(reflect.DeepEqual(sessionIDs(control), baseline))
	fmt.Println("PASS: API bearer all 21 tools under both revisions, CLI stdin/environment, unchanged session/audit snapshots, cancellation/SIGTERM, direct revocation and source logout")
	// Keep one live bearer process for the later real provider membership removal.
	activeToken, _ := issueAPI(control)
	session, closeSession, _ := connect(ctx, cfg.Golf, activeToken, "2026-07-28", true)
	return session, closeSession
}

func run() (err error) {
	defer func() {
		if recover() != nil {
			err = errors.New("qualification failed")
		}
	}()
	check(json.NewDecoder(io.LimitReader(os.Stdin, 65537)).Decode(&cfg) == nil)
	for _, origin := range []string{cfg.Golf, cfg.Gitea} {
		u, parseErr := url.Parse(origin)
		check(parseErr == nil && u.Scheme == "http" && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" && u.Port() != "")
		check(u.Hostname() == "localhost" || net.ParseIP(u.Hostname()).IsLoopback())
	}
	check(strings.HasPrefix(cfg.Reader, "golf-mcp-"))
	ctx, cancel := context.WithTimeout(context.Background(), 210*time.Second)
	defer cancel()
	jar, _ := cookiejar.New(nil)
	control := &http.Client{Jar: jar, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	rpc(control, "SessionService/LoginWithGiteaToken", object{"token": cfg.ReaderToken})
	defer rpc(control, "SessionService/Logout", object{})
	baseline := sessionIDs(control)
	phase("native discussion CLI reads with one temporary session per command")
	nativeCLI(ctx, cfg.ReaderToken, false, true, false, "issue", "comments", cfg.Repository, strconv.Itoa(cfg.Issue), "--page", "2", "--limit", "1")
	nativeCLI(ctx, cfg.ReaderToken, false, false, false, "issue", "operation", cfg.CommentMutationKey)
	check(reflect.DeepEqual(sessionIDs(control), baseline))
	phase("modern discovery and all 21 native tools")
	modern, closeModern, _ := connect(ctx, cfg.Golf, cfg.ReaderToken, "2026-07-28", false)
	defer closeModern()
	catalogue(ctx, modern)
	exercise(ctx, modern)
	check(reflect.DeepEqual(sessionIDs(control), baseline))
	fmt.Println("PASS: 2026-07-28 discovery, exact 21-tool catalogue, honest annotations, structured/text parity, private native reads, pagination and temporary-session cleanup")
	phase("legacy initialization and native reads")
	func() {
		legacy, closeLegacy, _ := connect(ctx, cfg.Golf, cfg.ReaderToken, "2025-11-25", false)
		defer closeLegacy()
		catalogue(ctx, legacy)
		exercise(ctx, legacy)
	}()
	check(reflect.DeepEqual(sessionIDs(control), baseline))
	fmt.Println("PASS: explicit 2025-11-25 initialization and all 21 native tools with JSON parity, pagination and session cleanup")
	phase("strict invalid input before authentication")
	before := rpc(control, "AuditService/ListAuditEvents", object{"limit": 1})["snapshotId"]
	for _, input := range []object{{"repository": cfg.Repository, "token": "DO-NOT-ECHO"}, {"repository": cfg.Repository, "origin": "http://DO-NOT-ECHO.invalid"}, {"repository": cfg.Repository, "command": "DO-NOT-ECHO"}, {"repository": "../private"}} {
		denied(ctx, modern, "golf_repo_view", input, "Invalid tool arguments")
	}
	for _, test := range []struct {
		name string
		args object
	}{
		{"golf_repo_list", object{"limit": 101}}, {"golf_repo_list", object{"limit": "1"}},
		{"golf_team_view", object{"organization": cfg.Organization, "team_id": "01"}},
		{"golf_commit_diff", object{"repository": cfg.Repository, "commit_id": "main"}},
		{"golf_repo_contents", object{"repository": cfg.Repository, "path": "../secret"}},
		{"golf_repo_creation", object{"idempotency_key": "DO-NOT-ECHO"}},
		{"golf_issue_operation", object{"idempotency_key": "DO-NOT-ECHO"}},
		{"golf_issue_comments", object{"repository": cfg.Repository, "number": cfg.Issue, "issue_id": "1"}},
		{"golf_repo_contents", object{"repository": cfg.Repository, "path": strings.Repeat("x", 17<<10)}},
	} {
		denied(ctx, modern, test.name, test.args, "Invalid tool arguments")
	}
	check(rpc(control, "AuditService/ListAuditEvents", object{"limit": 1})["snapshotId"] == before)
	check(reflect.DeepEqual(sessionIDs(control), baseline))
	fmt.Println("PASS: extra credential/origin/command inputs, malformed IDs/paths/bounds and unsupported write tools cannot authenticate or dispatch")
	phase("narrow-scope and foreign-account denials")
	func() {
		narrow, closeNarrow, _ := connect(ctx, cfg.Golf, cfg.NarrowToken, "2026-07-28", false)
		defer closeNarrow()
		denied(ctx, narrow, "golf_repo_view", object{"repository": cfg.Repository}, "permission_denied")
		denied(ctx, narrow, "golf_issue_comments", object{"repository": cfg.Repository, "number": cfg.Issue}, "permission_denied")
		denied(ctx, narrow, "golf_org_list", object{}, "permission_denied")
		recorded := call(ctx, narrow, "golf_repo_creation", object{"idempotency_key": cfg.CreationKey})
		check(obj(recorded["creation"])["state"] == "REPOSITORY_CREATION_STATE_SUCCEEDED" && recorded["repository"] == nil)
	}()
	func() {
		other, closeOther, _ := connect(ctx, cfg.Golf, cfg.OutsiderToken, "2026-07-28", false)
		defer closeOther()
		denied(ctx, other, "golf_repo_view", object{"repository": cfg.Repository}, "not_found")
		denied(ctx, other, "golf_org_view", object{"organization": cfg.Organization}, "not_found")
		denied(ctx, other, "golf_repo_creation", object{"idempotency_key": cfg.CreationKey}, "not_found")
		denied(ctx, other, "golf_issue_operation", object{"idempotency_key": cfg.CommentMutationKey}, "not_found")
		denied(ctx, other, "golf_issue_comments", object{"repository": cfg.Repository, "number": cfg.Issue}, "not_found")
	}()
	check(reflect.DeepEqual(sessionIDs(control), baseline))
	fmt.Println("PASS: native scope/foreign-account denial, own creation evidence without repository access and no private error result")
	phase("four real reads, fifth-call admission and MCP cancellation")
	cancellation(ctx, control, baseline, false, cfg.ReaderToken, false)
	fmt.Println("PASS: four actual Golf reads held at a fixture response barrier, fifth-call busy denial, SDK cancellation and four independent native logouts")
	phase("SIGTERM with four authenticated calls in flight")
	cancellation(ctx, control, baseline, true, cfg.ReaderToken, false)
	fmt.Println("PASS: stdio SIGTERM cancels four native requests, completes independent logouts and exits without private results")
	var bearer *mcp.ClientSession
	if cfg.APICredentials {
		var closeBearer func()
		bearer, closeBearer = bearerQualification(ctx, control, baseline)
		defer closeBearer()
	}
	phase("revocation in the existing MCP process")
	native := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	httpJSON(native, "DELETE", cfg.Gitea+"/api/v1/repos/"+cfg.Repository+"/collaborators/"+cfg.Reader, nil, map[string]string{"Authorization": "token " + cfg.OwnerToken}, 204)
	denied(ctx, modern, "golf_repo_view", object{"repository": cfg.Repository}, "not_found")
	denied(ctx, modern, "golf_repo_contents", object{"repository": cfg.Repository, "ref": cfg.Revision, "path": cfg.FilePath}, "not_found")
	denied(ctx, modern, "golf_issue_comments", object{"repository": cfg.Repository, "number": cfg.Issue}, "not_found")
	if bearer != nil {
		denied(ctx, bearer, "golf_repo_view", object{"repository": cfg.Repository}, "not_found")
		denied(ctx, bearer, "golf_repo_contents", object{"repository": cfg.Repository, "ref": cfg.Revision, "path": cfg.FilePath}, "not_found")
		denied(ctx, bearer, "golf_issue_comments", object{"repository": cfg.Repository, "number": cfg.Issue}, "not_found")
	}
	httpJSON(native, "DELETE", cfg.Gitea+"/api/v1/orgs/"+cfg.Organization+"/members/"+cfg.Reader, nil, map[string]string{"Authorization": "token " + cfg.OwnerToken}, 204)
	denied(ctx, modern, "golf_org_view", object{"organization": cfg.Organization}, "not_found")
	if bearer != nil {
		denied(ctx, bearer, "golf_org_view", object{"organization": cfg.Organization}, "not_found")
	}
	check(reflect.DeepEqual(sessionIDs(control), baseline))
	fmt.Println("PASS: actual collaborator and membership removal deny subsequent calls in the original stdio process without cached private data")
	return nil
}

func main() {
	if run() != nil {
		fmt.Fprintln(os.Stderr, "MCP smoke failed at "+stage+"; diagnostics withheld")
		os.Exit(1)
	}
}

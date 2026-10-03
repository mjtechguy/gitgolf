package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

type discussionFixture struct {
	s          *Server
	db         *sql.DB
	mu         sync.Mutex
	repo       Repository
	issues     map[int64]discussionIssue
	comments   map[int64]forgeIssueComment
	posts      atomic.Int32
	postStatus atomic.Int32
	readStatus atomic.Int32
	userMode   atomic.Int32
	postHook   func(http.ResponseWriter, *http.Request, any) bool
	listHook   func(http.ResponseWriter, []forgeIssueComment) bool
}

func newDiscussionFixture(t *testing.T) *discussionFixture {
	t.Helper()
	f := &discussionFixture{db: testDatabase(t), repo: Repository{ID: 10, Name: "example", FullName: "alice/example", Private: true, HTMLURL: "https://forge.invalid/alice/example"}, issues: map[int64]discussionIssue{}, comments: map[int64]forgeIssueComment{}}
	f.issues[1] = f.issue(41, 1, "Original", "private issue text")
	f.issues[2] = f.issue(42, 2, "Other", "other issue")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		user := User{ID: 7, Login: "alice"}
		if r.Header.Get("Authorization") == "token bob-issue-token" {
			user = User{ID: 8, Login: "bob"}
		}
		if r.URL.Path == "/api/v1/user" {
			if f.userMode.Load() == 1 {
				w.WriteHeader(401)
				return
			}
			if f.userMode.Load() == 2 {
				user.ID = 99
			}
			_ = json.NewEncoder(w).Encode(user)
			return
		}
		if r.URL.Path == "/api/v1/version" {
			fmt.Fprint(w, `{"version":"1.27.3"}`)
			return
		}
		if status := f.readStatus.Load(); r.Method == "GET" && status != 0 {
			w.WriteHeader(int(status))
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/example" && r.Method == "GET" {
			f.mu.Lock()
			repo := f.repo
			f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(repo)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/repos/alice/example/issues")
		if path == r.URL.Path {
			w.WriteHeader(404)
			return
		}
		if r.Method == "POST" {
			f.posts.Add(1)
			var reserved int
			if err := f.db.QueryRow("SELECT count(*) FROM golf_issue_mutations m JOIN golf_issue_mutation_events e ON e.mutation_id=m.id WHERE m.state='OUTCOME_UNKNOWN' AND e.state='OUTCOME_UNKNOWN'").Scan(&reserved); err != nil || reserved == 0 {
				t.Error("provider POST lacked committed reservation/event", err)
			}
			if status := f.postStatus.Load(); status != 0 {
				w.WriteHeader(int(status))
				return
			}
			var input map[string]string
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			f.mu.Lock()
			var output any
			if path == "" {
				if len(input) != 2 {
					t.Error("issue POST included extra fields")
				}
				number := int64(len(f.issues) + 1)
				row := f.issue(100+number, number, input["title"], input["body"])
				row.User = user
				f.issues[number] = row
				output = row
			} else {
				if len(input) != 1 {
					t.Error("comment POST included extra fields")
				}
				number, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimPrefix(path, "/"), "/comments"), 10, 64)
				if err != nil {
					t.Error("bad comment POST path")
				}
				row := f.comment(200+int64(len(f.comments)), number, input["body"])
				row.User = &user
				f.comments[row.ID] = row
				output = row
			}
			f.mu.Unlock()
			if f.postHook != nil && f.postHook(w, r, output) {
				return
			}
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(output)
			return
		}
		if path == "/comments" {
			f.mu.Lock()
			rows := make([]forgeIssueComment, 0, len(f.comments))
			for _, row := range f.comments {
				rows = append(rows, row)
			}
			f.mu.Unlock()
			sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
			if f.listHook != nil && f.listHook(w, rows) {
				return
			}
			page, _ := strconv.Atoi(r.URL.Query().Get("page"))
			limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
			w.Header().Set("X-Total-Count", strconv.Itoa(len(rows)))
			start := min((page-1)*limit, len(rows))
			end := min(start+limit, len(rows))
			_ = json.NewEncoder(w).Encode(rows[start:end])
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if strings.HasPrefix(path, "/comments/") {
			id, _ := strconv.ParseInt(strings.TrimPrefix(path, "/comments/"), 10, 64)
			if row, ok := f.comments[id]; ok {
				_ = json.NewEncoder(w).Encode(row)
			} else {
				w.WriteHeader(404)
			}
			return
		}
		number, _ := strconv.ParseInt(strings.TrimPrefix(path, "/"), 10, 64)
		if row, ok := f.issues[number]; ok {
			_ = json.NewEncoder(w).Encode(row)
		} else {
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(provider.Close)
	var err error
	f.s, err = New(testConfig(provider.URL), f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *discussionFixture) issue(id, number int64, title, body string) discussionIssue {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	row := discussionIssue{forgeIssue: forgeIssue{Issue: Issue{ID: id, Number: number, Title: title, Body: body, State: "open", User: User{ID: 7, Login: "alice"}, CreatedAt: now, UpdatedAt: now, HTMLURL: f.repo.HTMLURL + issueSuffix(number)}}}
	row.Repository = &struct {
		ID int64 `json:"id"`
	}{f.repo.ID}
	return row
}
func (f *discussionFixture) comment(id, number int64, body string) forgeIssueComment {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	return forgeIssueComment{ID: id, User: &User{ID: 7, Login: "alice"}, Body: body, CreatedAt: now, UpdatedAt: now, IssueURL: f.repo.HTMLURL + issueSuffix(number), HTMLURL: f.repo.HTMLURL + issueSuffix(number) + "#issuecomment-" + strconv.FormatInt(id, 10)}
}
func (f *discussionFixture) client(t *testing.T, name string) (golfv1connect.RepositoryServiceClient, loginResult) {
	t.Helper()
	id := int64(7)
	if name == "bob" {
		id = 8
	}
	session, err := f.s.createSession(t.Context(), User{ID: id, Login: name}, "pat", name+"-issue-token", "")
	if err != nil {
		t.Fatal(err)
	}
	_, client, _, httpClient, origin := testRPCClients(t, f.s)
	httpClient.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	return client, session
}
func issueCreateInput(key string) *golfv1.CreateIssueRequest {
	return &golfv1.CreateIssueRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "10", Title: "An actual issue", Body: "private <script> literal\n中文", IdempotencyKey: key}
}
func commentCreateInput(key string) *golfv1.CreateIssueCommentRequest {
	return &golfv1.CreateIssueCommentRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "10", IssueId: "41", Number: 1, Body: "actual discussion\n<script>", IdempotencyKey: key}
}
func discussionKey(n int) string { return fmt.Sprintf("12345678-1234-4123-8123-%012x", n) }

func TestIssueDiscussionBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range []string{golfv1connect.RepositoryServiceCreateIssueProcedure, golfv1connect.RepositoryServiceCreateIssueCommentProcedure, golfv1connect.RepositoryServiceListIssueCommentsProcedure, golfv1connect.RepositoryServiceGetIssueMutationProcedure} {
		request := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader("malformed"))
		request.Header.Set("Origin", s.config.PublicURL)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Connect-Protocol-Version", "1")
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		if response.Code != 401 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("decode before auth", response.Code)
		}
	}
	for _, procedure := range []string{golfv1connect.RepositoryServiceCreateIssueProcedure, golfv1connect.RepositoryServiceCreateIssueCommentProcedure} {
		response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), procedure, "malformed")
		if response.Code != 403 {
			t.Fatal("bearer write was decoded/allowed", response.Code)
		}
	}
	for _, test := range []struct {
		body  string
		title string
		valid bool
	}{{"", "title", true}, {strings.Repeat("é", 3000), "title", true}, {strings.Repeat("é", 3001), "title", false}, {"a\x1bb", "title", false}, {"a\u0085b", "title", false}, {string([]byte{0xff}), "title", false}, {"body", " title", false}, {"body", "title\n", false}, {"body", strings.Repeat("x", 256), false}} {
		input := issueMutationInput{Kind: "CREATE_ISSUE", Owner: "alice", Repository: "example", RepositoryID: 10, Title: test.title, Body: test.body}
		if (input.validate(discussionKey(1)) == nil) != test.valid {
			t.Fatal("incorrect text bound")
		}
	}
}

func TestIssueDiscussionLifecyclePostgres(t *testing.T) {
	f := newDiscussionFixture(t)
	client, _ := f.client(t, "alice")
	ctx := t.Context()
	var wait sync.WaitGroup
	results := make(chan *golfv1.CreateIssueResponse, 8)
	for range 8 {
		wait.Go(func() {
			result, err := client.CreateIssue(ctx, connect.NewRequest(issueCreateInput(discussionKey(1))))
			if err != nil {
				t.Error(err)
				return
			}
			results <- result.Msg
		})
	}
	wait.Wait()
	close(results)
	var firstID string
	for result := range results {
		if firstID == "" {
			firstID = result.Mutation.Id
		}
		if result.Mutation.Id != firstID {
			t.Fatal("duplicate operation reservation")
		}
	}
	if f.posts.Load() != 1 {
		t.Fatal("same key dispatched more than once", f.posts.Load())
	}
	created, err := client.GetIssueMutation(ctx, connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: discussionKey(1)}))
	if err != nil || created.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED || created.Msg.Issue == nil || created.Msg.Issue.Title != "An actual issue" {
		t.Fatal("issue creation observation", err)
	}
	if created.Msg.Mutation.RepositoryId != "10" || created.Msg.Mutation.IssueId != created.Msg.Issue.Id || created.Msg.Mutation.Number != created.Msg.Issue.Number || created.Msg.Mutation.CommentId != "" {
		t.Fatal("incorrect ID observation")
	}
	comment, err := client.CreateIssueComment(ctx, connect.NewRequest(commentCreateInput(discussionKey(2))))
	if err != nil || comment.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED || comment.Msg.Comment == nil || comment.Msg.Comment.Body != commentCreateInput("").Body {
		t.Fatal("comment creation observation", err)
	}
	for range 2 {
		replayed, err := client.CreateIssueComment(ctx, connect.NewRequest(commentCreateInput(discussionKey(2))))
		if err != nil || replayed.Msg.Mutation.Id != comment.Msg.Mutation.Id {
			t.Fatal("replay failed", err)
		}
	}
	if f.posts.Load() != 2 {
		t.Fatal("comment replay redispatched")
	}
	changed := issueCreateInput(discussionKey(1))
	changed.Body += " different"
	if _, err := client.CreateIssue(ctx, connect.NewRequest(changed)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("changed payload accepted", err)
	}
	if _, err := client.CreateIssueComment(ctx, connect.NewRequest(commentCreateInput(discussionKey(1)))); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("cross-kind same key accepted", err)
	}
	bob, _ := f.client(t, "bob")
	if _, err := bob.GetIssueMutation(ctx, connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: discussionKey(1)})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("foreign operation disclosed", err)
	}
	var stored string
	if err := f.db.QueryRow("SELECT json_agg(m)::text FROM golf_issue_mutations m").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{issueCreateInput("").Title, issueCreateInput("").Body, commentCreateInput("").Body, "alice-issue-token"} {
		if strings.Contains(stored, text) {
			t.Fatal("journal retained private text/credential")
		}
	}
	var events int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_issue_mutation_events").Scan(&events); err != nil || events != 6 {
		t.Fatal("journal event count", err, events)
	}
	for _, statement := range []string{"UPDATE golf_issue_mutations SET state='OUTCOME_UNKNOWN'", "UPDATE golf_issue_mutations SET repository_id=11", "DELETE FROM golf_issue_mutation_events", "TRUNCATE golf_issue_mutation_events"} {
		if _, err := f.db.Exec(statement); err == nil {
			t.Fatal("journal identity/history editable")
		}
	}
	// Re-instantiating the server shares records; no in-memory deduplication.
	restarted, err := New(f.s.config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.s = restarted
	restartedClient, _ := f.client(t, "alice")
	if _, err := restartedClient.CreateIssue(ctx, connect.NewRequest(issueCreateInput(discussionKey(1)))); err != nil {
		t.Fatal(err)
	}
	if f.posts.Load() != 2 {
		t.Fatal("restart lost deduplication")
	}
}

func TestIssueDiscussionUnknownAndRejectionPostgres(t *testing.T) {
	for _, scenario := range []string{"denied", "archived", "provider_500", "lost_receipt", "unexpected_status", "wrong_repo_receipt", "wrong_author", "post_target_changed", "post_access_lost", "preflight_target_changed"} {
		t.Run(scenario, func(t *testing.T) {
			f := newDiscussionFixture(t)
			client, _ := f.client(t, "alice")
			request := issueCreateInput(discussionKey(1))
			want := golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN
			switch scenario {
			case "denied":
				f.postStatus.Store(403)
				want = golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED
			case "archived":
				f.postStatus.Store(423)
				want = golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED
			case "provider_500":
				f.postStatus.Store(500)
			case "preflight_target_changed":
				request.RepositoryId = "11"
				want = golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED
			default:
				f.postHook = func(w http.ResponseWriter, _ *http.Request, value any) bool {
					row := value.(discussionIssue)
					switch scenario {
					case "unexpected_status":
						w.WriteHeader(200)
						_ = json.NewEncoder(w).Encode(row)
						return true
					case "lost_receipt":
						w.WriteHeader(201)
						fmt.Fprint(w, "{truncated")
						return true
					case "wrong_repo_receipt":
						row.Repository = &struct {
							ID int64 `json:"id"`
						}{11}
					case "wrong_author":
						row.User.ID = 8
					case "post_target_changed":
						f.mu.Lock()
						f.repo.ID = 11
						f.mu.Unlock()
					case "post_access_lost":
						f.readStatus.Store(403)
					}
					w.WriteHeader(201)
					_ = json.NewEncoder(w).Encode(row)
					return true
				}
			}
			first, err := client.CreateIssue(t.Context(), connect.NewRequest(request))
			if err != nil || first.Msg.Mutation.State != want || first.Msg.Issue != nil {
				t.Fatal("wrong failure observation", err)
			}
			if scenario == "post_target_changed" || scenario == "post_access_lost" {
				if first.Msg.Mutation.ObservedResultId == "" || first.Msg.Mutation.ObservedNumber == 0 || first.Msg.Mutation.IssueId != "" {
					t.Fatal("matching receipt lost or promoted without postflight")
				}
				if _, err := f.db.Exec("UPDATE golf_issue_mutations SET observed_result_id=observed_result_id+1 WHERE id=$1", first.Msg.Mutation.Id); err == nil {
					t.Fatal("provisional receipt ID could be overwritten")
				}
				if _, err := f.db.Exec("INSERT INTO golf_issue_mutation_events(mutation_id,phase,state,observed_result_id,observed_number) VALUES($1,'RECEIPT','OUTCOME_UNKNOWN',$2,$3)", first.Msg.Mutation.Id, first.Msg.Mutation.ObservedResultId, first.Msg.Mutation.ObservedNumber); err == nil {
					t.Fatal("duplicate receipt phase appended")
				}
			} else if first.Msg.Mutation.ObservedResultId != "" {
				t.Fatal("invalid or absent receipt was adopted")
			}
			posts := f.posts.Load()
			if scenario == "preflight_target_changed" && (posts != 0 || first.Msg.Mutation.FailureCode != "target_changed") {
				t.Fatal("preflight target mismatch dispatched")
			}
			for range 2 {
				replay, err := client.CreateIssue(t.Context(), connect.NewRequest(request))
				if err != nil || replay.Msg.Mutation.State != want {
					t.Fatal("recorded state changed", err)
				}
			}
			if f.posts.Load() != posts {
				t.Fatal("uncertain/rejected outcome redispatched")
			}
		})
	}
}

func TestIssueDiscussionCommentPagingPostgres(t *testing.T) {
	f := newDiscussionFixture(t)
	client, _ := f.client(t, "alice")
	f.comments[200] = f.comment(200, 2, "unrelated private body")
	ghost := f.comment(201, 1, "literal <script> safe text")
	ghost.User = &User{ID: -1}
	f.comments[201] = ghost
	request := &golfv1.ListIssueCommentsRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "10", IssueId: "41", Number: 1, Page: &golfv1.PageRequest{Limit: 1}}
	page, err := client.ListIssueComments(t.Context(), connect.NewRequest(request))
	if err != nil || len(page.Msg.Comments) != 0 || page.Msg.Page.NextPage != 2 {
		t.Fatal("empty native page lost continuation", err)
	}
	request.Page.Page = 2
	page, err = client.ListIssueComments(t.Context(), connect.NewRequest(request))
	if err != nil || len(page.Msg.Comments) != 1 || page.Msg.Comments[0].Id != "201" || page.Msg.Comments[0].User != nil || page.Msg.Page.NextPage != 0 {
		t.Fatal("filtered comment page/ghost author", err)
	}
	raw, _ := protojson.Marshal(page.Msg)
	if bytes.Contains(raw, []byte("unrelated private body")) {
		t.Fatal("other discussion escaped filter")
	}
	request.IssueId = "42"
	if _, err := client.ListIssueComments(t.Context(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("wrong issue ID accepted", err)
	}
	request.IssueId = "41"
	f.listHook = func(w http.ResponseWriter, rows []forgeIssueComment) bool {
		w.Header().Set("X-Total-Count", "01")
		fmt.Fprint(w, `[]`)
		return true
	}
	if _, err := client.ListIssueComments(t.Context(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatal("malformed pagination accepted", err)
	}
	f.listHook = func(w http.ResponseWriter, rows []forgeIssueComment) bool {
		w.Header().Set("X-Total-Count", "10001")
		fmt.Fprint(w, `[]`)
		return true
	}
	request.Page.Page = 10000
	if _, err := client.ListIssueComments(t.Context(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatal("page ceiling silently complete", err)
	}
	f.listHook = nil
	request.Page.Page = 2
	malformed := f.comments[201]
	malformed.HTMLURL += "bad"
	f.comments[201] = malformed
	if _, err := client.ListIssueComments(t.Context(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatal("malformed comment binding accepted", err)
	}
}

func TestIssueDiscussionTransactionRollbackPostgres(t *testing.T) {
	for _, stage := range []string{"reservation", "receipt", "completion"} {
		t.Run(stage, func(t *testing.T) {
			f := newDiscussionFixture(t)
			client, _ := f.client(t, "alice")
			condition := "TRUE"
			if stage == "completion" {
				condition = "NEW.state <> 'OUTCOME_UNKNOWN'"
			}
			if stage == "receipt" {
				condition = "NEW.phase = 'RECEIPT'"
			}
			_, err := f.db.Exec(`CREATE FUNCTION reject_issue_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ` + condition + ` THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_issue_event BEFORE INSERT ON golf_issue_mutation_events FOR EACH ROW EXECUTE FUNCTION reject_issue_event()`)
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.CreateIssue(t.Context(), connect.NewRequest(issueCreateInput(discussionKey(1))))
			if connect.CodeOf(err) != connect.CodeUnavailable {
				t.Fatal("journal failure was not visible", err)
			}
			var count int
			if err := f.db.QueryRow("SELECT count(*) FROM golf_issue_mutations").Scan(&count); err != nil {
				t.Fatal(err)
			}
			if stage == "reservation" {
				if count != 0 || f.posts.Load() != 0 {
					t.Fatal("failed reservation permitted POST")
				}
				return
			}
			if count != 1 || f.posts.Load() != 1 {
				t.Fatal("completion fixture never dispatched")
			}
			lookup, err := client.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: discussionKey(1)}))
			if err != nil || lookup.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN {
				t.Fatal("terminal state survived event rollback", err)
			}
			if stage == "completion" && lookup.Msg.Mutation.ObservedResultId == "" {
				t.Fatal("completed receipt lost with later completion rollback")
			}
			if stage == "receipt" && lookup.Msg.Mutation.ObservedResultId != "" {
				t.Fatal("receipt ID survived its event rollback")
			}
			if _, err := client.CreateIssue(t.Context(), connect.NewRequest(issueCreateInput(discussionKey(1)))); err != nil || f.posts.Load() != 1 {
				t.Fatal("completion failure redispatched", err)
			}
		})
	}
}

func TestIssueDiscussionRevocationAndCurrentAccessPostgres(t *testing.T) {
	f := newDiscussionFixture(t)
	client, source := f.client(t, "alice")
	other, _ := f.client(t, "alice")
	f.postHook = func(w http.ResponseWriter, r *http.Request, value any) bool {
		if err := f.s.logoutSession(context.Background(), source.Value); err != nil {
			t.Error(err)
		}
		return false
	}
	_, err := client.CreateIssue(t.Context(), connect.NewRequest(issueCreateInput(discussionKey(1))))
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("revoked source returned mutation result", err)
	}
	lookup, err := other.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: discussionKey(1)}))
	if err != nil || lookup.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN {
		t.Fatal("unverified outcome adopted", err)
	}
	if lookup.Msg.Mutation.ObservedResultId == "" || lookup.Msg.Mutation.IssueId != "" {
		t.Fatal("receipt was lost or promoted after caller revocation")
	}
	f.postHook = nil
	created, err := other.CreateIssue(t.Context(), connect.NewRequest(issueCreateInput(discussionKey(2))))
	if err != nil {
		t.Fatal(err)
	}
	request := &golfv1.GetIssueMutationRequest{IdempotencyKey: discussionKey(2)}
	f.readStatus.Store(403)
	lookup, err = other.GetIssueMutation(t.Context(), connect.NewRequest(request))
	if err != nil || lookup.Msg.Issue != nil || lookup.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED {
		t.Fatal("record granted stale object access", err)
	}
	f.readStatus.Store(503)
	if _, err := other.GetIssueMutation(t.Context(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatal("outage hidden as absent object", err)
	}
	f.readStatus.Store(0)
	f.mu.Lock()
	replacement := f.issues[int64(created.Msg.Issue.Number)]
	replacement.ID++
	f.issues[replacement.Number] = replacement
	f.mu.Unlock()
	lookup, err = other.GetIssueMutation(t.Context(), connect.NewRequest(request))
	if err != nil || lookup.Msg.Issue != nil {
		t.Fatal("same-number replacement adopted", err)
	}
	f.userMode.Store(2)
	if _, err := other.GetIssueMutation(t.Context(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("changed immutable caller accepted", err)
	}
}

func TestIssueDiscussionURLBinding(t *testing.T) {
	repo := "https://internal.invalid/gitea/alice/example"
	if !discussionURL("https://public.invalid/gitea/alice/example/issues/1", repo, "/issues/1", "") {
		t.Fatal("legitimate configured origin distinction rejected")
	}
	for _, value := range []string{"https://public.invalid/gitea/alice/other/issues/1", "https://user:pass@public.invalid/gitea/alice/example/issues/1", "https://public.invalid/gitea/alice/example/issues/1?token=x", "https://public.invalid/gitea/alice/example/issues/%31", "https://public.invalid/gitea/alice/example/issues/1#wrong"} {
		if discussionURL(value, repo, "/issues/1", "") {
			t.Fatal("ambiguous/foreign path accepted")
		}
	}
}

func TestIssueDiscussionCommentBindingPostgres(t *testing.T) {
	for _, scenario := range []string{"wrong_issue_receipt", "wrong_author_receipt", "wrong_body_receipt", "post_issue_replaced", "preflight_issue_replaced", "pull_request"} {
		t.Run(scenario, func(t *testing.T) {
			f := newDiscussionFixture(t)
			client, _ := f.client(t, "alice")
			request := commentCreateInput(discussionKey(1))
			if scenario == "preflight_issue_replaced" {
				request.IssueId = "999"
			}
			if scenario == "pull_request" {
				row := f.issues[1]
				row.PullRequest = json.RawMessage(`{"url":"native PR"}`)
				f.issues[1] = row
			}
			f.postHook = func(w http.ResponseWriter, _ *http.Request, value any) bool {
				row := value.(forgeIssueComment)
				switch scenario {
				case "wrong_issue_receipt":
					row = f.comment(row.ID, 2, row.Body)
				case "wrong_author_receipt":
					row.User = &User{ID: 8, Login: "bob"}
				case "wrong_body_receipt":
					row.Body = "altered"
				case "post_issue_replaced":
					f.mu.Lock()
					issue := f.issues[1]
					issue.ID++
					f.issues[1] = issue
					f.mu.Unlock()
				}
				w.WriteHeader(201)
				_ = json.NewEncoder(w).Encode(row)
				return true
			}
			result, err := client.CreateIssueComment(t.Context(), connect.NewRequest(request))
			if err != nil {
				t.Fatal(err)
			}
			want := golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN
			if scenario == "preflight_issue_replaced" || scenario == "pull_request" {
				want = golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED
				if f.posts.Load() != 0 {
					t.Fatal("invalid target dispatched")
				}
			}
			if result.Msg.Mutation.State != want || result.Msg.Comment != nil {
				t.Fatal("unbound comment became success")
			}
			posts := f.posts.Load()
			if _, err := client.CreateIssueComment(t.Context(), connect.NewRequest(request)); err != nil || f.posts.Load() != posts {
				t.Fatal("unbound comment redispatched", err)
			}
		})
	}
	f := newDiscussionFixture(t)
	client, _ := f.client(t, "alice")
	created, err := client.CreateIssueComment(t.Context(), connect.NewRequest(commentCreateInput(discussionKey(1))))
	if err != nil {
		t.Fatal(err)
	}
	id, _ := strconv.ParseInt(created.Msg.Comment.Id, 10, 64)
	f.mu.Lock()
	row := f.comments[id]
	row = f.comment(id, 2, row.Body)
	f.comments[id] = row
	f.mu.Unlock()
	lookup, err := client.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: discussionKey(1)}))
	if err == nil || lookup != nil || connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatal("moved comment returned through original discussion", err)
	}
}

func TestIssueDiscussionCancellationPostgres(t *testing.T) {
	f := newDiscussionFixture(t)
	client, _ := f.client(t, "alice")
	entered, release := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	f.postHook = func(w http.ResponseWriter, r *http.Request, _ any) bool {
		close(entered)
		select {
		case <-release:
		case <-r.Context().Done():
		}
		w.WriteHeader(201)
		fmt.Fprint(w, "{lost")
		return true
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := client.CreateIssueComment(ctx, connect.NewRequest(commentCreateInput(discussionKey(1))))
		done <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("native POST never entered")
	}
	cancel()
	close(release)
	select {
	case err := <-done:
		if connect.CodeOf(err) != connect.CodeCanceled {
			t.Fatal("cancel did not terminate client", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled request hung")
	}
	lookup, err := client.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: discussionKey(1)}))
	if err != nil || lookup.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN {
		t.Fatal("cancelled post was adopted/reported", err)
	}
	if _, err := client.CreateIssueComment(t.Context(), connect.NewRequest(commentCreateInput(discussionKey(1)))); err != nil || f.posts.Load() != 1 {
		t.Fatal("cancelled post repeated", err)
	}
}

func TestPullDiscussionCommentAssociation(t *testing.T) {
	repo := Repository{ID: 1, HTMLURL: "http://native.invalid/alice/repo"}
	comment := forgeIssueComment{ID: 2, User: &User{ID: 3, Login: "alice"}, Body: "@bot review", CreatedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", HTMLURL: "http://native.invalid/alice/repo/pulls/4#issuecomment-2", PullRequestURL: "http://native.invalid/alice/repo/pulls/4"}
	if !validIssueComment(comment, repo, 4, true) || validIssueComment(comment, repo, 4) || validIssueComment(comment, repo, 5, true) {
		t.Fatal("explicit PR association boundary")
	}
	comment.PullRequestURL = "http://native.invalid/alice/repo/pulls/5"
	if validIssueComment(comment, repo, 4, true) {
		t.Fatal("cross-PR association accepted")
	}
}

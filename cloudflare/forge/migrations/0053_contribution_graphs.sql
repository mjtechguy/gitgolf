-- Contribution graphs (docs/AGENTS_AND_AUTOMATIONS_PLAN.md "Contribution graphs and AI impact", CG-1 and
-- CG-2). contribution_events is the ledger: one row per counted contribution, keyed by where it came from ('opened:<discussion id>',
-- 'merged:<discussion id>', 'event:<discussion event id>', 'task:<agent task id>', 'evidence:<evidence job id>', 'commit:<repository
-- id>:<sha>'), so a retried write or a repeated sweep inserts nothing. contribution_days is the daily rollup that profiles and the AI
-- impact page read, keyed by (actor, day, repository, kind, ai_tier). Both are written in one batch: new ledger rows enter with pending=1,
-- the rollup adds the pending rows, and pending is cleared in the same transaction. actor_id is users.id; 0 is Golf itself (the agentic
-- mode identity); -1 marks a commit whose author email has no Golf account (kept so a Git walk stops there, never counted).
-- ai_tier: 'agent' (Golf created it: an agent task, an agent proposal, a policy landing), 'assisted' (a person merged an agent's work),
-- 'declared' (a Co-Authored-By trailer names an AI tool; declared by the author, never verified), 'none' (unlabelled; never asserted to be
-- human-written). Turning the contribution-graphs feature off hides counts and keeps these rows. Replay-safe.
CREATE TABLE IF NOT EXISTS contribution_events (
 key TEXT PRIMARY KEY,
 day TEXT NOT NULL CHECK(length(day)=10),
 actor_id INTEGER NOT NULL,
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 kind TEXT NOT NULL CHECK(kind IN ('commit','pull_opened','pull_merged','review','issue_opened','issue_closed','comment','proposal_created','proposal_accepted')),
 ai_tier TEXT NOT NULL CHECK(ai_tier IN ('agent','assisted','declared','none')),
 pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1))
);
CREATE INDEX IF NOT EXISTS contribution_events_pending ON contribution_events(pending) WHERE pending=1;
CREATE TABLE IF NOT EXISTS contribution_days (
 actor_id INTEGER NOT NULL,
 day TEXT NOT NULL CHECK(length(day)=10),
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 kind TEXT NOT NULL,
 ai_tier TEXT NOT NULL,
 count INTEGER NOT NULL CHECK(count>0),
 PRIMARY KEY(actor_id,day,repository_id,kind,ai_tier)
);
CREATE INDEX IF NOT EXISTS contribution_days_day ON contribution_days(day,repository_id);
-- Commits come from first-parent history of each repository's default branch, read through Artifacts by the maintenance stage in paced
-- batches. A row per repository: next_commit is where a walk in progress continues ('' when none), pending says the default branch moved
-- since the last walk started (set by pushes, Source API commits, agent pushes and merges), walked counts commits read so far.
CREATE TABLE IF NOT EXISTS contribution_git (
 repository_id INTEGER PRIMARY KEY REFERENCES repositories(id),
 next_commit TEXT NOT NULL DEFAULT '',
 pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1)),
 walked INTEGER NOT NULL DEFAULT 0,
 checked_at TEXT,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contribution_git_work ON contribution_git(pending,updated_at);
-- Where each D1 sweep has reached: (created_at or finished_at, id) of the last row it read.
CREATE TABLE IF NOT EXISTS contribution_cursors (
 source TEXT PRIMARY KEY,
 position TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
-- A person's choice to show activity in repositories a visitor cannot read as anonymous counts on their profile, as on GitHub. No row is
-- off: visitors see only what they can read.
CREATE TABLE IF NOT EXISTS contribution_settings (
 user_id INTEGER PRIMARY KEY REFERENCES users(id),
 show_private INTEGER NOT NULL DEFAULT 0 CHECK(show_private IN (0,1)),
 version INTEGER NOT NULL CHECK(version>0),
 updated_at TEXT NOT NULL
);
-- The sweeps' reads: discussion events by time, finished agent tasks by time, agent task and merge commits by commit, and whether a
-- pull request was landed by the policy.
CREATE INDEX IF NOT EXISTS discussion_events_created ON discussion_events(created_at,id);
CREATE INDEX IF NOT EXISTS agent_tasks_finished ON agent_tasks(finished_at,id);
CREATE INDEX IF NOT EXISTS agent_tasks_commit ON agent_tasks(repository_id,commit_id);
CREATE INDEX IF NOT EXISTS pull_merge_operations_commit ON pull_merge_operations(repository_id,merge_commit_id);
CREATE INDEX IF NOT EXISTS land_operations_pull ON land_operations(pull_request_id,trigger,state);

-- Review tasks (docs/AGENT_HOSTS.md): an agent task listed here reviews its pull request read-only. The host runs the tool in its
-- read-only mode (Claude Code --permission-mode plan, Codex --sandbox read-only, Grok without write allowances), commits and pushes
-- nothing, and the tool's final text is the review (result.summary, up to 12 KiB). Pushes with a review task's token are refused.
CREATE TABLE IF NOT EXISTS agent_task_reviews (
 task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id),
 created_at TEXT NOT NULL
);

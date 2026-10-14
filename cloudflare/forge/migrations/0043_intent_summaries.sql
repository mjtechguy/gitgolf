-- Intent summaries for the agentic inbox (docs/AGENTIC_MODE.md, docs/AGENTIC_MODE_PLAN.md AM-5). One AI-written summary per pull request
-- head commit: what the change is for, the areas it touches, the risks it may have and the model's stated confidence, as JSON. It is
-- written once, when an intent-summary AI run settles, and never replaced; a new head commit gets its own row. The model column records
-- the Workers AI model that wrote it. A summary is advisory and never replaces the diff. Replay-safe.
CREATE TABLE IF NOT EXISTS pull_intent_summaries (
 pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
 head_commit_id TEXT NOT NULL CHECK(length(head_commit_id)=40),
 model TEXT NOT NULL,
 summary TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(pull_request_id,head_commit_id)
);

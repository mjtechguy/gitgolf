-- Indexes for the hottest D1 reads under agent load (docs/benchmarks/2026-10-15-scale-out): the automatic CI pass read every row of
-- git_operations on each pass; branch lookups for pull requests read every open discussion of the repository; landing read every
-- land operation. Pull request lookups by branch name lead with pull_requests (CROSS JOIN fixes the order) to use the branch index.
CREATE INDEX IF NOT EXISTS git_operations_ci_pending ON git_operations(created_at,id) WHERE state='APPLIED' AND ci_state='PENDING';
CREATE INDEX IF NOT EXISTS pull_requests_branches ON pull_requests(head_branch,base_branch);
CREATE INDEX IF NOT EXISTS land_operations_pull_head ON land_operations(pull_request_id,head_commit_id);

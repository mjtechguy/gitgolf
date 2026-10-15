-- Runner capacity (docs/SCALE_OUT_PLAN.md S5, docs/RUNNER_CAPACITY.md). A capacity request asks for a higher value of one field of an
-- installation policy (src/installation.mjs installationPolicies: evidence, previews, agent-budgets). A different operations administrator
-- approves or declines it; approval applies the change through the same path as /native/installation (typed confirmation, a recent Access
-- sign-in for widening, the audit row). A value above the deploy ceiling is recorded as needs_deploy: approval records APPROVED and the
-- change waits for a deploy that raises the ceiling. The estimated monthly cost change is NULL where Golf has no honest cost model.
CREATE TABLE IF NOT EXISTS capacity_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 policy_key TEXT NOT NULL,                              -- an installation policy key
 field TEXT NOT NULL,                                   -- the field of its value, for example dailyLimit
 current_value INTEGER NOT NULL,                        -- the effective value when requested
 requested_value INTEGER NOT NULL,
 ceiling INTEGER NOT NULL,                              -- the highest value settable without a deploy when requested
 needs_deploy INTEGER NOT NULL DEFAULT 0 CHECK(needs_deploy IN (0,1)),
 estimated_monthly_delta REAL,                          -- USD a month at list prices; NULL: not estimated (estimate_basis says why)
 estimate_basis TEXT NOT NULL DEFAULT '',
 reason TEXT NOT NULL DEFAULT '',
 requested_by INTEGER NOT NULL REFERENCES users(id),
 requested_at TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPROVED','DECLINED','WITHDRAWN','APPLIED','FAILED')),
 decided_by INTEGER REFERENCES users(id),
 decided_at TEXT,
 decision_note TEXT NOT NULL DEFAULT '',
 applied_by INTEGER REFERENCES users(id),               -- who applied it (the approver, or later, after a deploy raised the ceiling)
 applied_at TEXT
);
CREATE INDEX IF NOT EXISTS capacity_requests_state ON capacity_requests(state,id);
-- One open request per setting: a second one waits until the first is decided or withdrawn.
CREATE UNIQUE INDEX IF NOT EXISTS capacity_requests_open ON capacity_requests(policy_key,field) WHERE state IN ('PENDING','APPROVED');

-- Capacity metrics tokens: read-only bearer secrets (golf_capacity_…, shown once, stored as SHA-256) for GET /native/capacity/metrics
-- only, so an autoscaler (a KEDA metrics-api scaler, an HPA external metric) can read queue depth. They read nothing else in Golf.
CREATE TABLE IF NOT EXISTS capacity_metrics_tokens (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 label TEXT NOT NULL,
 digest TEXT NOT NULL UNIQUE,
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 revoked_at TEXT,
 revoked_by INTEGER REFERENCES users(id),
 last_used_at TEXT
);

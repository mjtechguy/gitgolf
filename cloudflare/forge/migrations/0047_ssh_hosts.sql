-- SSH hosts (docs/SSH_HOSTS.md, agents plan phases 1b and 5). An SSH host is an agent host that Golf reaches over SSH instead of a
-- host process polling Golf: its agent_hosts row (credential_digest 'ssh:<uuid>', host_version 'ssh') carries the name, scope, sharing,
-- allowed users and repositories, enabled tools, concurrency and state, so admission, task states, deadlines, cancel and the LOST sweep
-- are the agent host ones. This row holds what only SSH needs: the address, the reach (direct, tailscale, cloudflare-tunnel or
-- workers-vpc) and its non-secret settings, Golf's per-host Ed25519 key (public key in OpenSSH form; the PKCS#8 private key and any
-- reach secrets sealed in the credential vault envelope, vault.mjs, under the installation key named by seal_key_id), the host key pinned after a person confirmed its
-- fingerprint, and the latest connection test. A private key or reach secret never appears in a view, log or audit row. Replay-safe.
CREATE TABLE IF NOT EXISTS ssh_hosts (
 host_id INTEGER PRIMARY KEY REFERENCES agent_hosts(id),
 address TEXT NOT NULL,                                 -- host name or IP (the Access hostname for cloudflare-tunnel)
 port INTEGER NOT NULL DEFAULT 22 CHECK(port BETWEEN 1 AND 65535),
 login TEXT NOT NULL,                                   -- the account Golf signs in as
 work_directory TEXT NOT NULL DEFAULT '',               -- absolute remote directory for task working copies; '' = ~/.golf-agent/work
 reach TEXT NOT NULL CHECK(reach IN ('direct','tailscale','cloudflare-tunnel','workers-vpc')),
 reach_settings TEXT NOT NULL DEFAULT '{}',             -- JSON, non-secret: tailscale tags, Access service token id
 public_key TEXT NOT NULL,                              -- ssh-ed25519 AAAA… golf-ssh-host-<uuid>
 key_fingerprint TEXT NOT NULL,                         -- SHA256:… of public_key
 private_key_sealed TEXT NOT NULL,                      -- sealed PKCS#8 Ed25519 private key
 secrets_sealed TEXT NOT NULL DEFAULT '',               -- sealed JSON of reach secrets (tailscale auth key, Access service token secret)
 seal_key_id TEXT NOT NULL,
 host_key TEXT NOT NULL DEFAULT '',                     -- the pinned host key (OpenSSH public key form); '' until confirmed
 host_key_fingerprint TEXT NOT NULL DEFAULT '',
 host_key_pinned_by INTEGER REFERENCES users(id),
 host_key_pinned_at TEXT,
 probe_id TEXT,                                         -- the latest connection test
 probe_state TEXT NOT NULL DEFAULT 'NONE' CHECK(probe_state IN ('NONE','RUNNING','SUCCEEDED','FAILED')),
 probe_result TEXT NOT NULL DEFAULT '{}',               -- bounded JSON: offered host key, fingerprint, match, sign-in, OS, tools, error
 probe_started_at TEXT,
 probe_finished_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

# golf-agent-host

The outbound host process for Golf **agent hosts** (contract: `docs/AGENT_HOSTS.md`).
It runs on a machine you connect, reports the coding CLIs installed and signed in
there (Codex, Claude Code, OpenCode, Grok), claims tasks Golf assigns from an issue or
pull request, runs one CLI headless per task in a private working copy and pushes the
result as one commit on a new branch `golf-agent/<8 hex>`. A person opens the pull
request; the host never opens or merges anything. Linux and macOS.

## Register and run

```sh
go build -o golf-agent-host ./cmd/golf-agent-host
# token from Golf: Settings → Agent hosts → Add host
GOLF_AGENT_REGISTRATION_TOKEN=golfagentreg_… ./golf-agent-host register \
  --origin https://golf.example.com --name "my laptop" --state ~/.local/state/golf-agent-host
./golf-agent-host run --state ~/.local/state/golf-agent-host [--config config.json] [--keep-work]
```

`register` writes `STATE/host.json` (0600, in a 0700 directory) with the host
credential; re-registering rotates it. `run` refuses a state directory or
`host.json` that is a symlink, reached through one, owned by someone else, or group or
world accessible, and takes a lock so one `run` uses a state directory at a time. It
heartbeats every 15 s with the tool report, claims every 5 s while below
`maxConcurrent` (a claim is retried with the same `claimId`; any 429/5xx backs off),
stops claiming while Golf reports the host `DISABLED`, and exits when Golf rejects the
credential. Ctrl-C stops running tools and finishes their tasks as `failed`.

Optional configuration (JSON, not group or world writable; all fields optional):

```json
{
  "maxConcurrent": 1,
  "workRoot": "/absolute/private/dir",
  "keepWork": false,
  "tools": {
    "codex":    { "enabled": true, "models": ["gpt-5.5"], "extraArgs": [], "sandbox": "workspace-write" },
    "claude":   { "enabled": true, "extraArgs": ["--allowedTools", "Bash(go test *)"] },
    "opencode": { "enabled": false },
    "grok":     { "enabled": true }
  }
}
```

- `maxConcurrent` 1–4 (Golf runs at most 4 tasks per host). `workRoot` defaults to
  `STATE/work`. `keepWork` (or `--keep-work`) keeps each working copy for debugging.
- `models`: when listed, a task naming another model fails `model_not_allowed`. Model
  names must look like model names (no leading `-`).
- `extraArgs` are appended to the fixed command before the prompt (the host owner's
  choice; they can widen what a tool may do).
- `sandbox` (Codex only): see Codex below.

## Per task

1. `start`; a cancel there ends the task `cancelled` before anything runs.
2. `WORK/<task id>` (0700): `origin.git` is a bare clone of `cloneUrl` at `baseRef`
   (plus a fetch of `baseCommit` if the branch moved). `repo/` is a local clone of it
   with **no remote**, checked out on the new branch `branch` at `baseCommit`. The
   tool works only in `repo/`.
3. The tool runs headless in `repo/` from the fixed argv table below (no shell), in its
   own process group (killed with the host via `Pdeathsig` on Linux), with stdin
   reading the prompt from a 0600 file so the prompt (repository content) never shows in
   process listings. Its environment is the host user's own (HOME, PATH, XDG and tool
   settings, the user's API keys) minus every `GOLF_*` and `GIT_*` variable and any
   variable containing the host credential or task token; `PWD` is set to `repo/`
   (OpenCode resolves its project from `$PWD`), `TERM=dumb`, `NO_COLOR=1`,
   `GIT_TERMINAL_PROMPT=0`.
4. stdout (the tool's JSON event stream) is rendered into readable lines — messages,
   `→ tool target` calls, errors, a result line — and stderr is passed through. Lines are
   stripped of terminal escapes and control characters, secrets are redacted, each line
   is at most 2,000 bytes, and chunks of ≤ 200 lines / ≤ 64 KiB go to `log` about every
   second. A 409 with `nextOffset` resyncs; when Golf stores fewer lines than sent (log
   full) the host stops sending.
5. Cancel (heartbeat `cancel`, or `cancel: true` from `start`/`log`) or the deadline
   sends SIGTERM to the whole group, SIGKILL after 5 s; the task finishes `cancelled` or
   `timed_out` with no commit. When the tool exits normally anything it left running in
   its group is killed. If Golf stops accepting the task token (401 past the deadline,
   409 once finished elsewhere) the host stops the tool and cleans up without a finish.
6. `git add --all`, then one commit whose only parent is `baseCommit` with the resulting
   tree (commits the tool made itself are folded in), author and committer
   `Golf agent (<tool>) <agent@golf.invalid>`, message
   `Agent proposal for issue #12: <title>` … `Golf-Agent-Task: <id>`. The commit is
   fetched into `origin.git` and pushed from there as `<commit>:refs/heads/<branch>`.
   Unchanged tree → `no_changes`; non-zero exit (or the tool's own error result) with
   no change → `failed`; changes → `succeeded` with `commitId`, `changedFiles` (≤ 1,000),
   `summary` (the tool's final message, else the last log lines; ≤ 4 KiB) and `usage`
   (as the CLI reported it: input tokens include cached ones; `costUsd` only when the
   CLI reports cost).
7. The working copy is removed unless `keepWork`. Leftover task directories are removed
   when `run` starts.

### Credentials

- The task token reaches Git only as `http.extraHeader: Authorization: Basic
  base64(golf:<token>)` in the **environment** (`GIT_CONFIG_*`) of the clone, fetch and
  push commands that run in `origin.git`. It is never on a command line, in any
  `.git/config`, in the tool's environment, or in a log.
- Host Git runs with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `core.hooksPath=/dev/null`, `core.fsmonitor=false`, no credential helper, no
  redirects, and only `https`, `http` and local transports. The tool may have rewritten
  `repo/.git/config`; Golf is never contacted from `repo/` (only `upload-pack` runs
  there, to hand the commit to `origin.git`), so a planted `url.insteadOf`, proxy or
  hook cannot receive the token. Clean/smudge filters a tool plants in `repo/.git/config`
  can still run during `git add`, without any secret in their environment.
- The tool runs as the host user, so it could read `host.json`. If that matters, run the
  host under a dedicated account whose sign-ins are only the tools'.

## Tool command table

Verified against codex-cli 0.162.1, Claude Code 2.1.296–2.1.299, opencode 1.18.35 and
grok 1.0.46 (`--help`, the bundled docs, and one real run each). `--model <m>` is
added only when the task names a model, then `extraArgs`.

| Tool | argv | Prompt | Status command |
| --- | --- | --- | --- |
| Codex | `codex exec --json --color never --sandbox workspace-write --ephemeral -- -` | stdin (`-`) | `codex login status` (exit 0 "Logged in using ChatGPT/API key" → true; exit 1 "Not logged in" → false) |
| Claude Code | `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --permission-prompts none --setting-sources user --no-session-persistence` | stdin | `claude auth status --json` (`loggedIn`) |
| OpenCode | `opencode run --format json --dir <repo>` with `OPENCODE_PERMISSION={"edit":"allow","bash":"deny","external_directory":"deny"}` | stdin | `opencode providers list` (≥ 1 stored credential → true, else unknown) |
| Grok | `grok --output-format streaming-messages-json --permission-mode acceptEdits --allow 'Write(./**)' --allow 'Edit(./**)' --verbatim --prompt-file <file>` | `--prompt-file` (headless `-p` from a file) | none → unknown |

Why these flags:

- **Codex.** `exec` is the non-interactive mode (it ran without prompting here).
  `--sandbox workspace-write` lets commands and edits write only in the working
  directory (and temp) with network blocked for commands; `--ephemeral` keeps no
  session files. On Linux the sandbox needs unprivileged user namespaces
  (bubblewrap). Where the kernel refuses them — e.g. Ubuntu with
  `kernel.apparmor_restrict_unprivileged_userns=1`, where the sandbox fails with
  `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` — every write fails. The
  host probes `codex sandbox -- true` at detection and, if it fails, does **not**
  report Codex (and refuses Codex tasks with `tool_unavailable`). Setting
  `tools.codex.sandbox` to `"danger-full-access"` is an explicit owner opt-in to run
  Codex without any sandbox (it can then write anywhere the user can).
- **Claude Code.** `-p` reads the prompt from stdin and prints stream-json
  (`--verbose` is required for stream-json in print mode). `acceptEdits` auto-accepts
  file edits inside the working directory; `--permission-prompts none` denies anything
  else that would ask (shell commands, paths outside) instead of waiting.
  `--setting-sources user` loads the user's own settings but not the repository's
  `.claude/settings.json` (whose permission rules and hooks would otherwise apply,
  since print mode skips the trust dialog). The account label is
  `<authMethod> (<subscriptionType>)`; the email the CLI also prints is not sent.
- **OpenCode.** `run` is headless and reads stdin. It takes its project directory
  from `$PWD`, not the process working directory: without `--dir` and `PWD`, the first
  real run wrote `HELLO.md` into the directory the host was started from.
  `OPENCODE_PERMISSION` is merged after every config file, including a repository's
  `opencode.json`, so edits are allowed and shell commands and paths outside the
  directory are denied (`--auto` is not passed). OpenCode has no
  OS sandbox. `providers list` lists stored credentials by provider name and type only;
  with none, environment keys or free models may still work, so it reports unknown.
- **Grok.** `-p`/`--prompt-file` is headless single-turn; headless mode does not read
  stdin. In headless mode `--permission-mode acceptEdits` alone cancelled the write
  ("User cancelled the execution for tool write"), so writes and edits are allowed by
  rule for `./**` (rooted at the working directory; `..` cannot escape it); other
  non-read-only calls are cancelled. `--verbatim` sends the prompt as given (no `@file`
  expansion). Grok exits 0 even when the turn failed, so the host also reads the
  result's `is_error`. Grok's own `--sandbox` profiles also need bubblewrap and are not
  used. Grok has no status command, so signed-in is reported unknown (Golf allows it,
  labelled "unknown").

Versions come from `<tool> --version`. Detection runs at start and every 5 minutes with
the scrubbed environment; it never reads credential files.

## Tests

```sh
go vet ./cmd/golf-agent-host/ && go test ./cmd/golf-agent-host/ -count=1
```

The tests run a fake Golf server implementing the host protocol (register, heartbeat
with cancel, claim with `claimId` replay, start, log with offsets/409 resync/cancel,
finish) and serving a bare repository over Smart HTTP through `git http-backend`
(`net/http/cgi`), so clone and push are real. A fake `claude` script first in `PATH`
covers success, tool-made commits, no changes, failure, cancel from a log response,
cancel from the heartbeat while silent, cancel at start, deadline, Golf no longer
accepting the task, refused tasks, the scrubbed environment and process-group kill.

Real CLIs (uses your own subscriptions; one tiny prompt each, through the whole flow
against the fake server and a throwaway repository):

```sh
GOLF_AGENT_HOST_REAL_TOOLS=codex,claude,opencode,grok go test ./cmd/golf-agent-host/ -run TestRealTools -v -count=1
```

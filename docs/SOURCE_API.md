# Source API (Cloudflare native)

A JSON API for agents and tools to read and change code without a clone
(`docs/AGENTIC_MODE_PLAN.md` AM-2). Code: `cloudflare/forge/src/source-api.mjs`, wired
in `core.mjs`; token scope in `src/token-scope.mjs`; commit journal in migration
`0038_source_commits.sql` (schema 38). The capability `repository.source-api` is READY
once schema 38 is applied.

## Requests

`POST /native/source/<action>` with `Content-Type: application/json` and
`Connect-Protocol-Version: 1` (as for every `/native/` JSON route). Every body names
the repository: `"repository": {"owner": "alice", "name": "project"}`, optionally
`"repositoryId": "1"` to pin its identity.

Callers:
- a signed-in browser session (Cloudflare Access);
- `Authorization: Bearer golf_native_…`;
- `Authorization: Bearer golf_pat_…`, an API token ([AGENT_ACCESS.md](AGENT_ACCESS.md)). A token carries a
  scope (`repositories`: all or a list, `permission`: `read`/`write`, optional write
  `branchPattern`, exact or trailing `*`). The scope only narrows the account's grant.

Errors are `{code, message}` with an HTTP status; some add fields:

| Status | code | When |
| --- | --- | --- |
| 400 | `invalid_argument` | bad input; tree edits add `path` and `reason` (`invalid_path`, `missing_path`, `duplicate_path`, `path_conflict`, `gitlink_edit`, `unrepresentable_name`, `invalid_change`) |
| 403 | `permission_denied` | no write grant, a token scope (the message names it), or a branch rule |
| 404 | `not_found` | repository not visible, branch, ref, base or path missing |
| 409 | `aborted` | head moved (`currentHead`), merge conflicts (`currentHead`, `conflicts[{path,reason}]`), another write to the branch stayed in flight |
| 409 | `already_exists` | branch exists (`currentHead`); idempotency key used with other inputs |
| 412 | `failed_precondition` | an unresolved write holds the repository; access or rules changed mid-request; deleting the default branch |
| 413 | `resource_exhausted` | a content limit (the message names it) |
| 429 | `resource_exhausted` | JSON body over its route limit, or the workspace queue is full |
| 503 | `unavailable` | provider unavailable, or a sent write could not be read back (outcome unknown until maintenance settles it) |

## commit

```json
{"repository": {"owner": "alice", "name": "project"},
 "branch": "agent/fix-login",
 "expectedHead": "<40-hex head you edited>",
 "message": "Fix login redirect",
 "changes": [
   {"path": "src/login.js", "content": "export …\n"},
   {"path": "bin/run", "content": "#!/bin/sh\n", "mode": "executable"},
   {"path": "logo.png", "contentBase64": "iVBORw0K…"},
   {"path": "latest", "content": "README.md", "mode": "symlink"},
   {"path": "old.txt", "delete": true},
   {"path": "docs/new.md", "from": "docs/old.md"}],
 "onStale": "fail",
 "idempotencyKey": "<uuid v4>"}
```

- `branch` is a short name. `expectedHead` is the branch head the edits are based on,
  or `""` to create the branch from `base` (a commit ID or an existing branch). In an
  empty repository `base` may be omitted for a root commit.
- A content change without `mode` keeps the mode of the file it replaces (`file` for a
  new one). A move keeps the source's blob and mode. Submodule entries cannot be
  edited.
- Author and committer: the caller's account name (or login) and email (or
  `<login>@users.noreply.<host>`), now, `+0000`. Trailing whitespace of the message
  is trimmed and one newline added.
- `onStale: "fail"` (default): a moved branch returns 409 with `currentHead`.
  `"merge"`: a three-way merge (base: the `expectedHead` tree; ours: the current
  head; theirs: the edited tree), committed with the current head as parent.
  - The merge goes by path. A text file both sides changed is merged line by line, like
    `git merge-file` (`tree-merge.mjs`, `text-merge.mjs`; see "Line-level merges" in
    `docs/AGENTIC_MODE.md`).
  - Edits to different lines of one file merge.
  - Otherwise, lines or paths both sides changed differently return 409 with
    `conflicts`. A conflict's `reason` is one of: `both_modified`, `both_added`,
    `binary`, `too_large_to_merge`, `merge_budget`, `deleted_by_us`,
    `deleted_by_them` or `file_directory`.
  - No conflict markers are ever committed.
- If the head moves again or the provider refuses the update, the read, merge and push
  are retried, at most 3 attempts in all.
- `idempotencyKey`: a replay with the same inputs returns the original response
  without a second commit; other inputs return 409 `already_exists`. A key whose
  write was refused, or abandoned for five minutes before any write, can be used again.
- Branch rules, the branch write fence (`git_ref_writes`) and pipeline push intake
  apply as for a `git push`. The rights are rechecked in the D1 statement that
  reserves the write.

Response:

```json
{"repositoryId": "1", "branch": "agent/fix-login", "commitId": "…", "treeId": "…",
 "previousHead": "…", "merged": false,
 "changedPaths": [{"path": "src/login.js", "change": "modified"}]}
```

`previousHead` is `""` when the branch was created. With `merged: true`,
`changedPaths` compares against the head that was merged onto.

Limits: at most 500 changes, 8 MiB of decoded content in total, 4 MiB per file,
messages up to 64 KiB without NUL, 12 MiB of JSON. Paths are literal: no empty, `.`
or `..` segment, no `.git` segment (any case), no control characters or backslash,
at most 1,024 characters and 32 segments.

## branch

```json
{"repository": …, "branch": "feature/x", "action": "create", "from": "main"}
{"repository": …, "branch": "feature/x", "action": "delete", "expectedHead": "<40-hex>"}
```

`from` is a commit ID or a branch name. A create sends an empty pack and a delete no
pack, through the same fence and rules. The default branch cannot be deleted.
Responses: `{repositoryId, branch, action: "create", commitId}` or
`{repositoryId, branch, action: "delete", previousHead}`.

## files

```json
{"repository": …, "ref": "main", "paths": ["README.md", "logo.png", "src"]}
```

`ref` is a branch, a tag (annotated tags are peeled), `refs/heads/…`/`refs/tags/…`
or a 40-hex commit; omitted, the default branch. Up to 100 paths. Each file returns
`{path, type, mode, sha, size}` and `content` (UTF-8 text) or `contentBase64` (a NUL
byte or invalid UTF-8), or `skipped`: `missing`, `directory`, `submodule`,
`too_large` (over 1 MiB) or `total_limit` (the 4 MiB total is spent in request order).
`type` is `file`, `executable`, `symlink`, `directory` or `submodule`.

## tree

```json
{"repository": …, "ref": "main", "path": "src", "recursive": true}
```

Returns `{repositoryId, commitId, path, entries: [{path, type, mode, sha}], truncated,
limit}`, sorted by path, at most 10,000 entries (`truncated: true` beyond). Sizes are
not listed; `files` returns them.

## Examples

```sh
H=(-H "Authorization: Bearer $GOLF_TOKEN" -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1')
curl -s "${H[@]}" https://golf.example.com/native/source/tree \
  -d '{"repository":{"owner":"alice","name":"project"},"ref":"main"}'
curl -s "${H[@]}" https://golf.example.com/native/source/files \
  -d '{"repository":{"owner":"alice","name":"project"},"ref":"main","paths":["README.md"]}'
curl -s "${H[@]}" https://golf.example.com/native/source/commit -d '{
  "repository":{"owner":"alice","name":"project"},"branch":"agent/demo","expectedHead":"","base":"main",
  "message":"Add notes","changes":[{"path":"NOTES.md","content":"hello\n"}],
  "idempotencyKey":"3f0c9a5e-2b1d-4c7e-9f60-1a2b3c4d5e6f"}'
curl -s "${H[@]}" https://golf.example.com/native/source/branch \
  -d '{"repository":{"owner":"alice","name":"project"},"branch":"agent/demo","action":"delete","expectedHead":"<commitId>"}'
```

## Concurrency and outcomes

Commits and branch updates are Workspace transfers: they overlap reads and other
transfers. Writes to one branch are ordered by the D1 ref fence; writes to different
branches proceed in parallel. A sent update that does not read back is an unknown
outcome: the repository is held (`write_pending`) until the maintenance sweep reads
the ref (within minutes), as for a push. A replay with the same idempotency key then
returns the original response.

## Not yet

- API tokens and the MCP endpoint (AM-3). The token scope check (`scopeAllows`) is in
  place; `actor()` attaching `person.token_scope` (and an optional
  `person.token_guard` `{sql, values}` that joins the reservation) comes with AM-3.
- Agent task tokens as callers, and the `Golf-Agent-Task:` trailer.
- Source API writes are not in the audit log (as for pushes). Hosted throughput (S6)
  with line-level merging is not measured.

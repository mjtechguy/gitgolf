# Source API (Cloudflare native)

A JSON API for agents and tools to read and change code without a clone
(`docs/AGENTIC_MODE_PLAN.md` AM-2; blame and grep AM-6). Code:
`cloudflare/forge/src/source-api.mjs`, `src/source-reads.mjs` (blame, grep) and
`src/line-diff.mjs`, wired in `core.mjs`; token scope in `src/token-scope.mjs`; commit journal in migration
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
| 400 | `invalid_argument` | bad input; tree edits add `path` and `reason` (`invalid_path`, `missing_path`, `duplicate_path`, `path_conflict`, `gitlink_edit`, `unrepresentable_name`, `invalid_change`); blame of a binary file adds `reason: "binary"`, a grep with `regex: true` `reason: "regex_unavailable"` |
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

## blame

```json
{"repository": …, "ref": "main", "path": "src/app.js", "startLine": 10, "endLine": 40}
```

Who last changed each line, following first parents from `ref`, as
`git blame --first-parent` does. `startLine` and `endLine` are optional and 1-based. An
`endLine` past the end is cut to the last line; a `startLine` past it is a 400.

```json
{"repositoryId": "1", "commitId": "<ref's commit>", "path": "src/app.js", "lineCount": 120,
 "startLine": 10, "endLine": 40,
 "ranges": [{"start": 10, "end": 14, "commitId": "…"}, {"start": 15, "end": 40, "commitId": "…"}],
 "commits": [{"commitId": "…", "author": "Alice", "authoredAt": "2026-10-14T09:00:00.000Z", "summary": "Fix login"}],
 "complete": true, "examinedCommits": 7,
 "limits": {"fileBytes": 1048576, "readBytes": 4194304, "commits": 500}}
```

- `ranges` are maximal runs of lines that one commit owns. `commits` describes each
  owner once: author name, author date and the first line of the message.
- **How:** at each commit, the file is diffed against its first parent's version with
  Git's own algorithm. `line-diff.mjs` ports xdiff's Myers diff as `git blame` runs it:
  common-tail trimming, discarding unmatched and repeated lines, the cost cut-offs, and
  change compaction with the indent heuristic. Unchanged lines pass to the parent;
  changed lines belong to the commit.
- **Where it stops:** when every line has an owner, at a root commit, or where the
  path is missing (or not a file) in the parent.
- **Renames are not followed.** A renamed file's lines belong to the renaming commit;
  `git blame` would follow the rename.
- **Merges:** a merge commit is compared with its first parent only, so lines a merge
  brought in belong to the merge.
- **Bounds:**
  - at most 500 commits compared with their parent (`examinedCommits`);
  - at most 4 MiB of file versions read, the requested version included.

  Lines still open at a bound belong to the commit where the walk stopped. The
  response then has `complete: false` and `reason` `history_bound` or `read_bound`.
  This equals `git blame --first-parent <that commit>..<ref>`, where that commit is
  Git's boundary commit.
- **Refusals:**
  - the file at `ref` must be text: a NUL byte is a 400 with `reason: "binary"`;
  - it must be at most 1 MiB, otherwise 413;
  - directories and submodules are 400; a missing path is 404.

  Older versions are diffed whatever they hold.
- **Cost:** diffing two 1 MiB versions that share nothing takes about 0.3 to 0.4 s of
  CPU in Node; scattered edits take milliseconds.

## grep

```json
{"repository": …, "ref": "main", "pattern": "TODO", "regex": false, "caseSensitive": true,
 "paths": ["src/**/*.js", "docs"], "maxResults": 100}
```

Exact text search of one commit: one result per matching line, ordered by path and
line, as `git grep -n --column -I` returns them.

```json
{"repositoryId": "1", "commitId": "…",
 "matches": [{"path": "src/app.js", "line": 2, "column": 6, "text": "  // TODO handle errors"}],
 "filesSearched": 42, "skipped": {"binary": 1, "tooLarge": 0}, "truncated": false,
 "limits": {"maxResults": 100, "fileBytes": 1048576, "readBytes": 33554432, "files": 5000}}
```

- **`pattern`:** a literal substring of 1 to 1,000 characters, matched case-insensitively when
  `caseSensitive` is false. A pattern cannot contain a newline or NUL.
- **No regular expressions yet:** `regex: true` is refused with 400 and
  `reason: "regex_unavailable"`. The scan runs inside the workspace that serves every request,
  and JavaScript's engine can backtrack for seconds on a hostile pattern. Regex search will
  return once the scan runs outside it.
- **Results:**
  - `column` is the 1-based position of the first match in the line, in UTF-16 code
    units. It equals Git's byte column for ASCII.
  - `text` is the line's first 400 characters, as Git prints it (a CRLF line keeps its
    `\r`).
- **`paths`** (optional, 1 to 20 globs): `*` matches within one path segment, `**`
  across segments and `?` one character. A glob also matches everything under a
  matching directory; a path without wildcards names a file or a directory. These
  behave like Git's `:(glob)` pathspecs.
- **What is searched:** regular and executable files. Symlinks and submodules are not
  searched, as with `git grep`. Skipped and counted in `skipped`:
  - binary files: a NUL in the first 8,000 bytes;
  - files over 1 MiB (`git grep` would search them).
- **Bounds:**
  - `maxResults`: default 100, at most 500;
  - 5,000 files read;
  - 32 MiB of file content read;
  - 50,000 tree entries listed;
  - 10 seconds.

  The search stops at the first bound it meets, with `truncated: true` and `reason`
  `max_results`, `file_bound`, `read_bound`, `tree_bound` or `time_bound`. Results
  are always the first in path and line order. `max_results` is reported only when
  another matching line exists. The time is checked between file reads, because
  Workers clocks advance only at I/O; one file's search is bounded by its size, not by
  the clock.
- **Cache:** objects are read through the isolate's object cache (trees and blobs up
  to 1 MiB; 4 MiB and 128 objects in all). The isolate also keeps the answers to the
  last 32 searches, since a commit never changes. An answer cut short by time is not
  kept.

## Examples

```sh
H=(-H "Authorization: Bearer $GOLF_TOKEN" -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1')
curl -s "${H[@]}" https://golf.example.com/native/source/tree \
  -d '{"repository":{"owner":"alice","name":"project"},"ref":"main"}'
curl -s "${H[@]}" https://golf.example.com/native/source/files \
  -d '{"repository":{"owner":"alice","name":"project"},"ref":"main","paths":["README.md"]}'
curl -s "${H[@]}" https://golf.example.com/native/source/grep \
  -d '{"repository":{"owner":"alice","name":"project"},"pattern":"TODO","paths":["src/**"]}'
curl -s "${H[@]}" https://golf.example.com/native/source/blame \
  -d '{"repository":{"owner":"alice","name":"project"},"path":"README.md","startLine":1,"endLine":20}'
curl -s "${H[@]}" https://golf.example.com/native/source/commit -d '{
  "repository":{"owner":"alice","name":"project"},"branch":"agent/demo","expectedHead":"","base":"main",
  "message":"Add notes","changes":[{"path":"NOTES.md","content":"hello\n"}],
  "idempotencyKey":"3f0c9a5e-2b1d-4c7e-9f60-1a2b3c4d5e6f"}'
curl -s "${H[@]}" https://golf.example.com/native/source/branch \
  -d '{"repository":{"owner":"alice","name":"project"},"branch":"agent/demo","action":"delete","expectedHead":"<commitId>"}'
```

## Concurrency and outcomes

Commits and branch updates are Workspace transfers: they overlap reads and other
transfers. `files`, `tree`, `blame` and `grep` are reads and overlap each other. Writes to one branch are ordered by the D1 ref fence; writes to different
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
- Blame does not follow renames or copies (`git blame` follows whole-file renames;
  `-M`/`-C` are not offered). Blame and grep are not measured on the hosted demo yet.

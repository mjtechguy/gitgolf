// Remote MCP (docs/AGENT_ACCESS.md, AM-3): POST /mcp, Streamable HTTP, stateless, JSON responses only (no SSE stream; GET is 405).
// JSON-RPC 2.0 initialize, notifications, ping, tools/list and tools/call. Each tool calls the route the web UI calls, as an internal
// request with the caller's own credential, so grants, token scope, feature policy, limits and audit are exactly the UI's.
import { Fault } from './common.mjs';
import { bounded } from './git.mjs';
import { release } from './telemetry.mjs';
import { mcpRoutes } from './api-tokens.mjs';

export const mcpBodyLimit = 12 * 1024 * 1024;
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'], resultLimit = 256 * 1024;
const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const rpc = method => '/rpc/golf.v1.RepositoryService/' + method;
class ToolError extends Error {}
// Golf's one message for a repository, branch or discussion the caller cannot see (common.mjs deny()).
const missing = 'Repository unavailable.';
const fail = message => { throw new ToolError(message); };

const str = description => ({ type: 'string', description });
const int = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum });
const repo = { owner: str('Repository owner: a user or organization name.'), name: str('Repository name.') };
const input = (properties = {}, required = []) => ({ type: 'object', properties: { ...repo, ...properties }, required: ['owner', 'name', ...required], additionalProperties: false });
const refArg = str('Branch, tag or full commit SHA. Defaults to the default branch.');
const number = int('Issue or pull request number.', 1);
const change = { type: 'object', additionalProperties: false, required: ['path'], description: 'One of: {path, content} (UTF-8), {path, contentBase64}, {path, delete: true}, {path, from} (move).',
  properties: { path: str('Repository path.'), content: str('New UTF-8 file content.'), contentBase64: str('New file content, base64.'), mode: { type: 'string', enum: ['file', 'executable', 'symlink'] },
    delete: { type: 'boolean', description: 'Delete the path.' }, from: str('Move the file at this path to path.') } };

function text(args, key, { optional = false, max = 1000 } = {}) {
  const value = args[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !value && !optional || value.length > max) fail(`${key} must be a ${optional ? '' : 'non-empty '}string of at most ${max} characters.`);
  return value;
}
function count(args, key, { optional = false, max = Infinity } = {}) {
  const value = args[key];
  if (value === undefined && optional) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > max) fail(`${key} must be a whole number from 1${max === Infinity ? '' : ' to ' + max}.`);
  return value;
}

// [name, write, description, inputSchema, run(ctx, args)]. ctx.call(path, body) is the internal request; ctx.key is {owner, name}.
const catalogue = [
  ['repo_overview', false, 'Repository facts: description, default branch and its head commit, visibility, clone URL, topics, languages and licenses.', input(), async (c) => {
    const { repository, sourceSelection } = await c.repository();
    let overview = {};
    if (sourceSelection?.commitId) try { overview = await c.call(rpc('GetRepositoryOverview'), { repository: c.key, repositoryId: repository.id, ref: sourceSelection.commitId }); } catch { /* facts without the overview */ }
    return { fullName: repository.fullName, description: repository.description, defaultBranch: repository.defaultBranch, head: sourceSelection?.commitId || null, empty: Boolean(repository.empty),
      private: repository.private, cloneUrl: repository.cloneUrl, url: repository.htmlUrl, issuesEnabled: repository.issuesEnabled, pullRequestsEnabled: repository.pullRequestsEnabled,
      website: overview.website || '', topics: overview.topics || [], languages: overview.languages || [], licenses: overview.licenseIds || [], stars: Number(overview.starsCount || 0) };
  }],
  ['list_tree', false, 'Recursive listing of files at a branch, tag or commit, optionally under a path; up to 10,000 entries and says when truncated.', input({ ref: refArg, path: str('Directory to list. Defaults to the repository root.') }), async (c, a) =>
    c.call('/native/source/tree', { repository: c.key, ref: await c.ref(a), path: text(a, 'path', { optional: true }) || '', recursive: true })],
  ['read_files', false, 'Read up to 100 files at one branch, tag or commit in one call (4 MiB in total). Each file returns its content, or why it was skipped: too large, binary or missing.',
    input({ ref: refArg, paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, description: 'Repository paths to read.' } }, ['paths']), async (c, a) => {
      if (!Array.isArray(a.paths) || !a.paths.length || a.paths.length > 100 || a.paths.some(path => typeof path !== 'string' || !path)) fail('paths must list 1 to 100 repository paths.');
      return c.call('/native/source/files', { repository: c.key, ref: await c.ref(a), paths: a.paths });
    }],
  ['search_code', false, 'Semantic search: finds code and discussions by meaning, not exact text, using the repository’s semantic search index. For an exact string, use grep.',
    input({ query: str('What to look for, in words (2 to 500 characters).') }, ['query']), async (c, a) => c.call('/native/search/read', { action: 'query', repository: c.key, query: text(a, 'query', { max: 500 }) })],
  ['grep', false, 'Exact text search of every file at a branch, tag or commit: each matching line with its path, line, column and text, ordered by path and line. pattern is a literal string (regular expressions are not available yet). Binary files and files over 1 MiB are skipped; says when the search stopped early (maxResults, 5,000 files, 32 MiB).',
    input({ pattern: str('Literal text to find within one line (at most 1,000 characters).'), ref: refArg,
      regex: { type: 'boolean', description: 'Not available yet: true is refused. Default false.' }, caseSensitive: { type: 'boolean', description: 'Default true.' },
      paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Only these paths: * matches within a path segment, ** across segments, ? one character; a plain path names a file or a directory.' },
      maxResults: int('Matching lines to return, 1 to 500 (default 100).', 1, 500) }, ['pattern']), async (c, a) => {
      for (const key of ['regex', 'caseSensitive']) if (a[key] !== undefined && typeof a[key] !== 'boolean') fail(`${key} must be true or false.`);
      if (a.paths !== undefined && (!Array.isArray(a.paths) || !a.paths.length || a.paths.length > 20 || a.paths.some(path => typeof path !== 'string' || !path))) fail('paths must list 1 to 20 path globs.');
      const maxResults = count(a, 'maxResults', { optional: true, max: 500 });
      return c.call('/native/source/grep', { repository: c.key, ref: await c.ref(a), pattern: text(a, 'pattern'), ...(a.regex !== undefined ? { regex: a.regex } : {}),
        ...(a.caseSensitive !== undefined ? { caseSensitive: a.caseSensitive } : {}), ...(a.paths ? { paths: a.paths } : {}), ...(maxResults ? { maxResults } : {}) });
    }],
  ['blame', false, 'Who last changed each line of a file, following first parents from a branch, tag or commit: line ranges with their commit, and each commit’s author, date and summary. Renames are not followed. Up to 500 commits back; says when that left lines unresolved.',
    input({ path: str('File path.'), ref: refArg, startLine: int('First line to blame, from 1.', 1), endLine: int('Last line to blame.', 1) }, ['path']), async (c, a) => {
      const startLine = count(a, 'startLine', { optional: true }), endLine = count(a, 'endLine', { optional: true });
      return c.call('/native/source/blame', { repository: c.key, ref: await c.ref(a), path: text(a, 'path'), ...(startLine ? { startLine } : {}), ...(endLine ? { endLine } : {}) });
    }],
  ['list_commits', false, 'Commit history, newest first, of a branch or commit.', input({ ref: refArg, limit: int('Commits to return, 1 to 100 (default 20).', 1, 100) }), async (c, a) => {
    const { commits, page } = await c.call(rpc('ListCommits'), { repository: c.key, ...(a.ref !== undefined ? { ref: text(a, 'ref', { max: 300 }) } : {}), page: { limit: count(a, 'limit', { optional: true, max: 100 }) || 20 } });
    return { commits, more: Boolean(page?.nextPage) };
  }],
  ['compare', false, 'Compare two branches: the commits on head that are not on base, and the diff from their merge base to head.', input({ base: str('Base branch.'), head: str('Head branch.') }, ['base', 'head']), async (c, a) => {
    const base = await c.branch(text(a, 'base', { max: 300 })), head = await c.branch(text(a, 'head', { max: 300 }));
    const value = await c.call(rpc('GetRepositoryComparison'), { selection: { repository: c.key, repositoryId: base.repositoryId, sourceRepository: c.key, sourceRepositoryId: base.repositoryId,
      baseBranch: a.base, headBranch: a.head, baseCommitId: base.selection.commitId, headCommitId: head.selection.commitId } });
    return `base ${a.base} ${base.selection.commitId}\nhead ${a.head} ${head.selection.commitId}\n\n${(value.commits || []).map(commit => `${commit.sha.slice(0, 12)} ${commit.message.split('\n')[0]} (${commit.authorName})`).join('\n') || 'No commits on head that are not on base.'}\n\n${value.rawDiff || ''}`;
  }],
  ['get_issue', false, 'An issue with its description and up to 100 comments.', input({ number }, ['number']), async (c, a) => {
    const { issue } = await c.call(rpc('GetIssue'), { repository: c.key, number: count(a, 'number') });
    const { repository } = await c.repository();
    let comments = [];
    try { comments = (await c.call(rpc('ListIssueComments'), { repository: c.key, repositoryId: repository.id, number: a.number, issueId: issue.id, page: { limit: 100 } })).comments || []; } catch { /* the issue without its comments */ }
    return { ...issue, comments };
  }],
  ['list_issues', false, 'Issues, newest first.', input({ state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default open.' }, limit: int('Issues to return, 1 to 100 (default 20).', 1, 100) }), async (c, a) => {
    if (a.state !== undefined && !['open', 'closed', 'all'].includes(a.state)) fail('state must be open, closed or all.');
    const { issues, page } = await c.call(rpc('ListIssues'), { repository: c.key, state: 'ISSUE_STATE_' + (a.state || 'open').toUpperCase(), page: { limit: count(a, 'limit', { optional: true, max: 100 }) || 20 } });
    return { issues: (issues || []).map(({ metadata: _metadata, revision: _revision, ...issue }) => issue), more: Boolean(page?.nextPage) };
  }],
  ['get_pull_request', false, 'A pull request: title, description, state, head and base branches and commits.', input({ number }, ['number']), async (c, a) =>
    (await c.call(rpc('GetPullRequest'), { repository: c.key, number: count(a, 'number') })).pullRequest],
  ['pull_request_diff', false, 'The unified diff of a pull request, from the merge base to its head.', input({ number }, ['number']), async (c, a) => {
    const { pullRequest: pr } = await c.call(rpc('GetPullRequest'), { repository: c.key, number: count(a, 'number') });
    const value = await c.call(rpc('GetPullRequestDiff'), { repository: c.key, number: a.number, repositoryId: pr.base.repositoryId, pullRequestId: pr.id, baseCommitId: pr.base.commitId, headCommitId: pr.head.commitId });
    return `#${pr.number} ${pr.title}\nbase ${pr.base.ref} ${pr.base.commitId}\nhead ${pr.head.ref} ${pr.head.commitId}\n\n${value.rawDiff || ''}`;
  }],
  ['pipeline_status', false, 'Recent Actions pipeline runs, newest first, optionally for one branch or tag.', input({ ref: str('Branch or tag name. Defaults to every ref.') }), async (c, a) => {
    const { repository } = await c.repository();
    const value = await c.call('/native/pipelines', { action: 'listRuns', repository: c.key, repositoryId: repository.id, ...(a.ref !== undefined ? { branch: text(a, 'ref', { max: 300 }) } : {}) });
    return { runs: (value.runs || []).slice(0, 10), total: value.total, enabled: value.enabled };
  }],
  ['commit_changes', true, 'Commit file changes to a branch in one commit through the Source API. expectedHead is the branch head you read (a full SHA), or empty with base to create the branch. With onStale "merge", a moved head is three-way merged when paths do not overlap; "fail" (default) returns the current head.',
    input({ branch: str('Branch to commit to.'), expectedHead: str('Full SHA of the branch head the changes were made against, or empty to create the branch from base.'), base: str('Commit or branch to create the branch from when expectedHead is empty.'),
      message: str('Commit message.'), changes: { type: 'array', items: change, minItems: 1, maxItems: 500 }, onStale: { type: 'string', enum: ['fail', 'merge'], description: 'Default fail.' } }, ['branch', 'expectedHead', 'message', 'changes']), async (c, a) => {
      if (!Array.isArray(a.changes) || !a.changes.length) fail('changes must list at least one change.');
      if (typeof a.expectedHead !== 'string') fail('expectedHead must be a string: the branch head SHA, or empty with base.');
      return c.call('/native/source/commit', { repository: c.key, branch: text(a, 'branch', { max: 300 }), expectedHead: a.expectedHead, ...(a.base !== undefined ? { base: text(a, 'base', { max: 300 }) } : {}),
        message: text(a, 'message', { max: 65536 }), changes: a.changes, onStale: a.onStale === undefined ? 'fail' : a.onStale });
    }],
  ['create_branch', true, 'Create a branch from a branch, tag or commit.', input({ branch: str('New branch name.'), from: str('Branch, tag or full commit SHA to start from.') }, ['branch', 'from']), async (c, a) =>
    c.call('/native/source/branch', { repository: c.key, branch: text(a, 'branch', { max: 300 }), action: 'create', from: text(a, 'from', { max: 300 }) })],
  ['open_pull_request', true, 'Open a pull request from head into base at their current commits.', input({ head: str('Branch with the changes.'), base: str('Branch to merge into.'), title: str('Title.'), body: str('Description (Markdown).'), draft: { type: 'boolean' } }, ['head', 'base', 'title']), async (c, a) => {
    // An agent task opens pull requests only from its own branch; Golf records the task as the pull request's origin.
    if (c.task && a.head !== c.task.branch) fail(`This agent task may open a pull request only from its branch ${c.task.branch}.`);
    if (a.draft !== undefined && typeof a.draft !== 'boolean') fail('draft must be true or false.');
    // The tool opens at the branches' current commits; when a landing moves the base between the read and the open, it reads them again.
    for (let attempt = 1; ; attempt++) {
      const base = await c.branch(text(a, 'base', { max: 300 })), head = await c.branch(text(a, 'head', { max: 300 }));
      try {
        const { pullRequest } = await c.call(rpc('CreatePullRequest'), { repository: c.key, repositoryId: base.repositoryId, sourceRepository: c.key, sourceRepositoryId: base.repositoryId,
          baseBranch: a.base, headBranch: a.head, baseCommitId: base.selection.commitId, headCommitId: head.selection.commitId, title: text(a, 'title', { max: 200 }), body: text(a, 'body', { optional: true, max: 12000 }) || '',
          ...(a.draft !== undefined ? { draft: a.draft } : {}), idempotencyKey: crypto.randomUUID() });
        return { number: pullRequest.number, url: pullRequest.htmlUrl, state: pullRequest.state, base: pullRequest.base, head: pullRequest.head };
      } catch (error) { if (attempt >= 3 || !(error instanceof ToolError) || !error.message.startsWith('The selected discussion or commits changed.')) throw error; }
    }
  }],
  ['comment', true, 'Comment on an issue or a pull request.', input({ number, body: str('Comment text (Markdown).') }, ['number', 'body']), async (c, a) => {
    const body = text(a, 'body', { max: 12000 }), num = count(a, 'number');
    let discussion, pullRequest = false;
    // Issues and pull requests share numbers; a number that is not an issue is tried as a pull request.
    try { discussion = (await c.call(rpc('GetIssue'), { repository: c.key, number: num })).issue; }
    catch (error) {
      if (!(error instanceof ToolError) || error.message !== missing) throw error;
      try { discussion = (await c.call(rpc('GetPullRequestDiscussion'), { repository: c.key, number: num })).issue; pullRequest = true; }
      catch (second) { if (second instanceof ToolError && second.message === missing) fail(`No issue or pull request #${num} in ${c.key.owner}/${c.key.name}, or the repository is unavailable.`); throw second; }
    }
    // An agent task comments only on the issue or pull request it was assigned, and on pull requests from its own branch.
    if (c.task && num !== c.task.target.number && !(pullRequest && (await c.call(rpc('GetPullRequest'), { repository: c.key, number: num })).pullRequest?.head?.ref === c.task.branch))
      fail(`This agent task may comment only on #${c.task.target.number} and on pull requests from its branch ${c.task.branch}.`);
    const { repository } = await c.repository();
    const value = await c.call(rpc('CreateIssueComment'), { repository: c.key, repositoryId: repository.id, number: num, issueId: discussion.id, body, pullRequest, idempotencyKey: crypto.randomUUID() });
    return { number: num, kind: pullRequest ? 'pull_request' : 'issue', comment: value.comment ? { id: value.comment.id, createdAt: value.comment.createdAt } : null };
  }],
];
const tools = new Map(catalogue.map(([name, write, description, inputSchema, run]) => [name, { name, write, description, inputSchema, run }]));

// Admission class from the body alone: read tools and the protocol methods overlap reads; Source API writes are transfers like the routes
// they call (the D1 ref fence orders them); other write tools, and anything unparsed, are exclusive.
export function mcpClass(text) {
  try {
    const message = JSON.parse(text);
    if (message?.method !== 'tools/call') return ['initialize', 'ping', 'tools/list', 'notifications/initialized'].includes(message?.method) ? 'read' : 'exclusive';
    const tool = tools.get(message.params?.name);
    return tool?.write === false ? 'read' : ['commit_changes', 'create_branch'].includes(tool?.name) ? 'transfer' : 'exclusive';
  } catch { return 'exclusive'; }
}
// Live activity for the repository a write tool changed (worker.mjs publishes it after the response).
export function mcpActivity(text) {
  try {
    const message = JSON.parse(text), tool = message?.method === 'tools/call' && tools.get(message.params?.name);
    if (!tool?.write || typeof message.params.arguments?.name !== 'string') return;
    return { name: message.params.arguments.name, topics: message.params.name === 'comment' ? ['issues', 'pulls'] : ['source', 'pulls', 'actions'] };
  } catch { return undefined; }
}

function capped(value) {
  const encoder = new TextEncoder(), body = typeof value === 'string' ? value : JSON.stringify(value, null, 2), bytes = encoder.encode(body);
  if (bytes.length <= resultLimit) return body;
  // Cut on a character boundary and say so; the agent narrows the request (a path, fewer paths, a smaller limit).
  return new TextDecoder().decode(bytes.subarray(0, resultLimit)).replace(/�$/, '') + '\n\n{"truncated": true, "limitBytes": 262144, "note": "The result exceeds 256 KiB. Narrow the request."}';
}
const toolError = message => ({ isError: true, content: [{ type: 'text', text: message }] });
const respond = (id, result) => Response.json({ jsonrpc: '2.0', id, result }, { headers: jsonHeaders });
const rpcError = (id, code, message, status = 200) => Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status, headers: jsonHeaders });

// identify() resolves the caller (an API token, an agent task token or a native credential; a browser session is refused); invoke() runs
// an internal request.
export async function mcpEndpoint(request, env, identify, invoke) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
  if (!/^Bearer (?:golf_(?:pat|native)_[A-Za-z0-9_-]{43}|golf_agent_task_[0-9a-f-]{36}_[0-9a-f]{64})$/.test(request.headers.get('Authorization') || '')) throw new Fault('unauthenticated', 401, 'Use an API token: Authorization: Bearer golf_pat_….');
  const person = await identify();
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') return rpcError(null, -32700, 'Send JSON-RPC as application/json.', 415);
  let message;
  try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded(request.body, mcpBodyLimit))); }
  catch { return rpcError(null, -32700, 'Parse error.', 400); }
  if (Array.isArray(message)) return rpcError(null, -32600, 'Batch requests are not supported; send one message per request.', 400);
  const id = message?.id;
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(typeof id === 'string' || Number.isInteger(id) ? id : null, -32600, 'Invalid request.', 400);
  // Notifications and responses carry no id; nothing is returned for them.
  if (id === undefined || id === null) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  if (typeof id !== 'string' && !Number.isInteger(id)) return rpcError(null, -32600, 'Invalid request id.', 400);
  const params = message.params ?? {}, writer = !person.token_scope || person.token_scope.permission === 'write', task = person.agent_task || null;
  if (message.method === 'initialize') return respond(id, { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18',
    capabilities: { tools: {} }, serverInfo: { name: 'golf', version: release },
    instructions: `Golf forge at ${env.PUBLIC_ORIGIN}. Repositories are named by owner and name. Read with repo_overview, list_tree, read_files, grep (exact text), search_code (semantic), blame and list_commits; ` +
      (task ? `this agent task token reads only its task's repository and writes only the branch ${task.branch}: commit_changes to it (pass the head you read as expectedHead, or an empty expectedHead with base to create it), then open_pull_request from it; comment only on #${task.target.number} or on that pull request.`
        : writer ? 'write with create_branch and commit_changes (pass the head you read as expectedHead), then open_pull_request.' : 'this token is read-only.') });
  if (message.method === 'ping') return respond(id, {});
  if (message.method === 'tools/list') return respond(id, { tools: [...tools.values()].filter(tool => writer || !tool.write).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: !tool.write, destructiveHint: false, openWorldHint: false } })) });
  if (message.method !== 'tools/call') return rpcError(id, -32601, `Method not found: ${message.method}.`);
  const tool = tools.get(params.name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name).slice(0, 100)}.`);
  if (tool.write && !writer) return respond(id, toolError(`${tool.name} needs a write token; this API token is read-only.`));
  const args = params.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return respond(id, toolError('arguments must be an object.'));
  const key = { owner: args.owner, name: args.name };
  // The same request headers the caller sent (its credential, never an Access identity), on the routes the tools are allowed to reach.
  const forwarded = {};
  for (const name of ['Authorization', 'User-Agent', 'CF-Connecting-IP', 'CF-Ray', 'X-Golf-Native-Access-Colo', 'X-Golf-Native-Access-Country']) if (request.headers.has(name)) forwarded[name] = request.headers.get(name);
  const call = async (path, body) => {
    if (!mcpRoutes.has(path) && !path.startsWith('/native/source/')) throw Error('MCP tool route outside the allowlist');
    const response = await invoke(new Request(env.PUBLIC_ORIGIN + path, { method: 'POST', headers: { ...forwarded, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body) }));
    let value = null;
    try { value = await response.json(); } catch { /* reported below */ }
    if (!response.ok) {
      // Refusals that carry data (a moved head, conflicting paths) keep it after the message, so the agent can act on it.
      const { code, message, ...details } = value && typeof value === 'object' ? value : {};
      fail((typeof message === 'string' ? message : `Golf could not complete the request (HTTP ${response.status}).`) + (Object.keys(details).length ? '\n' + JSON.stringify({ code, ...details }, null, 2) : ''));
    }
    return value;
  };
  let repository;
  const context = { key, call, task,
    repository: () => repository ||= call(rpc('GetRepository'), { repository: key }),
    ref: async a => a.ref !== undefined ? text(a, 'ref', { max: 300 }) : (await context.repository()).repository.defaultBranch,
    branch: async name => { try { return await call(rpc('ResolveRepositorySource'), { repository: key, selector: { kind: 'REPOSITORY_SOURCE_REF_KIND_BRANCH', name } }); }
      catch (error) { if (error instanceof ToolError && error.message === missing) fail(`Branch ${name} does not exist in ${key.owner}/${key.name}, or the repository is unavailable.`); throw error; } } };
  try {
    text(args, 'owner', { max: 100 }); text(args, 'name', { max: 100 });
    return respond(id, { content: [{ type: 'text', text: capped(await tool.run(context, args)) }] });
  } catch (error) {
    if (error instanceof ToolError) return respond(id, toolError(error.message));
    console.log(JSON.stringify({ event: 'golf.mcp_tool_failed', tool: tool.name }));
    return respond(id, toolError('Golf could not complete this tool call. Retry, or check the repository in the web interface.'));
  }
}

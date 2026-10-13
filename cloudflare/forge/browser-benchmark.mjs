// Run through the authenticated collaborative browser; never embeds a credential.
export async function benchmarkRepositoryReads(repositories, options = {}) {
  const iterations = options.iterations ?? 3, concurrency = options.concurrency ?? 4;
  if (!Array.isArray(repositories) || !repositories.length || repositories.length > 8 || repositories.some(repo => !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo.owner) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo.name) || !/^[1-9][0-9]{0,15}$/.test(repo.id) || !/^[a-f0-9]{40}$/.test(repo.ref) || repo.path !== undefined && (typeof repo.path !== 'string' || repo.path.length > 1024 || !repo.path.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && !['.','..','.git'].includes(part)))) || !Number.isInteger(iterations) || iterations < 1 || iterations > 8 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw Error('Select bounded exact repository snapshots');
  const samples = [];
  if (options.extended !== undefined && typeof options.extended !== 'boolean') throw Error('Use an explicit extended benchmark');
  const pathOK = value => typeof value === 'string' && value.length <= 1024 && value.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..', '.git'].includes(part));
  if (repositories.some(repo => repo.folder !== undefined && !pathOK(repo.folder) || repo.image !== undefined && (!pathOK(repo.path) || typeof repo.image !== 'string' || repo.image.length > 2048 || /[\x00-\x20\\]/.test(repo.image)))) throw Error('Use bounded folder and image selections');
  for (let iteration = 0; iteration < iterations; iteration++) {
    const tasks = repositories.flatMap(repo => [...(options.extended ? [{repo,method:'GetRepository',path:''}] : []),{repo,method:'GetRepositoryOverview',path:''},{repo,method:'GetContents',path:''},...(repo.path ? [{repo,method:'GetContents',path:repo.path}] : []),...(options.extended ? [...(repo.folder ? [{repo,method:'GetContents',path:repo.folder}] : []),{repo,method:'ListCommits',path:''},{repo,method:'GetCommitDiff',path:''},...(repo.image ? [{repo,method:'GetRepositoryImage',path:repo.path}] : [])] : [])]);
    for (let offset = 0; offset < tasks.length; offset += concurrency) await Promise.all(tasks.slice(offset, offset + concurrency).map(async ({ repo, method, path }) => {
      const body = { repository: { owner: repo.owner, name: repo.name }, repositoryId: repo.id, ref: repo.ref,
        ...(method === 'GetContents' ? { path, includeLatestChanges: !path, page: { page: 1, limit: 100 } } : {}),
        ...(method === 'ListCommits' ? { page: { page: 1, limit: 10 } } : {}),
        ...(method === 'GetCommitDiff' ? { commitId: repo.ref } : {}),
        ...(method === 'GetRepositoryImage' ? { commitId: repo.ref, documentPath: repo.path, imageUrl: repo.image } : {}) };
      const started = performance.now();
      try {
      const response = await fetch('/rpc/golf.v1.RepositoryService/' + method, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal:AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body) });
      const payload = await response.text(); let value; try {value=JSON.parse(payload);} catch {value={};}
      const exact = method === 'GetRepository' ? value.repository?.id === repo.id && value.sourceSelection?.commitId === repo.ref
        : method === 'GetCommitDiff' ? value.commit?.sha === repo.ref && typeof value.rawDiff === 'string'
        : value.repositoryId === repo.id && (method === 'GetContents' ? value.commitId === repo.ref && value.path === path
        : method === 'ListCommits' ? value.commitId === repo.ref && value.commits?.[0]?.sha === repo.ref
        : method === 'GetRepositoryImage' ? value.commitId === repo.ref && value.documentPath === repo.path && value.imageUrl === repo.image && typeof value.content === 'string'
        : value.indexedCommitId === repo.ref && value.languagesState === 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE' && value.licensesState === 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE');
      samples.push({ iteration, repository: repo.name, method, path, status: response.status, exact, milliseconds: Math.round(performance.now() - started), bytes: new TextEncoder().encode(payload).length,
        requestId: response.headers.get('X-Request-ID'), release: response.headers.get('X-Golf-Release'), workerRelease: response.headers.get('X-Golf-Worker-Release'), region: response.headers.get('CF-Ray')?.split('-').at(-1), timings: response.headers.get('Server-Timing') });
      } catch {samples.push({iteration,repository:repo.name,method,path,status:0,exact:false,milliseconds:Math.round(performance.now()-started),bytes:0,error:'Transport failed or exceeded the ten-second deadline'});}
    }));
  }
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
  const summarize = rows => ({ samples: rows.length, failures: rows.filter(row => row.status !== 200 || !row.exact).length, p50: percentile(rows.map(row => row.milliseconds), .5), p95: percentile(rows.map(row => row.milliseconds), .95), p99: percentile(rows.map(row => row.milliseconds), .99), bytes: rows.reduce((sum, row) => sum + row.bytes, 0) });
  return { generatedAt: new Date().toISOString(), concurrency, iterations, scope: 'One enrolled user and one workspace; not global or multi-tenant acceptance. First pass does not prove an empty edge or index cache.', cold: summarize(samples.filter(row => row.iteration === 0)), warm: summarize(samples.filter(row => row.iteration > 0)), samples };
}

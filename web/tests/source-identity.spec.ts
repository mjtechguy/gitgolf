import { expect, test, type Page } from '@playwright/test';
import {
  GetAuthenticationOptionsResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema,
  GetRepositoryImageRequestSchema, GetRepositoryImageResponseSchema, GetRepositoryResponseSchema,
  GetSessionResponseSchema, ListBranchesResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema,
  LogoutResponseSchema, RepositorySourceResolution, RepositorySourceRefKind, ResolveRepositorySourceRequestSchema, ResolveRepositorySourceResponseSchema,
  SourceEntryType,
} from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const repositoryId = '9007199254740993', head = 'a'.repeat(40), feature = 'b'.repeat(40), tagHead = 'c'.repeat(40), shaName = 'd'.repeat(40);
const repository = { id: repositoryId, name: 'identity', fullName: 'alex/identity', defaultBranch: 'main', private: true };
const body = '# PRIVATE source\n![Private badge](./badge.svg)\n';
const blob = 'e'.repeat(40);
async function fixture(page: Page) {
  const state = {
    signedIn: true, userId: '17', metadataReads: 0, metadataWait: undefined as Promise<void> | undefined, metadataDenied: false, badSource: '', badSourcePath: undefined as string | undefined, badResolver: '', badImage: '', deniedResolver: '', holdResolver: false,
    held: [] as (() => void)[], resolverReads: [] as ReturnType<typeof request<typeof ResolveRepositorySourceRequestSchema>>[],
    reads: [] as ReturnType<typeof request<typeof GetContentsRequestSchema>>[], images: [] as ReturnType<typeof request<typeof GetRepositoryImageRequestSchema>>[],
  };
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1);
    if (method === 'GetSession') return state.signedIn ? respond(route, GetSessionResponseSchema, { user: { id: state.userId, login: 'alex' } }) : reject(route, 'unauthenticated', 'Signed out.');
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') { state.metadataReads++; if(state.metadataWait)await state.metadataWait; return state.metadataDenied ? reject(route,'permission_denied','Repository access removed.') : respond(route, GetRepositoryResponseSchema, { repository }); }
    if (method === 'ListBranches') return respond(route, ListBranchesResponseSchema, { repositoryId, branches: [{ name: 'main', commitId: head }, { name: 'feature/UI', commitId: feature }] });
    if (method === 'ResolveRepositorySource') {
      const input = request(route, ResolveRepositorySourceRequestSchema); state.resolverReads.push(input);
      if (state.holdResolver) await new Promise<void>(resolve => state.held.push(resolve));
      if (state.deniedResolver && input.selector?.kind === RepositorySourceRefKind.TAG) return reject(route, 'permission_denied', 'Current ref authority is unavailable.');
      const branches: Record<string, string> = { main: head, 'feature/UI': feature, release: feature, [shaName]: feature };
      const tags: Record<string, string> = { release: tagHead, [shaName]: tagHead };
      if(input.suffix){
        if(state.deniedResolver)return reject(route,'permission_denied','Current ref authority is unavailable.');
        const candidates=[RepositorySourceRefKind.BRANCH,RepositorySourceRefKind.TAG].flatMap(kind=>Object.entries(kind===RepositorySourceRefKind.BRANCH?branches:tags).filter(([name])=>input.suffix===name||input.suffix.startsWith(`${name}/`)).map(([name,commitId])=>({selection:{kind,name,commitId,tagObjectId:kind===RepositorySourceRefKind.TAG?blob:undefined},path:input.suffix===name?'':input.suffix.slice(name.length+1)})));
        if(!candidates.length)return reject(route,'not_found','Exact native ref not found.');
        return respond(route,ResolveRepositorySourceResponseSchema,{repositoryId,repository:{owner:'alex',name:'identity'},resolution:candidates.length===1?RepositorySourceResolution.RESOLVED:RepositorySourceResolution.AMBIGUOUS,suffix:input.suffix,candidates,selection:candidates.length===1?candidates[0]!.selection:undefined,path:candidates.length===1?candidates[0]!.path:''});
      }
      const kind = input.selector!.kind, name = kind === RepositorySourceRefKind.DEFAULT_BRANCH ? 'main' : input.selector!.name;
      const commitId = kind === RepositorySourceRefKind.TAG ? tags[name] : branches[name];
      if (!commitId) return reject(route, 'not_found', 'Exact native ref not found.');
      return respond(route, ResolveRepositorySourceResponseSchema, { resolution: RepositorySourceResolution.RESOLVED,
        repositoryId: state.badResolver === 'repositoryId' ? '18' : repositoryId,
        repository: { owner: state.badResolver === 'repository' ? 'other' : 'alex', name: 'identity' },
        path: state.badResolver === 'path' ? 'other.txt' : input.path,
        selection: { kind: state.badResolver === 'kind' ? RepositorySourceRefKind.COMMIT : kind,
          name: state.badResolver === 'name' ? '../invalid' : name,
          commitId: state.badResolver === 'commit' ? 'not-a-sha' : commitId,
          tagObjectId: kind === RepositorySourceRefKind.TAG ? state.badResolver === 'tagObject' ? 'e'.repeat(64) : blob : undefined },
      });
    }
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema); state.reads.push(input);
      const wrong = state.badSourcePath === undefined || state.badSourcePath === input.path ? state.badSource : '';
      const directory = input.path === '' || input.path === 'src';
      const name = input.path.split('/').at(-1) || '';
      const entries = input.path === 'src' ? [{ name: 'file.ts', path: 'src/file.ts', type: SourceEntryType.FILE, sha: blob, size: 7n }] : [
        { name: 'README.md', path: 'README.md', type: SourceEntryType.FILE, sha: blob, size: BigInt(Buffer.byteLength(body)) },
        { name: 'src', path: 'src', type: SourceEntryType.DIRECTORY, sha: blob },
      ];
      if (wrong === 'duplicate') entries.push(entries[0]!);
      return respond(route, GetContentsResponseSchema, {
        repositoryId: wrong === 'repositoryId' ? '18' : repositoryId,
        commitId: wrong === 'commit' ? tagHead : input.ref,
        path: wrong === 'path' ? 'other.txt' : input.path,
        kind: wrong === 'kind' ? SourceEntryType.UNSPECIFIED : directory ? SourceEntryType.DIRECTORY : SourceEntryType.FILE,
        entries: directory ? entries : [],
        file: directory ? undefined : { entry: { name, path: wrong === 'filePath' ? 'other.txt' : input.path, type: wrong === 'fileType' ? SourceEntryType.SYMLINK : SourceEntryType.FILE, sha: wrong === 'fileSHA' ? 'bad-sha' : blob, size: BigInt(Buffer.byteLength(input.path === 'README.md' ? body : 'PRIVATE')) }, content: input.path === 'README.md' ? body : 'PRIVATE' },
      });
    }
    if (method === 'GetRepositoryImage') {
      const input = request(route, GetRepositoryImageRequestSchema); state.images.push(input);
      return respond(route, GetRepositoryImageResponseSchema, {
        repositoryId: state.badImage === 'repositoryId' ? '18' : repositoryId,
        commitId: state.badImage === 'commit' ? tagHead : head,
        documentPath: state.badImage === 'document' ? 'other.md' : 'README.md',
        imageUrl: state.badImage === 'reference' ? './other.svg' : './badge.svg',
        mediaType: 'image/svg+xml', content: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="green"/></svg>'),
      });
    }
    return reject(route, 'unimplemented', 'Fixture does not implement this operation.');
  });
  return state;
}

const alert = (page: Page) => page.getByRole('alert');
test('default source, README, navigator and image calls share the exact native identity and commit', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/alex/identity');
  await expect(page.getByRole('img', { name: 'Private badge' })).toBeVisible();
  expect(state.resolverReads[0]).toMatchObject({ repositoryId, selector: { kind: RepositorySourceRefKind.DEFAULT_BRANCH, name: '' }, path: '' });
  expect(state.reads.every(input => input.repositoryId === repositoryId && input.ref === head)).toBe(true);
  expect(state.images.length).toBeGreaterThan(0);
  expect(state.images.every(input => input.repositoryId === repositoryId && input.commitId === head && input.documentPath === 'README.md' && input.imageUrl === './badge.svg')).toBe(true);
  expect(state.images[0]).toMatchObject({ repositoryId, commitId: head, documentPath: 'README.md', imageUrl: './badge.svg' });
  await page.getByRole('link', { name: /^README.md File/ }).click();
  await expect(page.getByRole('navigation', { name: 'Repository files', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand src', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Repository files', exact: true }).getByRole('link', { name: 'file.ts', exact: true })).toBeVisible();
  expect(state.reads.every(input => input.repositoryId === repositoryId && input.ref === head)).toBe(true);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE|README.md|badge.svg|file.ts/);
});

for (const [type, expected] of [['branch', feature], ['tag', tagHead]] as const) test(`SHA-looking explicit ${type} resolves its namespace instead of opening a detached commit`, async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/repositories/alex/identity?ref=${shaName}&${type}=${shaName}&path=src/file.ts`);
  await expect(page.getByLabel('Plain text preview of file.ts')).toContainText('PRIVATE');
  expect(state.resolverReads.length).toBeGreaterThan(0);
  expect(state.resolverReads.every(input => input.selector?.kind === (type === 'branch' ? RepositorySourceRefKind.BRANCH : RepositorySourceRefKind.TAG) && input.selector.name === shaName)).toBe(true);
  expect(state.resolverReads[0]?.selector).toMatchObject({ kind: type === 'branch' ? RepositorySourceRefKind.BRANCH : RepositorySourceRefKind.TAG, name: shaName });
  expect(state.reads[0]).toMatchObject({ repositoryId, ref: expected, path: 'src/file.ts' });
  await expect(page).toHaveURL(new RegExp(`/blob/${shaName}/src/file.ts`));
});

test('untyped branch/tag collision remains ambiguous and sends no source request', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/repositories/alex/identity?ref=release&path=src/file.ts');
  await expect(page.getByRole('list',{name:'Source address candidates'}).getByRole('link')).toHaveCount(2);
  expect(state.resolverReads[0]?.suffix).toBe('release/src/file.ts'); expect(state.reads).toHaveLength(0);
  await expect(page).toHaveURL(/ref=release/);
  await page.locator('.branch-picker > summary').click();
  await page.getByRole('link', { name: `main Listed at ${head.slice(0, 12)}` }).click();
  await expect(page.locator('.source-tree')).toBeVisible();
});

test('a denied candidate is not absence and cannot select the other namespace', async ({ page }) => {
  const state = await fixture(page); state.deniedResolver = 'tag';
  await page.goto('/repositories/alex/identity?ref=feature%2FUI&path=src/file.ts');
  await expect(alert(page)).toContainText('Current ref authority'); expect(state.reads).toHaveLength(0);
});

for (const wrong of ['repositoryId', 'repository', 'path', 'kind', 'name', 'commit', 'tagObject']) test(`resolver ${wrong} mismatch withholds all source bytes`, async ({ page }) => {
  const state = await fixture(page); state.badResolver = wrong;
  await page.goto(`/repositories/alex/identity?ref=release&tag=release&path=src/file.ts`);
  await expect(alert(page)).toContainText('resolved source selection'); expect(state.reads).toHaveLength(0);
  await expect(page.getByLabel('Plain text preview of file.ts')).toHaveCount(0);
});

for (const wrong of ['repositoryId', 'commit', 'path', 'kind', 'filePath', 'fileType', 'fileSHA']) test(`source ${wrong} mismatch withholds file/navigator/banner/image output`, async ({ page }) => {
  const state = await fixture(page); state.badSource = wrong;
  await page.goto(`/alex/identity/blob/${head}/src/file.ts`);
  await expect(alert(page)).toBeVisible();
  await expect(page.getByLabel('Plain text preview of file.ts')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Repository files', exact: true })).toHaveCount(0);
  expect(state.images).toHaveLength(0); expect(state.resolverReads).toHaveLength(0);
});

test('duplicate root inventory prevents private rows and README discovery', async ({ page }) => {
  const state = await fixture(page); state.badSource = 'duplicate';
  await page.goto(`/alex/identity/tree/${head}`);
  await expect(alert(page)).toContainText('duplicate');
  await expect(page.locator('.source-tree')).toHaveCount(0); expect(state.reads.length).toBeGreaterThan(0); expect(state.reads.every(input => input.path === '')).toBe(true); expect(state.images).toHaveLength(0);
});

for (const wrong of ['repositoryId', 'commit', 'document', 'reference']) test(`image ${wrong} receipt is rejected before byte decoding`, async ({ page }) => {
  const state = await fixture(page); state.badImage = wrong;
  await page.goto(`/alex/identity/blob/${head}/README.md`);
  await expect(page.getByText('Private badge (image preview unavailable)', { exact: true })).toBeVisible();
  await expect(page.locator('.markdown-body img')).toHaveCount(0);
  expect(state.images[0]).toMatchObject({ repositoryId, commitId: head, documentPath: 'README.md', imageUrl: './badge.svg' });
});

test('a held resolver cannot read content or overwrite navigation after switching workspaces', async ({ page }) => {
  const state = await fixture(page); state.holdResolver = true;
  await page.goto('/alex/identity'); await expect.poll(() => state.held.length).toBeGreaterThan(0);
  await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Issues' }).click();
  state.holdResolver = false; state.held.forEach(resolve => resolve());
  await expect(page).toHaveURL(/\/issues$/); expect(state.reads).toHaveLength(0);
  await expect(page.locator('.source-tree')).toHaveCount(0);
});

for (const theme of ['dark', 'light']) test(`exact source controls and permalink remain keyboard accessible at 390px ${theme}`, async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/alex/identity/blob/${head}/src/file.ts#L1`);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await expect(page.getByLabel('Plain text preview of file.ts')).toBeVisible();
  await page.getByLabel('Source actions', { exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Copy source permalink' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

for (const path of ['README.md', 'src']) test(`downstream ${path} identity mismatch hides only unverified private output`, async ({ page }) => {
  const state = await fixture(page); state.badSource = 'repositoryId'; state.badSourcePath = path;
  await page.goto(`/alex/identity/${path === 'src' ? `blob/${head}/README.md` : `tree/${head}`}`);
  if (path === 'src') {
    await page.getByRole('button', { name: 'Expand src', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Repository files', exact: true }).getByRole('alert')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Repository files', exact: true }).getByRole('link', { name: 'file.ts', exact: true })).toHaveCount(0);
  } else {
    await expect(alert(page)).toContainText('source receipt');
    await expect(page.getByLabel('Rendered README.md')).toHaveCount(0); expect(state.images).toHaveLength(0);
    await expect(page.locator('.source-tree')).toBeVisible();
  }
});

test('sign-out fences a delayed resolver and reopening under another account performs fresh exact reads', async ({ page }) => {
  const state = await fixture(page); state.holdResolver = true;
  await page.goto('/alex/identity'); await expect.poll(() => state.held.length).toBeGreaterThan(0);
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  state.holdResolver = false; state.held.splice(0).forEach(resolve => resolve());
  expect(state.reads).toHaveLength(0); await expect(page.locator('.source-tree')).toHaveCount(0);
  state.userId = '18'; state.signedIn = true; await page.reload();
  await expect(page.getByRole('img', { name: 'Private badge' })).toBeVisible();
  expect(state.reads.every(input => input.repositoryId === repositoryId && input.ref === head)).toBe(true);
});


for (const ref of ['release', shaName]) test(`conflicting explicit namespaces for ${ref} are refused before resolver and source calls`, async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/repositories/alex/identity?ref=${ref}&branch=${ref}&tag=${ref}&path=src/file.ts`);
  await expect(alert(page)).toContainText('both branch and tag namespaces');
  expect(state.resolverReads).toHaveLength(0); expect(state.reads).toHaveLength(0); expect(state.images).toHaveLength(0);
  await expect(page.getByLabel('Plain text preview of file.ts')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Repository files', exact: true })).toHaveCount(0);
});

test('immutable SHA keeps nonmatching branch and tag contextual labels without named resolution', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/alex/identity/blob/${head}/src/file.ts?branch=main&tag=release`);
  await expect(page.getByLabel('Plain text preview of file.ts')).toContainText('PRIVATE');
  expect(state.resolverReads).toHaveLength(0);
  expect(state.reads.every(input => input.repositoryId === repositoryId && input.ref === head)).toBe(true);
});

test('a late resolver cannot restore private content over a conflicting selection', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/alex/identity/blob/${head}/src/file.ts?branch=main`);
  await expect(page.getByLabel('Plain text preview of file.ts')).toContainText('PRIVATE');
  state.holdResolver = true; await page.getByRole('button', { name: 'Latest branch head', exact: true }).click();
  await expect.poll(() => state.held.length).toBeGreaterThan(0);
  await page.evaluate(() => {
    history.pushState({}, '', '/repositories/alex/identity?ref=release&branch=release&tag=release&path=src/file.ts');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(alert(page)).toContainText('both branch and tag namespaces');
  const resolverCount = state.resolverReads.length, sourceCount = state.reads.length;
  state.holdResolver = false; state.held.splice(0).forEach(resolve => resolve());
  await expect(page.getByLabel('Plain text preview of file.ts')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Repository files', exact: true })).toHaveCount(0);
  expect(state.resolverReads).toHaveLength(resolverCount); expect(state.reads).toHaveLength(sourceCount);
  await expect(page).toHaveURL(/ref=release&branch=release&tag=release/);
});


test('immutable source and decoded image survive authority checks without collapse or repeated reads',async({page})=>{
 const state=await fixture(page);await page.goto(`/alex/identity/tree/${head}?branch=main`);
 const image=page.locator('img[alt="Private badge"]');await expect(image).toBeVisible();
 const retained=await image.elementHandle();const height=await page.evaluate(()=>document.documentElement.scrollHeight);
 const sources=state.reads.length,images=state.images.length,metadata=state.metadataReads;
 let release!:()=>void;state.metadataWait=new Promise<void>(resolve=>release=resolve);
 await page.getByRole('button',{name:'Refresh repository access',exact:true}).click();
 await expect.poll(()=>state.metadataReads).toBeGreaterThan(metadata);
 await expect(page.getByText('Checking repository access…',{exact:true})).toBeVisible();await expect(image).toBeHidden();
 expect(await page.evaluate(()=>document.documentElement.scrollHeight)).toBe(height);
 expect(await image.evaluate((node,previous)=>node===previous,retained)).toBe(true);
 release();state.metadataWait=undefined;await expect(image).toBeVisible();
 expect(await image.evaluate((node,previous)=>node===previous,retained)).toBe(true);expect(state.reads).toHaveLength(sources);expect(state.images).toHaveLength(images);
 await page.evaluate(()=>{window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));});
 await expect(image).toBeVisible();expect(state.reads).toHaveLength(sources);expect(state.images).toHaveLength(images);
 state.metadataDenied=true;await page.getByRole('button',{name:'Refresh repository access',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Repository access removed');await expect(page.getByRole('img',{name:'Private badge',exact:true})).toHaveCount(0);await expect(page.locator('.source-tree')).toHaveCount(0);
 await retained?.dispose();
});

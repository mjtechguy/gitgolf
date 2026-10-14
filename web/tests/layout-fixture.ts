import { portableRuntimeFixture } from './runtime-fixture';
import type { Page } from '@playwright/test';
import {
  GetAuthenticationOptionsResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema, GetRepositoryOverviewResponseSchema,
  GetRepositoryResponseSchema, GetSessionResponseSchema, ListBranchesResponseSchema, ListCapabilitiesResponseSchema, ListCommitsRequestSchema,
  ListCommitsResponseSchema, ListIssuesResponseSchema, ListPullRequestsResponseSchema, ListRepositoriesResponseSchema, RepositoryOverviewSectionState as State, SourceEntryType,
} from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond, resolveSourceFixture } from './rpc';

// Shared by layout-presets.spec.ts. `rich` serves a fuller repository for comparing layouts with the design study.
const head = 'a'.repeat(40), blob = 'b'.repeat(40), repositoryId = '41';
const repository = { id: repositoryId, name: 'demo', fullName: 'alex/demo', defaultBranch: 'main', private: true, issuesEnabled: true, pullRequestsEnabled: true,
  description: 'A layout fixture.', cloneUrl: 'https://forge.example/alex/demo.git', updatedAt: '2026-10-01T12:00:00Z' };
const entry = (name: string, type = SourceEntryType.FILE) => ({ name, path: name, sha: blob, type });
const richEntries: [string, string, string, string][] = [['.github', 'Bump actions/checkout to v5', 'dependabot[bot]', '2026-09-22'], ['docs', 'Update German translations', 'tiangolo', '2026-10-11'], ['docs_src', 'Add example for dependency overrides', 'YuriiMotov', '2026-10-06'], ['fastapi', 'Fix response model validation for unions', 'tiangolo', '2026-10-08'], ['scripts', 'Refactor docs build script', 'alejsdev', '2026-09-29'], ['tests', 'Add tests for union response models', 'tiangolo', '2026-10-08'], ['.gitignore', 'Ignore uv cache directory', 'tiangolo', '2026-07-13'], ['.pre-commit-config.yaml', 'Update pre-commit hooks', 'pre-commit-ci[bot]', '2026-10-06'], ['.python-version', 'Pin Python 3.11 for development', 'tiangolo', '2026-06-13'], ['CITATION.cff', 'Add citation file', 'tiangolo', '2024-10-13'], ['LICENSE', 'Initial commit', 'tiangolo', '2019-10-13'], ['pyproject.toml', 'Release version 0.143.0', 'pr-submit[bot]', '2026-10-08'], ['README.md', 'Update sponsors', 'tiangolo', '2026-10-06'], ['uv.lock', 'Release version 0.143.0', 'pr-submit[bot]', '2026-10-08']];
const richReadme = '# FastAPI\n\nFastAPI framework, high performance, easy to learn, fast to code, ready for production.\n\nFastAPI is a modern web framework for building APIs with Python, based on standard Python type hints.\n\n## Key features\n\n- **Fast.** Very high performance, on par with NodeJS and Go.\n- **Fast to code.** Ship features sooner with less boilerplate.\n- **Fewer bugs.** Editor support and validation catch mistakes early.\n- **Standards-based.** Built on OpenAPI and JSON Schema.\n\n## Installation\n\n```\npip install "fastapi[standard]"\n```\n';
export async function fixture(page: Page, rich = false) {
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex' } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository, { ...repository, id: '42', name: 'tools', fullName: 'alex/tools', private: false }, ...(rich ? [['edge-api', 'Public API and shared services at the edge.', true], ['design-system', 'Shared tokens and components for Golf.', true], ['tiny-tools', 'Small tools for everyday work.', false]].map(([name, description, isPrivate], index) => ({ ...repository, id: String(50 + index), name: name as string, fullName: `alex/${name}`, description: description as string, private: isPrivate as boolean })) : [])] });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository: rich ? { ...repository, private: false, description: 'FastAPI framework, high performance, easy to learn, fast to code, ready for production.' } : repository });
    if (method === 'GetRepositoryOverview') return respond(route, GetRepositoryOverviewResponseSchema, { repositoryId, repository: { owner: 'alex', name: 'demo' }, description: rich ? 'FastAPI framework, high performance, easy to learn, fast to code, ready for production.' : 'A layout fixture.', website: rich ? 'https://fastapi.tiangolo.com' : '', topics: rich ? ['api', 'python', 'web-framework'] : ['layouts'], licenseIds: ['MIT'], starsCount: '0', watchersCount: '1', forksCount: '0', languages: rich ? [{ name: 'Python', byteCount: '9890' }, { name: 'JavaScript', byteCount: '60' }, { name: 'CSS', byteCount: '40' }, { name: 'HTML', byteCount: '10' }] : [{ name: 'TypeScript', byteCount: '750' }, { name: 'Go', byteCount: '250' }], languagesState: State.AVAILABLE, licensesState: State.AVAILABLE });
    if (method === 'ListBranches') return respond(route, ListBranchesResponseSchema, { repositoryId, branches: [{ name: 'main', commitId: head }] });
    if (method === 'ResolveRepositorySource') return resolveSourceFixture(route, repositoryId, { owner: 'alex', name: 'demo' }, 'main', { main: head });
    if (method === 'ListCommits') { const input = request(route, ListCommitsRequestSchema); return respond(route, ListCommitsResponseSchema, { repositoryId, commitId: head, path: input.path, commits: [rich ? (([, message, authorName, day]) => ({ sha: head, message, authorName, authoredAt: `${day}T12:00:00Z` }))(richEntries.find(([name]) => name === input.path) ?? ['', 'Release version 0.143.0 (#16477)', 'pr-submit[bot]', '2026-10-08']) : { sha: head, message: 'Arrange the panes', authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' }] }); }
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema);
      if (!input.path || input.path === 'src' || rich && richEntries.slice(0, 6).some(([name]) => name === input.path)) return respond(route, GetContentsResponseSchema, { repositoryId, commitId: head, path: input.path, kind: SourceEntryType.DIRECTORY,
        entries: input.path ? input.path === 'src' ? [{ ...entry('index.ts'), path: 'src/index.ts' }] : [] : rich ? richEntries.map(([name], index) => entry(name, index < 6 ? SourceEntryType.DIRECTORY : SourceEntryType.FILE)) : [entry('src', SourceEntryType.DIRECTORY), entry('LICENSE'), entry('README.md'), entry('package.json')] });
      return respond(route, GetContentsResponseSchema, { repositoryId, commitId: head, path: input.path, kind: SourceEntryType.FILE,
        file: { entry: { ...entry(input.path.split('/').at(-1)!), path: input.path }, content: input.path === 'README.md' ? rich ? richReadme : '# Demo\n\nA repository for arranging layouts.\n\n## Use\n\nOpen the code tab.' : 'export const value = true;' } });
    }
    if (method === 'ListIssues') return respond(route, ListIssuesResponseSchema, { issues: Array.from({ length: rich ? 12 : 0 }, (_, index) => ({ number: index + 1, title: `Issue ${index + 1}` })) });
    if (method === 'ListPullRequests') return respond(route, ListPullRequestsResponseSchema, { pullRequests: Array.from({ length: rich ? 3 : 0 }, (_, index) => ({ number: index + 20, title: `Pull request ${index + 1}` })) });
    return reject(route, 'unimplemented', 'Fixture procedure unavailable.');
  });
}

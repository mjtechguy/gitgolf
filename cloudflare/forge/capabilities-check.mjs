import { reviewAuthoringMethods } from './src/review-authoring.mjs';
import { pullReviewMethods } from './src/pull-reviews.mjs';
import { gitCredentialMethods } from './src/git-credentials.mjs';
import { ruleMethods } from './src/repository-rules.mjs';
import { webhookMethods } from './src/webhooks.mjs';
import { engagementMethods } from './src/discussion-engagement.mjs';
import { resourceMethods } from './src/discussion-resources.mjs';
// Inventory every public RPC against the explicitly bounded native adapter.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { invitationMethods } from './src/invitations.mjs';
import { collaborationMethods } from './src/collaboration.mjs';
const contracts = new URL('../../api/golf/v1/', import.meta.url);
const files = (await readdir(contracts)).filter(name => name.endsWith('.proto')).sort();
const protos = await Promise.all(files.map(async name => ({ name, text: await readFile(new URL(name, contracts), 'utf8') })));
const supported = {
  PullMergeObservationService: new Set(['GetPullRequestMergeObservation']),
  PullReviewAuthoringService: reviewAuthoringMethods,
  PullReviewRequestService: pullReviewMethods,
  GitTransportService: gitCredentialMethods,
  RepositoryRulesService: ruleMethods,
  RepositoryWebhookService: webhookMethods,
  DiscussionCollaborationService: engagementMethods,
  RepositoryActivityService: new Set(['WatchRepository']),
  OperationsService: new Set(['GetOperationsDashboard']),
  SessionService: new Set(['GetSession', 'GetAuthenticationOptions']),
  CapabilityService: new Set(['ListCapabilities']),
  ProfileService: new Set(['GetProfile', 'UpdateProfile']),
  OrganizationService: new Set(['ListOrganizations', 'GetOrganization']),
  RepositorySettingsService: new Set(['GetRepositorySettings', 'UpdateRepositorySettings', 'UpdateRepositoryTopics']),
  RepositoryInvitationService: invitationMethods,
  RepositoryAccessService: new Set(['GetRepositoryAccess', 'ListRepositoryCollaborators', 'ResolveRepositoryCollaborator', 'SetRepositoryCollaborator', 'RemoveRepositoryCollaborator', 'GetRepositoryAccessOperation']),
  RepositoryService: new Set(['ListRepositories', 'CreateRepository', 'GetRepositoryCreation', 'GetRepository', 'GetRepositoryOverview', 'GetRepositoryStar', 'SetRepositoryStar', 'ListBranches', 'ListTags', 'ResolveRepositorySource', 'GetContents', 'GetRepositoryFileIndex', 'GetRepositoryImage', 'ListCommits', 'GetCommitDiff', 'GetRepositoryComparison', ...collaborationMethods, ...resourceMethods]),
};
const limitations = {
  PullMergeObservationService: 'Exact current same-repository comparison, branch locks, retained source and current writer observations. No executable merge authority; all strategies remain disabled.',
  PullReviewAuthoringService: 'Private pending overall summaries, exact-source update/publication and discard with original receipts. No saved inline draft transfer or comment edits.',
  PullReviewRequestService: 'Human account review assignments, cancellation and admin dismissal/restoration with original receipts. Current direct grants and exact-base GitHub-format CODEOWNERS suggestions; no team assignments, inline comments, automatic routing or protected approval authority.',
  GitTransportService: 'Own Access-authenticated account; repository-only, identity/grant-bound HTTPS read/write credentials, one-time secrets, 5–60 minute expiry and revocation. Separate Access gate; SSH and receive-outcome RPC remain unavailable.',
  RepositoryRulesService: 'Branch locks and tag account restrictions enforced on Golf Git; exact/prefix patterns, current admin, atomic receipts. No protected merge, review/check gates, teams or provider-side enforcement.',
  RepositoryWebhookService: 'Encrypted subscriptions and signed durable deliveries to operator-approved HTTPS origins; current sponsor authority, bounded retries/daily attempts, tests and explicit redelivery. Native test-job events; repository email remains separate.',
  DiscussionCollaborationService: 'Current-authority reactions, own subscriptions and in-app inbox; transaction-bound timeline since schema14. Historical activity is not backfilled; templates and email remain separate.',
  RepositoryActivityService: 'Bounded resumable Connect JSON/protobuf invalidations from the workspace SQLite journal; current authority before each frame. External Artifacts writes need native ingress.',
  OperationsService: 'Current Access-enrolled workspace ops administrators; inventories and maintenance journal. Fleet provider analytics/billing not collected.',
  SessionService: 'Access identity; local password, MFA, SSH and account lifecycle remain separate.',
  ProfileService: 'Own enrolled profile, revision-fenced updates.',
  OrganizationService: 'One independently provisioned workspace; membership administration remains open.',
  RepositorySettingsService: 'Description, website, topics and existing default branch; atomic current-authority and revision checks. Feature policy remains operator-managed.',
  RepositoryAccessService: 'Enrolled direct collaborator inventory/resolution and atomic version-fenced grants with original receipts. Teams and SSH deploy keys remain open.',
  RepositoryInvitationService: 'Enrolled Access users only; current issuer administration, expiring consent, atomic grant/decision and original receipt lookup. No email delivery or automatic enrollment.',
  RepositoryService: 'Bounded Git/read contract, immutable source pages and complete bounded filename/path indexes, overall reviews and same-repository PRs. Repository labels/milestones, issue/PR assignment and author/admin comment editing; no protected merge, inline review threads or organization labels. Pending overall drafts use PullReviewAuthoringService.',
};
const source = (await Promise.all(['core.mjs', 'file-index.mjs', 'repository-settings.mjs', 'invitations.mjs', 'discussion-resources.mjs', 'discussion-engagement.mjs', 'webhooks.mjs', 'repository-rules.mjs', 'git-credentials.mjs', 'pull-reviews.mjs', 'review-authoring.mjs', 'codeowners.mjs', 'owners.mjs', 'workspace-ui.mjs'].map(name => readFile(new URL('./src/' + name, import.meta.url), 'utf8')))).join('\n');
for (const methods of Object.values(supported)) for (const method of methods) if (!collaborationMethods.has(method) && !source.includes("'" + method + "'") && !source.includes("/" + method + "'")) throw Error('Native adapter declaration has no maintained implementation: ' + method);
const inventory = [];
for (const proto of protos) for (const service of proto.text.matchAll(/service\s+(\w+)\s*\{(.*?)\n\}/gs)) for (const method of service[2].matchAll(/rpc\s+(\w+)/g)) inventory.push({ service: service[1], method: method[1], contract: proto.name, adapter: supported[service[1]]?.has(method[1]) ? 'Bounded adapter' : 'Missing native adapter' });
if (new Set(inventory.map(row => row.service + '/' + row.method)).size !== inventory.length) throw Error('Duplicate shared RPC declaration');
for (const [service, methods] of Object.entries(supported)) for (const method of methods) if (!inventory.some(row => row.service === service && row.method === method)) throw Error(`Native procedure has no shared contract: ${service}/${method}`);
const report = '# Cloudflare native capability inventory\n\nGenerated from every `api/golf/v1/*.proto` contract by `node cloudflare/forge/capabilities-check.mjs --write`. Every shared RPC is listed; an adapter is implementation evidence, not proof of complete portable behavior or hosted acceptance. Provider-only evidence/preview endpoints and ordinary Git transport are tested separately.\n\n' +
  '| Service | Adapted procedures | Remaining procedures | Boundary |\n| --- | ---: | ---: | --- |\n' + [...new Set(inventory.map(row => row.service))].map(service => { const rows = inventory.filter(row => row.service === service), count = rows.filter(row => row.adapter === 'Bounded adapter').length; return `| ${service} | ${count} | ${rows.length - count} | ${limitations[service] || (count ? 'Explicit native contract.' : 'Native migration required; portable service remains available on its own setup path.')} |`; }).join('\n') +
  '\n\n| Procedure | Contract | Native state |\n| --- | --- | --- |\n' + inventory.map(row => `| ${row.service}/${row.method} | ${row.contract} | ${row.adapter} |`).join('\n') + '\n';
const target = new URL('../../docs/CLOUDFLARE_CAPABILITY_INVENTORY.md', import.meta.url);
if (process.argv.includes('--write')) await writeFile(target, report);
else if (await readFile(target, 'utf8') !== report) throw Error('Native capability inventory drifted; inspect new contracts and regenerate it');
console.log(JSON.stringify({ procedures: inventory.length, boundedNativeAdapters: inventory.filter(row => row.adapter === 'Bounded adapter').length, missingNativeAdapters: inventory.filter(row => row.adapter !== 'Bounded adapter').length }));

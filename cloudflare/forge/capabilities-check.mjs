import { reviewAuthoringMethods } from './src/review-authoring.mjs';
import { pullReviewMethods } from './src/pull-reviews.mjs';
import { pullMergeMethods } from './src/pull-merge.mjs';
import { gitCredentialMethods } from './src/git-credentials.mjs';
import { ruleMethods } from './src/repository-rules.mjs';
import { webhookMethods } from './src/webhooks.mjs';
import { emailMethods } from './src/email.mjs';
import { environmentMethods } from './src/environments.mjs';
import { executionValueMethods } from './src/execution-values.mjs';
import { releaseMethods, releaseReadMethods } from './src/releases.mjs';
import { attachmentMethods } from './src/attachments.mjs';
import { engagementMethods } from './src/discussion-engagement.mjs';
import { resourceMethods } from './src/discussion-resources.mjs';
// Inventory every public RPC against the explicitly bounded native adapter.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { invitationMethods } from './src/invitations.mjs';
import { collaborationMethods } from './src/collaboration.mjs';
import { workflowMethods } from './src/workflow-inventory.mjs';
import { executionPolicyMethods } from './src/execution-policy.mjs';
import { featurePolicyMethods, repositoryFeatureMethods } from './src/feature-policy.mjs';
const contracts = new URL('../../api/golf/v1/', import.meta.url);
const files = (await readdir(contracts)).filter(name => name.endsWith('.proto')).sort();
const protos = await Promise.all(files.map(async name => ({ name, text: await readFile(new URL(name, contracts), 'utf8') })));
const supported = {
  PullMergeObservationService: new Set(['GetPullRequestMergeObservation']),
  StandardPullMergeService: pullMergeMethods,
  PullReviewAuthoringService: reviewAuthoringMethods,
  PullReviewRequestService: pullReviewMethods,
  GitTransportService: gitCredentialMethods,
  RepositoryRulesService: ruleMethods,
  WorkflowService: workflowMethods,
  ExecutionPolicyService: executionPolicyMethods,
  FeaturePolicyService: featurePolicyMethods,
  RepositoryFeatureService: repositoryFeatureMethods,
  RepositoryWebhookService: webhookMethods,
  EmailNotificationService: emailMethods,
  RepositoryEnvironmentService: environmentMethods,
  RepositoryExecutionValueService: executionValueMethods,
  ...releaseMethods,
  ...attachmentMethods,
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
for (const method of releaseReadMethods) supported.RepositoryService.add(method);
const limitations = {
  PullMergeObservationService: 'Exact current same-repository comparison, branch locks, retained source, current writer and merge observations; up to 50 conflicting paths of a three-way tree merge with their count. No executable merge authority; merge commits and squash are reported only for a pull request the native merge slice would currently admit.',
  StandardPullMergeService: 'Same-repository merge commits and squash merges, including diverged branches by a path-level three-way tree merge from a single merge base within 500 commits: writer authority, rules, one journaled single-ref write and ref/commit/tree readback; original receipts. Conflicts (listed by path, no line-level merge), multiple merge bases, rebase, forks and locked targets are durably refused; an unconfirmed write stays unknown and fences the repository. Provider acceptance of the generated pack needs hosted proof.',
  DiscussionAttachmentService: 'Current repository readers list and download description or comment files; SHA-256 verified before bytes are returned. No replacement or deletion.',
  DiscussionAttachmentUploadService: 'Up to 100 files of 256 KiB per description or comment in private R2; the author or a writer for descriptions, the writing author or an administrator for comments. Original receipts; an unacknowledged write settles by readback and is never sent twice.',
  RepositoryReleasePublicationService: 'One publication per existing tag no tag rule names, by a current administrator; never creates or moves a tag. Atomic D1 release and original receipt.',
  RepositoryReleaseManagementService: 'Revision-fenced edits, removal and up to 25 assets of 256 KiB in private R2 under original receipts; an unacknowledged upload settles by readback and is never sent twice. Downloads stream only with current repository access.',
  PullReviewAuthoringService: 'Private pending overall summaries, exact-source update/publication and discard with original receipts. No saved inline draft transfer or comment edits.',
  PullReviewRequestService: 'Human account review assignments, cancellation and admin dismissal/restoration with original receipts. Current direct grants and exact-base GitHub-format CODEOWNERS suggestions; no team assignments, inline comments, automatic routing or protected approval authority.',
  GitTransportService: 'Own Access-authenticated account; repository-only, identity/grant-bound HTTPS read/write credentials, one-time secrets, 5–60 minute expiry and revocation. Separate Access gate; SSH and receive-outcome RPC remain unavailable.',
  RepositoryRulesService: 'Branch locks and tag account restrictions enforced on Golf Git; exact/prefix patterns, current admin, atomic receipts. No protected merge, review/check gates, teams or provider-side enforcement.',
  RepositoryWebhookService: 'Encrypted subscriptions and signed durable deliveries to operator-approved HTTPS origins; current sponsor authority, bounded retries/daily attempts, tests and explicit redelivery. Native test-job events; repository email remains separate.',
  EmailNotificationService: 'Own Access sign-in address only, through the Cloudflare Email Service binding: explicit account consent, per-repository subscriptions, provider acceptance history and explicit redelivery under current grant, identity and consent. Category-and-link messages, six attempts and a daily attempt budget. No SMTP transports, verification codes, unsubscribe links, bounce or reply handling; bearer and service-token callers are refused.',
  RepositoryEnvironmentService: 'One environment named preview, enforced on protected PR previews: head branches, lifetime under the operator ceiling and concurrent previews. Verified Access administrator, version-fenced saves and original receipts. No reviewers, wait timers, tag/commit selectors, environment secrets or deployment.',
  RepositoryExecutionValueService: 'Encrypted repository secrets and plain variables with exact-commit approvals of the one operator-approved Actions workflow; Access-verified administrators, version-fenced writes and original receipts. Released as environment variables only to approved Cloudflare-hosted pull-request jobs, with exact-match masking of stored output. No typed inputs, manual dispatch, organization values, environment scopes, secrets expressions, customer-runner or agent release.',
  DiscussionCollaborationService: 'Current-authority reactions, own subscriptions and in-app inbox; transaction-bound timeline since schema14. Historical activity is not backfilled. Issue templates and forms are read from the default-branch head with the portable limits; email remains separate.',
  WorkflowService: 'Read-only inventory of .github/workflows/*.yml and .gitlab-ci.yml at the default-branch commit for current repository accounts: at most 20 files of 64 KiB, classified against the native shell subset, with the one operator-approved path marked. No dispatch, editor or run history.',
  ExecutionPolicyService: 'Repository scope only: current administrators under a verified human Access sign-in turn pull-request runs and automatic push tests off or on with policy and authority revision checks; bearer and service-token callers can read but not change it. Enforced when a run is admitted; admitted runs are not revoked. No instance or organization ceilings, repository selection or workflow path lists.',
  FeaturePolicyService: 'Installation scope only: current operations administrators under a verified human Access sign-in read every feature with its mode, operator allocation and reach, and change one mode at a time with a version fence; widening needs the feature id typed back and public repositories can never be required. Organization policies are not available yet.',
  RepositoryFeatureService: 'Effective state of every governed feature for one repository and the level that decided it, joined into the repository grant read. Current administrators under a verified human Access sign-in turn allowed features on or off with a revision fence; Actions writes through the repository execution switch. Off keeps data.',
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
const source = (await Promise.all(['core.mjs', 'file-index.mjs', 'repository-settings.mjs', 'invitations.mjs', 'discussion-resources.mjs', 'discussion-engagement.mjs', 'webhooks.mjs', 'repository-rules.mjs', 'git-credentials.mjs', 'pull-reviews.mjs', 'pull-merge.mjs', 'review-authoring.mjs', 'codeowners.mjs', 'owners.mjs', 'workspace-ui.mjs', 'environments.mjs', 'workflow-inventory.mjs', 'execution-policy.mjs', 'feature-policy.mjs', 'execution-values.mjs', 'email.mjs', 'releases.mjs', 'attachments.mjs'].map(name => readFile(new URL('./src/' + name, import.meta.url), 'utf8')))).join('\n');
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

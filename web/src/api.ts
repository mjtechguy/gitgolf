import {PasswordRecoveryEnrollmentService} from './gen/golf/v1/password_recovery_enrollment090_pb';
import {PasswordRecoveryService} from './gen/golf/v1/password_recovery090_pb';
import {ProviderImportService,PackagePublicationService} from './gen/golf/v1/golf_pb';
import {MirrorObservationService} from './gen/golf/v1/golf_pb';
import { createClient, ConnectError } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { DiscussionCollaborationService, RepositoryReleaseManagementService, RepositoryRefMutationService, RepositoryFileMutationService } from './gen/golf/v1/golf_pb';
import { PullReviewRequestService } from './gen/golf/v1/golf_pb';

import { RepositoryMirrorService } from './gen/golf/v1/golf_pb';
import { RepositoryWikiManagementService,ForgePackageService,OrganizationLabelService,RepositoryWikiService } from './gen/golf/v1/golf_pb';
import { RepositoryDeploymentService, RepositoryReleasePublicationService, WorkflowArtifactService, StandardPullMergeService, PullMergeObservationService, RepositoryEnvironmentService, OrganizationExecutionValueService, GitTransportService, RunnerPoolService, RunnerControlService, RepositoryRulesService, RepositoryInvitationService, RepositoryExecutionValueService, EmailNotificationService, RepositoryLifecycleService, RepositoryTeamAccessService, RepositoryWebhookService, RepositoryDeployKeyService, ActionRunService, RepositoryActivityService, ReviewerService, AgentTaskService, AgentUsageService, CodexAccountService, AutomationGrantService, AccountSecurityService, ProfileService, InfrastructureConnectionService, OrganizationCreationService, ExecutionPolicyService, WorkflowRunService, WorkflowService, RepositoryAccessService, InstanceAdminService, OrganizationAdminService, RepositorySettingsService, GitAccessService, ApiCredentialService, AuditService, CapabilityService, OrganizationService, RepositoryService, SessionService } from './gen/golf/v1/golf_pb';

const transport = createConnectTransport({
  baseUrl: '/rpc',
  useBinaryFormat: false,
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin', cache: 'no-store' }),
});

export const discussionCollaborationClient = createClient(DiscussionCollaborationService, transport);

export const providerImportClient=createClient(ProviderImportService,transport);
export const mirrorObservationClient=createClient(MirrorObservationService,transport);
export const packagePublicationClient=createClient(PackagePublicationService,transport);
export const repositoryMirrorClient=createClient(RepositoryMirrorService,transport);
export const releaseManagementClient=createClient(RepositoryReleaseManagementService,transport);
export const repositoryWikiManagementClient=createClient(RepositoryWikiManagementService,transport);
export const forgePackageClient=createClient(ForgePackageService,transport);
export const organizationLabelClient=createClient(OrganizationLabelService,transport);
export const repositoryWikiClient=createClient(RepositoryWikiService,transport);
export const pullReviewRequestClient=createClient(PullReviewRequestService,transport);
export const repositoryDeploymentClient=createClient(RepositoryDeploymentService,transport);
export const releasePublicationClient=createClient(RepositoryReleasePublicationService,transport);
export const repositoryRefMutationClient = createClient(RepositoryRefMutationService, transport);
export const pullMergeObservationClient=createClient(PullMergeObservationService,transport);
export const standardPullMergeClient=createClient(StandardPullMergeService,transport);
export const gitTransportClient=createClient(GitTransportService,transport);
export const actionRunClient=createClient(ActionRunService,transport);
export const repositoryActivityClient=createClient(RepositoryActivityService,transport);
export const reviewerClient=createClient(ReviewerService,transport);
export const agentTaskClient=createClient(AgentTaskService,transport);
export const agentUsageClient = createClient(AgentUsageService, transport);
export const codexAccountClient = createClient(CodexAccountService, transport);
export const automationGrantClient = createClient(AutomationGrantService, transport);
export const accountSecurityClient = createClient(AccountSecurityService, transport);
export const profileClient = createClient(ProfileService, transport);
export const infrastructureConnectionClient = createClient(InfrastructureConnectionService, transport);
export const organizationCreationApi = createClient(OrganizationCreationService, transport);
export const executionPolicyApi = createClient(ExecutionPolicyService, transport);
export const workflowRunClient = createClient(WorkflowRunService, transport);
export const workflowArtifactClient = createClient(WorkflowArtifactService, transport);
export const workflowClient = createClient(WorkflowService, transport);
export const runnerPoolClient = createClient(RunnerPoolService, transport);
export const runnerControlClient = createClient(RunnerControlService, transport);
export const repositoryRulesClient = createClient(RepositoryRulesService, transport);
export const repositoryInvitationClient = createClient(RepositoryInvitationService, transport);
export const organizationExecutionValueClient = createClient(OrganizationExecutionValueService, transport);
export const repositoryExecutionValueClient = createClient(RepositoryExecutionValueService, transport);
export const emailNotificationClient = createClient(EmailNotificationService, transport);
export const repositoryEnvironmentClient = createClient(RepositoryEnvironmentService, transport);
export const repositoryLifecycleClient = createClient(RepositoryLifecycleService, transport);
export const repositoryWebhookClient = createClient(RepositoryWebhookService, transport);
export const repositoryDeployKeyClient = createClient(RepositoryDeployKeyService, transport);
export const repositoryTeamAccessClient = createClient(RepositoryTeamAccessService, transport);
export const repositoryAccessClient = createClient(RepositoryAccessService, transport);
export const instanceAdminClient = createClient(InstanceAdminService, transport);
export const organizationAdminClient = createClient(OrganizationAdminService, transport);
export const repositorySettingsClient = createClient(RepositorySettingsService, transport);
export const gitAccessClient = createClient(GitAccessService, transport);
export const sessionClient = createClient(SessionService, transport);
export const passwordRecoveryClient = createClient(PasswordRecoveryService, transport);
export const repositoryClient = createClient(RepositoryService, transport);
export const capabilityClient = createClient(CapabilityService, transport);
export const organizationClient = createClient(OrganizationService, transport);
export const auditClient = createClient(AuditService, transport);
export const apiCredentialClient = createClient(ApiCredentialService, transport);

export function errorMessage(error: Error) {
  return error instanceof ConnectError ? error.rawMessage : error.message;
}

// Never turn a forge-provided URL into an executable browser link.
export function repositoryLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export const repositoryFileMutationClient = createClient(RepositoryFileMutationService, transport);

export const passwordRecoveryEnrollmentClient = createClient(PasswordRecoveryEnrollmentService, transport);

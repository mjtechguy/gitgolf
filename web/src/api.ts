import { createClient, ConnectError } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { AccountSecurityService, ProfileService, InfrastructureConnectionService, OrganizationCreationService, ExecutionPolicyService, WorkflowRunService, WorkflowService, RepositoryAccessService, InstanceAdminService, OrganizationAdminService, RepositorySettingsService, GitAccessService, ApiCredentialService, AuditService, CapabilityService, OrganizationService, RepositoryService, SessionService } from './gen/golf/v1/golf_pb';

const transport = createConnectTransport({
  baseUrl: '/rpc',
  useBinaryFormat: false,
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin', cache: 'no-store' }),
});

export const accountSecurityClient = createClient(AccountSecurityService, transport);
export const profileClient = createClient(ProfileService, transport);
export const infrastructureConnectionClient = createClient(InfrastructureConnectionService, transport);
export const organizationCreationApi = createClient(OrganizationCreationService, transport);
export const executionPolicyApi = createClient(ExecutionPolicyService, transport);
export const workflowRunClient = createClient(WorkflowRunService, transport);
export const workflowClient = createClient(WorkflowService, transport);
export const repositoryAccessClient = createClient(RepositoryAccessService, transport);
export const instanceAdminClient = createClient(InstanceAdminService, transport);
export const organizationAdminClient = createClient(OrganizationAdminService, transport);
export const repositorySettingsClient = createClient(RepositorySettingsService, transport);
export const gitAccessClient = createClient(GitAccessService, transport);
export const sessionClient = createClient(SessionService, transport);
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

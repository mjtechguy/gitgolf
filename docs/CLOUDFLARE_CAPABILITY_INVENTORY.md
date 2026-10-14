# Cloudflare native capability inventory

Generated from every `api/golf/v1/*.proto` contract by `node cloudflare/forge/capabilities-check.mjs --write`. Every shared RPC is listed; an adapter is implementation evidence, not proof of complete portable behavior or hosted acceptance. Provider-only evidence/preview endpoints and ordinary Git transport are tested separately.

| Service | Adapted procedures | Remaining procedures | Boundary |
| --- | ---: | ---: | --- |
| AgentControlService | 0 | 3 | Native migration required; portable service remains available on its own setup path. |
| RepositoryFileBatchService | 0 | 2 | Native migration required; portable service remains available on its own setup path. |
| DiscussionAttachmentService | 0 | 2 | Native migration required; portable service remains available on its own setup path. |
| DiscussionAttachmentUploadService | 0 | 3 | Native migration required; portable service remains available on its own setup path. |
| SessionService | 2 | 8 | Access identity; local password, MFA, SSH and account lifecycle remain separate. |
| ApiCredentialService | 0 | 3 | Native migration required; portable service remains available on its own setup path. |
| GitAccessService | 0 | 3 | Native migration required; portable service remains available on its own setup path. |
| RepositorySettingsService | 3 | 0 | Description, website, topics and existing default branch; atomic current-authority and revision checks. Feature policy remains operator-managed. |
| RepositoryService | 41 | 6 | Bounded Git/read contract, immutable source pages and complete bounded filename/path indexes, overall reviews and same-repository PRs. Repository labels/milestones, issue/PR assignment and author/admin comment editing; no protected merge, inline review threads or organization labels. Pending overall drafts use PullReviewAuthoringService. |
| OrganizationService | 2 | 4 | One independently provisioned workspace; membership administration remains open. |
| OrganizationAdminService | 0 | 4 | Native migration required; portable service remains available on its own setup path. |
| InstanceAdminService | 0 | 9 | Native migration required; portable service remains available on its own setup path. |
| AuditService | 0 | 1 | Native migration required; portable service remains available on its own setup path. |
| OperationsService | 1 | 0 | Current Access-enrolled workspace ops administrators; inventories and maintenance journal. Fleet provider analytics/billing not collected. |
| CapabilityService | 1 | 0 | Explicit native contract. |
| RepositoryAccessService | 6 | 0 | Enrolled direct collaborator inventory/resolution and atomic version-fenced grants with original receipts. Teams and SSH deploy keys remain open. |
| WorkflowService | 1 | 0 | Read-only inventory of .github/workflows/*.yml and .gitlab-ci.yml at the default-branch commit for current repository accounts: at most 20 files of 64 KiB, classified against the native shell subset, with the one operator-approved path marked. No dispatch, editor or run history. |
| ExecutionPolicyService | 2 | 0 | Repository scope only: current administrators under a verified human Access sign-in turn pull-request runs and automatic push tests off or on with policy and authority revision checks; bearer and service-token callers can read but not change it. Enforced when a run is admitted; admitted runs are not revoked. No instance or organization ceilings, repository selection or workflow path lists. |
| WorkflowRunService | 0 | 7 | Native migration required; portable service remains available on its own setup path. |
| OrganizationCreationService | 0 | 3 | Native migration required; portable service remains available on its own setup path. |
| InfrastructureConnectionService | 0 | 8 | Native migration required; portable service remains available on its own setup path. |
| ProfileService | 2 | 0 | Own enrolled profile, revision-fenced updates. |
| AccountSecurityService | 0 | 8 | Native migration required; portable service remains available on its own setup path. |
| AutomationGrantService | 0 | 3 | Native migration required; portable service remains available on its own setup path. |
| CodexAccountService | 0 | 9 | Native migration required; portable service remains available on its own setup path. |
| AgentUsageService | 0 | 4 | Native migration required; portable service remains available on its own setup path. |
| AgentTaskService | 0 | 5 | Native migration required; portable service remains available on its own setup path. |
| ReviewerService | 0 | 4 | Native migration required; portable service remains available on its own setup path. |
| RepositoryActivityService | 1 | 0 | Bounded resumable Connect JSON/protobuf invalidations from the workspace SQLite journal; current authority before each frame. External Artifacts writes need native ingress. |
| ActionRunService | 0 | 2 | Native migration required; portable service remains available on its own setup path. |
| RepositoryDeployKeyService | 0 | 3 | Native migration required; portable service remains available on its own setup path. |
| RepositoryWebhookService | 5 | 0 | Encrypted subscriptions and signed durable deliveries to operator-approved HTTPS origins; current sponsor authority, bounded retries/daily attempts, tests and explicit redelivery. Native test-job events; repository email remains separate. |
| RepositoryTeamAccessService | 0 | 3 | Native migration required; portable service remains available on its own setup path. |
| RepositoryLifecycleService | 0 | 5 | Native migration required; portable service remains available on its own setup path. |
| EmailNotificationService | 6 | 6 | Own Access sign-in address only, through the Cloudflare Email Service binding: explicit account consent, per-repository subscriptions, provider acceptance history and explicit redelivery under current grant, identity and consent. Category-and-link messages, six attempts and a daily attempt budget. No SMTP transports, verification codes, unsubscribe links, bounce or reply handling; bearer and service-token callers are refused. |
| RepositoryExecutionValueService | 7 | 0 | Encrypted repository secrets and plain variables with exact-commit approvals of the one operator-approved Actions workflow; Access-verified administrators, version-fenced writes and original receipts. Released as environment variables only to approved Cloudflare-hosted pull-request jobs, with exact-match masking of stored output. No typed inputs, manual dispatch, organization values, environment scopes, secrets expressions, customer-runner or agent release. |
| RepositoryInvitationService | 7 | 0 | Enrolled Access users only; current issuer administration, expiring consent, atomic grant/decision and original receipt lookup. No email delivery or automatic enrollment. |
| RepositoryRulesService | 3 | 0 | Branch locks and tag account restrictions enforced on Golf Git; exact/prefix patterns, current admin, atomic receipts. No protected merge, review/check gates, teams or provider-side enforcement. |
| RunnerControlService | 0 | 5 | Native migration required; portable service remains available on its own setup path. |
| RunnerPoolService | 0 | 4 | Native migration required; portable service remains available on its own setup path. |
| GitTransportService | 4 | 1 | Own Access-authenticated account; repository-only, identity/grant-bound HTTPS read/write credentials, one-time secrets, 5–60 minute expiry and revocation. Separate Access gate; SSH and receive-outcome RPC remain unavailable. |
| OrganizationExecutionValueService | 0 | 5 | Native migration required; portable service remains available on its own setup path. |
| RepositoryEnvironmentService | 4 | 0 | One environment named preview, enforced on protected PR previews: head branches, lifetime under the operator ceiling and concurrent previews. Verified Access administrator, version-fenced saves and original receipts. No reviewers, wait timers, tag/commit selectors, environment secrets or deployment. |
| PullMergeObservationService | 1 | 0 | Exact current same-repository comparison, branch locks, retained source, current writer and base-ancestry observations. No executable merge authority; merge commits are reported only for a pull request the native merge slice would currently admit. |
| StandardPullMergeService | 2 | 0 | Same-repository merge commits when the base tip is already contained in the head: writer authority, rules, one journaled single-ref write and ref/commit readback; original receipts. Squash, diverged branches, forks and locked targets are durably refused; an unconfirmed write stays unknown and fences the repository. Provider acceptance of the generated pack needs hosted proof. |
| WorkflowArtifactService | 0 | 1 | Native migration required; portable service remains available on its own setup path. |
| RepositoryReleasePublicationService | 2 | 0 | One publication per existing tag by a current administrator while the repository has no tag rules; never creates or moves a tag. Atomic D1 release and original receipt. |
| RepositoryDeploymentService | 0 | 7 | Native migration required; portable service remains available on its own setup path. |
| RepositoryRefMutationService | 0 | 2 | Native migration required; portable service remains available on its own setup path. |
| RepositoryFileMutationService | 0 | 3 | Native migration required; portable service remains available on its own setup path. |
| DiscussionCollaborationService | 4 | 0 | Current-authority reactions, own subscriptions and in-app inbox; transaction-bound timeline since schema14. Historical activity is not backfilled. Issue templates and forms are read from the default-branch head with the portable limits; email remains separate. |
| RepositoryReleaseManagementService | 2 | 0 | Revision-fenced edits, removal and up to 25 assets of 256 KiB in private R2 under original receipts; an unacknowledged upload settles by readback and is never sent twice. Downloads stream only with current repository access. |
| PullReviewRequestService | 8 | 3 | Human account review assignments, cancellation and admin dismissal/restoration with original receipts. Current direct grants and exact-base GitHub-format CODEOWNERS suggestions; no team assignments, inline comments, automatic routing or protected approval authority. |
| RepositoryMirrorService | 0 | 3 | Native migration required; portable service remains available on its own setup path. |
| RepositoryWikiService | 0 | 2 | Native migration required; portable service remains available on its own setup path. |
| RepositoryWikiManagementService | 0 | 4 | Native migration required; portable service remains available on its own setup path. |
| ForgePackageService | 0 | 2 | Native migration required; portable service remains available on its own setup path. |
| OrganizationLabelService | 0 | 3 | Native migration required; portable service remains available on its own setup path. |
| PullReviewAuthoringService | 3 | 0 | Private pending overall summaries, exact-source update/publication and discard with original receipts. No saved inline draft transfer or comment edits. |
| ProviderImportService | 0 | 6 | Native migration required; portable service remains available on its own setup path. |
| PackagePublicationService | 0 | 4 | Native migration required; portable service remains available on its own setup path. |
| MirrorObservationService | 0 | 1 | Native migration required; portable service remains available on its own setup path. |
| PasswordRecoveryService | 0 | 2 | Native migration required; portable service remains available on its own setup path. |
| PasswordRecoveryEnrollmentService | 0 | 2 | Native migration required; portable service remains available on its own setup path. |

| Procedure | Contract | Native state |
| --- | --- | --- |
| AgentControlService/GetAgentControl | agent_control088.proto | Missing native adapter |
| AgentControlService/SubmitAgentCommand | agent_control088.proto | Missing native adapter |
| AgentControlService/ListWorkflowAgentChildren | agent_control088.proto | Missing native adapter |
| RepositoryFileBatchService/SubmitRepositoryFileBatch | forge089.proto | Missing native adapter |
| RepositoryFileBatchService/GetRepositoryFileBatchOperation | forge089.proto | Missing native adapter |
| DiscussionAttachmentService/ListDiscussionAttachments | forge089.proto | Missing native adapter |
| DiscussionAttachmentService/DownloadDiscussionAttachment | forge089.proto | Missing native adapter |
| DiscussionAttachmentUploadService/GetDiscussionAttachmentUploadState | forge089.proto | Missing native adapter |
| DiscussionAttachmentUploadService/SubmitDiscussionAttachmentUpload | forge089.proto | Missing native adapter |
| DiscussionAttachmentUploadService/GetDiscussionAttachmentUploadOperation | forge089.proto | Missing native adapter |
| SessionService/GetAuthenticationOptions | golf.proto | Bounded adapter |
| SessionService/BeginGiteaOAuth | golf.proto | Missing native adapter |
| SessionService/LoginWithPassword | golf.proto | Missing native adapter |
| SessionService/CompletePasswordMFA | golf.proto | Missing native adapter |
| SessionService/LoginWithGiteaToken | golf.proto | Missing native adapter |
| SessionService/GetSession | golf.proto | Bounded adapter |
| SessionService/ListSessions | golf.proto | Missing native adapter |
| SessionService/RevokeSession | golf.proto | Missing native adapter |
| SessionService/RevokeOtherSessions | golf.proto | Missing native adapter |
| SessionService/Logout | golf.proto | Missing native adapter |
| ApiCredentialService/CreateApiCredential | golf.proto | Missing native adapter |
| ApiCredentialService/ListApiCredentials | golf.proto | Missing native adapter |
| ApiCredentialService/RevokeApiCredential | golf.proto | Missing native adapter |
| GitAccessService/ListSSHKeys | golf.proto | Missing native adapter |
| GitAccessService/AddSSHKey | golf.proto | Missing native adapter |
| GitAccessService/DeleteSSHKey | golf.proto | Missing native adapter |
| RepositorySettingsService/GetRepositorySettings | golf.proto | Bounded adapter |
| RepositorySettingsService/UpdateRepositorySettings | golf.proto | Bounded adapter |
| RepositorySettingsService/UpdateRepositoryTopics | golf.proto | Bounded adapter |
| RepositoryService/ListRepositories | golf.proto | Bounded adapter |
| RepositoryService/CreateRepository | golf.proto | Bounded adapter |
| RepositoryService/GetRepositoryCreation | golf.proto | Bounded adapter |
| RepositoryService/GetRepository | golf.proto | Bounded adapter |
| RepositoryService/GetRepositoryOverview | golf.proto | Bounded adapter |
| RepositoryService/GetRepositoryStar | golf.proto | Bounded adapter |
| RepositoryService/SetRepositoryStar | golf.proto | Bounded adapter |
| RepositoryService/ListRepositoryReleases | golf.proto | Bounded adapter |
| RepositoryService/GetRepositoryRelease | golf.proto | Bounded adapter |
| RepositoryService/ListBranches | golf.proto | Bounded adapter |
| RepositoryService/ListTags | golf.proto | Bounded adapter |
| RepositoryService/ListCommits | golf.proto | Bounded adapter |
| RepositoryService/GetCommitDiff | golf.proto | Bounded adapter |
| RepositoryService/ListPullRequestCommits | golf.proto | Bounded adapter |
| RepositoryService/ListPullRequestChecks | golf.proto | Bounded adapter |
| RepositoryService/GetPullRequestDiff | golf.proto | Bounded adapter |
| RepositoryService/GetRepositoryComparison | golf.proto | Bounded adapter |
| RepositoryService/GetRepositoryImage | golf.proto | Bounded adapter |
| RepositoryService/ResolveRepositorySource | golf.proto | Bounded adapter |
| RepositoryService/GetContents | golf.proto | Bounded adapter |
| RepositoryService/GetRepositoryFileIndex | golf.proto | Bounded adapter |
| RepositoryService/ListIssues | golf.proto | Bounded adapter |
| RepositoryService/GetPullRequestDiscussion | golf.proto | Bounded adapter |
| RepositoryService/GetIssue | golf.proto | Bounded adapter |
| RepositoryService/ListRepositoryLabels | golf.proto | Bounded adapter |
| RepositoryService/ListRepositoryAssignees | golf.proto | Bounded adapter |
| RepositoryService/ListRepositoryMilestones | golf.proto | Bounded adapter |
| RepositoryService/ListIssueComments | golf.proto | Bounded adapter |
| RepositoryService/CreateIssue | golf.proto | Bounded adapter |
| RepositoryService/CreateIssueComment | golf.proto | Bounded adapter |
| RepositoryService/UpdateIssue | golf.proto | Bounded adapter |
| RepositoryService/CreatePullRequest | golf.proto | Bounded adapter |
| RepositoryService/UpdatePullRequest | golf.proto | Bounded adapter |
| RepositoryService/GetIssueMutation | golf.proto | Bounded adapter |
| RepositoryService/SubmitDiscussionResourceOperation | golf.proto | Bounded adapter |
| RepositoryService/GetDiscussionResourceOperation | golf.proto | Bounded adapter |
| RepositoryService/ListPullRequests | golf.proto | Bounded adapter |
| RepositoryService/GetPullRequest | golf.proto | Bounded adapter |
| RepositoryService/ListPullRequestReviews | golf.proto | Bounded adapter |
| RepositoryService/GetPullRequestReviewComments | golf.proto | Missing native adapter |
| RepositoryService/GetPullRequestReviewDraft | golf.proto | Missing native adapter |
| RepositoryService/SavePullRequestReviewDraft | golf.proto | Missing native adapter |
| RepositoryService/DeletePullRequestReviewDraft | golf.proto | Missing native adapter |
| RepositoryService/PublishPullRequestReviewDraft | golf.proto | Missing native adapter |
| RepositoryService/GetPullRequestInlineReviewMutation | golf.proto | Missing native adapter |
| RepositoryService/CreatePullRequestReview | golf.proto | Bounded adapter |
| RepositoryService/GetPullRequestReviewMutation | golf.proto | Bounded adapter |
| OrganizationService/ListOrganizations | golf.proto | Bounded adapter |
| OrganizationService/GetOrganization | golf.proto | Bounded adapter |
| OrganizationService/ListTeams | golf.proto | Missing native adapter |
| OrganizationService/GetTeam | golf.proto | Missing native adapter |
| OrganizationService/ListTeamMembers | golf.proto | Missing native adapter |
| OrganizationService/ListTeamRepositories | golf.proto | Missing native adapter |
| OrganizationAdminService/GetTeamAdministration | golf.proto | Missing native adapter |
| OrganizationAdminService/ResolveTeamMember | golf.proto | Missing native adapter |
| OrganizationAdminService/AddTeamMember | golf.proto | Missing native adapter |
| OrganizationAdminService/RemoveTeamMember | golf.proto | Missing native adapter |
| InstanceAdminService/EnrollRegularLocalAccount | golf.proto | Missing native adapter |
| InstanceAdminService/ResetRegularLocalPassword | golf.proto | Missing native adapter |
| InstanceAdminService/ResetRegularLocalMFA | golf.proto | Missing native adapter |
| InstanceAdminService/EnableRegularLocalAccount | golf.proto | Missing native adapter |
| InstanceAdminService/DisableLocalAccount | golf.proto | Missing native adapter |
| InstanceAdminService/ListLocalAccounts | golf.proto | Missing native adapter |
| InstanceAdminService/ListGolfUserAccess | golf.proto | Missing native adapter |
| InstanceAdminService/ChangeGolfUserAccess | golf.proto | Missing native adapter |
| InstanceAdminService/GetGolfUserAccessOperation | golf.proto | Missing native adapter |
| AuditService/ListAuditEvents | golf.proto | Missing native adapter |
| OperationsService/GetOperationsDashboard | golf.proto | Bounded adapter |
| CapabilityService/ListCapabilities | golf.proto | Bounded adapter |
| RepositoryAccessService/GetRepositoryAccess | golf.proto | Bounded adapter |
| RepositoryAccessService/ListRepositoryCollaborators | golf.proto | Bounded adapter |
| RepositoryAccessService/ResolveRepositoryCollaborator | golf.proto | Bounded adapter |
| RepositoryAccessService/SetRepositoryCollaborator | golf.proto | Bounded adapter |
| RepositoryAccessService/RemoveRepositoryCollaborator | golf.proto | Bounded adapter |
| RepositoryAccessService/GetRepositoryAccessOperation | golf.proto | Bounded adapter |
| WorkflowService/InspectWorkflows | golf.proto | Bounded adapter |
| ExecutionPolicyService/GetExecutionPolicy | golf.proto | Bounded adapter |
| ExecutionPolicyService/UpdateExecutionPolicy | golf.proto | Bounded adapter |
| WorkflowRunService/PrepareWorkflowDispatch | golf.proto | Missing native adapter |
| WorkflowRunService/DispatchWorkflow | golf.proto | Missing native adapter |
| WorkflowRunService/GetWorkflowRun | golf.proto | Missing native adapter |
| WorkflowRunService/GetWorkflowDispatch | golf.proto | Missing native adapter |
| WorkflowRunService/ListWorkflowRuns | golf.proto | Missing native adapter |
| WorkflowRunService/CancelWorkflowRun | golf.proto | Missing native adapter |
| WorkflowRunService/GetWorkflowRunLogs | golf.proto | Missing native adapter |
| OrganizationCreationService/GetOrganizationCreationPolicy | golf.proto | Missing native adapter |
| OrganizationCreationService/UpdateOrganizationCreationPolicy | golf.proto | Missing native adapter |
| OrganizationCreationService/CreateOrganization | golf.proto | Missing native adapter |
| InfrastructureConnectionService/ListInfrastructureConnections | golf.proto | Missing native adapter |
| InfrastructureConnectionService/SaveInfrastructureConnection | golf.proto | Missing native adapter |
| InfrastructureConnectionService/TestInfrastructureConnection | golf.proto | Missing native adapter |
| InfrastructureConnectionService/ActivateInfrastructureConnection | golf.proto | Missing native adapter |
| InfrastructureConnectionService/ProvisionCloudflareEnvironmentResources | golf.proto | Missing native adapter |
| InfrastructureConnectionService/GetCloudflareEnvironmentResources | golf.proto | Missing native adapter |
| InfrastructureConnectionService/ListCloudflareEnvironmentResources | golf.proto | Missing native adapter |
| InfrastructureConnectionService/RemoveCloudflareEnvironmentResources | golf.proto | Missing native adapter |
| ProfileService/GetProfile | golf.proto | Bounded adapter |
| ProfileService/UpdateProfile | golf.proto | Bounded adapter |
| AccountSecurityService/GetAccountSecurity | golf.proto | Missing native adapter |
| AccountSecurityService/ChangeOwnPassword | golf.proto | Missing native adapter |
| AccountSecurityService/ChangeOwnLoginEmail | golf.proto | Missing native adapter |
| AccountSecurityService/GetOwnMFA | golf.proto | Missing native adapter |
| AccountSecurityService/BeginOwnMFA | golf.proto | Missing native adapter |
| AccountSecurityService/ConfirmOwnMFA | golf.proto | Missing native adapter |
| AccountSecurityService/DisableOwnMFA | golf.proto | Missing native adapter |
| AccountSecurityService/RegenerateOwnMFARecovery | golf.proto | Missing native adapter |
| AutomationGrantService/ListAutomationGrants | golf.proto | Missing native adapter |
| AutomationGrantService/CreateAutomationGrant | golf.proto | Missing native adapter |
| AutomationGrantService/RevokeAutomationGrant | golf.proto | Missing native adapter |
| CodexAccountService/ListCodexConnections | golf.proto | Missing native adapter |
| CodexAccountService/CreateCodexConnection | golf.proto | Missing native adapter |
| CodexAccountService/SetCodexConnectionAccess | golf.proto | Missing native adapter |
| CodexAccountService/GetCodexConnection | golf.proto | Missing native adapter |
| CodexAccountService/StartCodexLogin | golf.proto | Missing native adapter |
| CodexAccountService/CompleteAgentLogin | golf.proto | Missing native adapter |
| CodexAccountService/CancelCodexLogin | golf.proto | Missing native adapter |
| CodexAccountService/RefreshCodexConnection | golf.proto | Missing native adapter |
| CodexAccountService/DisconnectCodexConnection | golf.proto | Missing native adapter |
| AgentUsageService/GetAgentUsage | golf.proto | Missing native adapter |
| AgentUsageService/SaveAgentUsage | golf.proto | Missing native adapter |
| AgentUsageService/ListAgentModels | golf.proto | Missing native adapter |
| AgentUsageService/PreviewAgentTask | golf.proto | Missing native adapter |
| AgentTaskService/CreateAgentTask | golf.proto | Missing native adapter |
| AgentTaskService/ListAgentTasks | golf.proto | Missing native adapter |
| AgentTaskService/GetAgentTask | golf.proto | Missing native adapter |
| AgentTaskService/CancelAgentTask | golf.proto | Missing native adapter |
| AgentTaskService/ListAgentTaskEvents | golf.proto | Missing native adapter |
| ReviewerService/GetReviewer | golf.proto | Missing native adapter |
| ReviewerService/SaveReviewer | golf.proto | Missing native adapter |
| ReviewerService/ListReviewerRuns | golf.proto | Missing native adapter |
| ReviewerService/RequestReview | golf.proto | Missing native adapter |
| RepositoryActivityService/WatchRepository | golf.proto | Bounded adapter |
| ActionRunService/ListActionRuns | golf.proto | Missing native adapter |
| ActionRunService/GetActionRun | golf.proto | Missing native adapter |
| RepositoryDeployKeyService/ListRepositoryDeployKeys | golf.proto | Missing native adapter |
| RepositoryDeployKeyService/AddRepositoryDeployKey | golf.proto | Missing native adapter |
| RepositoryDeployKeyService/DeleteRepositoryDeployKey | golf.proto | Missing native adapter |
| RepositoryWebhookService/ListRepositoryWebhooks | golf.proto | Bounded adapter |
| RepositoryWebhookService/SaveRepositoryWebhook | golf.proto | Bounded adapter |
| RepositoryWebhookService/ListRepositoryWebhookDeliveries | golf.proto | Bounded adapter |
| RepositoryWebhookService/TestRepositoryWebhook | golf.proto | Bounded adapter |
| RepositoryWebhookService/RedeliverRepositoryWebhook | golf.proto | Bounded adapter |
| RepositoryTeamAccessService/ListRepositoryTeamAccess | golf.proto | Missing native adapter |
| RepositoryTeamAccessService/AttachRepositoryTeam | golf.proto | Missing native adapter |
| RepositoryTeamAccessService/DetachRepositoryTeam | golf.proto | Missing native adapter |
| RepositoryLifecycleService/GetRepositoryLifecycle | golf.proto | Missing native adapter |
| RepositoryLifecycleService/ChangeRepositoryArchiveState | golf.proto | Missing native adapter |
| RepositoryLifecycleService/GetRepositoryLifecycleOperation | golf.proto | Missing native adapter |
| RepositoryLifecycleService/DeleteRepository | golf.proto | Missing native adapter |
| RepositoryLifecycleService/GetRepositoryDeletionOperation | golf.proto | Missing native adapter |
| EmailNotificationService/ListEmailTransports | golf.proto | Missing native adapter |
| EmailNotificationService/SaveEmailTransport | golf.proto | Missing native adapter |
| EmailNotificationService/ActivateEmailTransport | golf.proto | Missing native adapter |
| EmailNotificationService/DeactivateEmailTransport | golf.proto | Missing native adapter |
| EmailNotificationService/GetOwnEmailNotifications | golf.proto | Bounded adapter |
| EmailNotificationService/RequestEmailVerification | golf.proto | Missing native adapter |
| EmailNotificationService/ConfirmEmailVerification | golf.proto | Missing native adapter |
| EmailNotificationService/SaveOwnEmailPreference | golf.proto | Bounded adapter |
| EmailNotificationService/GetRepositoryEmailSubscription | golf.proto | Bounded adapter |
| EmailNotificationService/SaveRepositoryEmailSubscription | golf.proto | Bounded adapter |
| EmailNotificationService/ListOwnEmailDeliveries | golf.proto | Bounded adapter |
| EmailNotificationService/RedeliverOwnEmail | golf.proto | Bounded adapter |
| RepositoryExecutionValueService/ListRepositoryExecutionValues | golf.proto | Bounded adapter |
| RepositoryExecutionValueService/SaveRepositoryExecutionValue | golf.proto | Bounded adapter |
| RepositoryExecutionValueService/DeleteRepositoryExecutionValue | golf.proto | Bounded adapter |
| RepositoryExecutionValueService/GetRepositoryExecutionVariable | golf.proto | Bounded adapter |
| RepositoryExecutionValueService/SaveRepositoryExecutionBinding | golf.proto | Bounded adapter |
| RepositoryExecutionValueService/DeleteRepositoryExecutionBinding | golf.proto | Bounded adapter |
| RepositoryExecutionValueService/GetRepositoryExecutionValueOperation | golf.proto | Bounded adapter |
| RepositoryInvitationService/PreviewRepositoryInvitationRecipient | golf.proto | Bounded adapter |
| RepositoryInvitationService/CreateRepositoryInvitation | golf.proto | Bounded adapter |
| RepositoryInvitationService/ListRepositoryInvitations | golf.proto | Bounded adapter |
| RepositoryInvitationService/ListOwnRepositoryInvitations | golf.proto | Bounded adapter |
| RepositoryInvitationService/RespondRepositoryInvitation | golf.proto | Bounded adapter |
| RepositoryInvitationService/RevokeRepositoryInvitation | golf.proto | Bounded adapter |
| RepositoryInvitationService/GetRepositoryInvitationOperation | golf.proto | Bounded adapter |
| RepositoryRulesService/GetRepositoryRules | golf.proto | Bounded adapter |
| RepositoryRulesService/MutateRepositoryRules | golf.proto | Bounded adapter |
| RepositoryRulesService/GetRepositoryRuleMutation | golf.proto | Bounded adapter |
| RunnerControlService/GetInstanceRunners | golf.proto | Missing native adapter |
| RunnerControlService/UpdateRunnerControl | golf.proto | Missing native adapter |
| RunnerControlService/GetRepositoryRunners | golf.proto | Missing native adapter |
| RunnerControlService/GetInstanceRunnerLimits | golf.proto | Missing native adapter |
| RunnerControlService/SetInstanceRunnerLimits | golf.proto | Missing native adapter |
| RunnerPoolService/ListRunnerPools | golf.proto | Missing native adapter |
| RunnerPoolService/SaveRunnerPool | golf.proto | Missing native adapter |
| RunnerPoolService/GetRepositoryRunnerPlacement | golf.proto | Missing native adapter |
| RunnerPoolService/SetRepositoryRunnerPlacement | golf.proto | Missing native adapter |
| GitTransportService/GetGitTransport | golf.proto | Bounded adapter |
| GitTransportService/CreateGitCredential | golf.proto | Bounded adapter |
| GitTransportService/ListGitCredentials | golf.proto | Bounded adapter |
| GitTransportService/RevokeGitCredential | golf.proto | Bounded adapter |
| GitTransportService/GetGitReceiveOutcome | golf.proto | Missing native adapter |
| OrganizationExecutionValueService/ListOrganizationExecutionValues | golf.proto | Missing native adapter |
| OrganizationExecutionValueService/SaveOrganizationExecutionValue | golf.proto | Missing native adapter |
| OrganizationExecutionValueService/DeleteOrganizationExecutionValue | golf.proto | Missing native adapter |
| OrganizationExecutionValueService/GetOrganizationExecutionVariable | golf.proto | Missing native adapter |
| OrganizationExecutionValueService/GetOrganizationExecutionValueOperation | golf.proto | Missing native adapter |
| RepositoryEnvironmentService/ListRepositoryEnvironments | golf.proto | Bounded adapter |
| RepositoryEnvironmentService/SaveRepositoryEnvironment | golf.proto | Bounded adapter |
| RepositoryEnvironmentService/DeleteRepositoryEnvironment | golf.proto | Bounded adapter |
| RepositoryEnvironmentService/GetRepositoryEnvironmentOperation | golf.proto | Bounded adapter |
| PullMergeObservationService/GetPullRequestMergeObservation | golf.proto | Bounded adapter |
| StandardPullMergeService/SubmitStandardPullMerge | golf.proto | Bounded adapter |
| StandardPullMergeService/GetStandardPullMergeOperation | golf.proto | Bounded adapter |
| WorkflowArtifactService/GetWorkflowArtifact | golf.proto | Missing native adapter |
| RepositoryReleasePublicationService/SubmitRepositoryReleasePublication | golf.proto | Bounded adapter |
| RepositoryReleasePublicationService/GetRepositoryReleasePublicationOperation | golf.proto | Bounded adapter |
| RepositoryDeploymentService/PrepareStaticDeployment | golf.proto | Missing native adapter |
| RepositoryDeploymentService/CreateRepositoryDeployment | golf.proto | Missing native adapter |
| RepositoryDeploymentService/GetRepositoryDeployment | golf.proto | Missing native adapter |
| RepositoryDeploymentService/ListRepositoryDeployments | golf.proto | Missing native adapter |
| RepositoryDeploymentService/ReviewRepositoryDeployment | golf.proto | Missing native adapter |
| RepositoryDeploymentService/ActivateRepositoryDeployment | golf.proto | Missing native adapter |
| RepositoryDeploymentService/RevokeRepositoryDeployment | golf.proto | Missing native adapter |
| RepositoryRefMutationService/SubmitRepositoryRefMutation | golf.proto | Missing native adapter |
| RepositoryRefMutationService/GetRepositoryRefMutationOperation | golf.proto | Missing native adapter |
| RepositoryFileMutationService/GetRepositoryFileMutationAccess | golf.proto | Missing native adapter |
| RepositoryFileMutationService/SubmitRepositoryFileMutation | golf.proto | Missing native adapter |
| RepositoryFileMutationService/GetRepositoryFileMutationOperation | golf.proto | Missing native adapter |
| DiscussionCollaborationService/GetDiscussionEngagement | golf.proto | Bounded adapter |
| DiscussionCollaborationService/ListDiscussionTimeline | golf.proto | Bounded adapter |
| DiscussionCollaborationService/ListOwnForgeNotifications | golf.proto | Bounded adapter |
| DiscussionCollaborationService/ListIssueTemplates | golf.proto | Bounded adapter |
| RepositoryReleaseManagementService/SubmitRepositoryReleaseOperation | golf.proto | Bounded adapter |
| RepositoryReleaseManagementService/GetRepositoryReleaseOperation | golf.proto | Bounded adapter |
| PullReviewRequestService/GetPullReviewLifecycleState | golf.proto | Bounded adapter |
| PullReviewRequestService/SubmitPullReviewLifecycle | golf.proto | Bounded adapter |
| PullReviewRequestService/GetPullReviewLifecycleOperation | golf.proto | Bounded adapter |
| PullReviewRequestService/GetPullCodeOwners | golf.proto | Bounded adapter |
| PullReviewRequestService/GetPullReviewCommentState | golf.proto | Missing native adapter |
| PullReviewRequestService/SubmitPullReviewCommentInteraction | golf.proto | Missing native adapter |
| PullReviewRequestService/GetPullReviewCommentOperation | golf.proto | Missing native adapter |
| PullReviewRequestService/GetPullReviewRequests | golf.proto | Bounded adapter |
| PullReviewRequestService/GetPullReviewTeamCandidates | golf.proto | Bounded adapter |
| PullReviewRequestService/SubmitPullReviewRequest | golf.proto | Bounded adapter |
| PullReviewRequestService/GetPullReviewRequestOperation | golf.proto | Bounded adapter |
| RepositoryMirrorService/GetRepositoryMirrorStatus | golf.proto | Missing native adapter |
| RepositoryMirrorService/SubmitRepositoryMirrorOperation | golf.proto | Missing native adapter |
| RepositoryMirrorService/GetRepositoryMirrorOperation | golf.proto | Missing native adapter |
| RepositoryWikiService/ListRepositoryWikiPages | golf.proto | Missing native adapter |
| RepositoryWikiService/GetRepositoryWikiPage | golf.proto | Missing native adapter |
| RepositoryWikiManagementService/GetRepositoryWikiWriteContext | golf.proto | Missing native adapter |
| RepositoryWikiManagementService/SubmitRepositoryWikiOperation | golf.proto | Missing native adapter |
| RepositoryWikiManagementService/GetRepositoryWikiOperation | golf.proto | Missing native adapter |
| RepositoryWikiManagementService/ListRepositoryWikiRevisions | golf.proto | Missing native adapter |
| ForgePackageService/ListRepositoryPackages | golf.proto | Missing native adapter |
| ForgePackageService/GetRepositoryPackageFiles | golf.proto | Missing native adapter |
| OrganizationLabelService/ListOrganizationLabels | golf.proto | Missing native adapter |
| OrganizationLabelService/SubmitOrganizationLabelOperation | golf.proto | Missing native adapter |
| OrganizationLabelService/GetOrganizationLabelOperation | golf.proto | Missing native adapter |
| PullReviewAuthoringService/GetPullReviewAuthoringState | golf.proto | Bounded adapter |
| PullReviewAuthoringService/SubmitPullReviewAuthoringOperation | golf.proto | Bounded adapter |
| PullReviewAuthoringService/GetPullReviewAuthoringOperation | golf.proto | Bounded adapter |
| ProviderImportService/ListProviderConnections | golf.proto | Missing native adapter |
| ProviderImportService/CreateProviderConnection | golf.proto | Missing native adapter |
| ProviderImportService/UpdateProviderConnection | golf.proto | Missing native adapter |
| ProviderImportService/PreviewProviderImport | golf.proto | Missing native adapter |
| ProviderImportService/SubmitProviderImport | golf.proto | Missing native adapter |
| ProviderImportService/GetProviderImport | golf.proto | Missing native adapter |
| PackagePublicationService/GetPackagePublicationAccess | golf.proto | Missing native adapter |
| PackagePublicationService/SubmitPackagePublication | golf.proto | Missing native adapter |
| PackagePublicationService/GetPackagePublication | golf.proto | Missing native adapter |
| PackagePublicationService/DownloadGenericPackageFile | golf.proto | Missing native adapter |
| MirrorObservationService/GetMirrorSyncObservation | golf.proto | Missing native adapter |
| PasswordRecoveryService/RequestPasswordRecovery | password_recovery090.proto | Missing native adapter |
| PasswordRecoveryService/CompletePasswordRecovery | password_recovery090.proto | Missing native adapter |
| PasswordRecoveryEnrollmentService/GetOwnPasswordRecoveryEnrollment | password_recovery_enrollment090.proto | Missing native adapter |
| PasswordRecoveryEnrollmentService/SaveOwnPasswordRecoveryEnrollment | password_recovery_enrollment090.proto | Missing native adapter |

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

type sessionTokenKey struct{}

func rpcToken(ctx context.Context) (forgeCredential, error) {
	token, _ := ctx.Value(sessionTokenKey{}).(forgeCredential)
	if token.Token == "" {
		return forgeCredential{}, rpcError(errUnauthenticated)
	}
	return token, nil
}
func (s *Server) cookieValue(header http.Header) string {
	name := cookieName
	if !s.config.AllowInsecureCookies {
		name = "__Host-golf_session"
	}
	value, count := "", 0
	for _, cookie := range (&http.Request{Header: header}).Cookies() {
		if cookie.Name == name {
			value = cookie.Value
			count++
		}
	}
	if count != 1 {
		return ""
	}
	return value
}

func (s *Server) rpcHandler() http.Handler {
	options := []connect.HandlerOption{
		connect.WithReadMaxBytes(16 << 10), connect.WithSendMaxBytes(16 << 20), connect.WithRequireConnectProtocolHeader(),
		connect.WithConditionalHandlerOptions(func(spec connect.Spec) []connect.HandlerOption {
			switch spec.Procedure {
			case golfv1connect.RepositoryReleaseManagementServiceSubmitRepositoryReleaseOperationProcedure, golfv1connect.RepositoryFileMutationServiceSubmitRepositoryFileMutationProcedure:
				return []connect.HandlerOption{connect.WithReadMaxBytes(384 << 10)}
			case golfv1connect.RepositoryServiceSubmitDiscussionResourceOperationProcedure:
				return []connect.HandlerOption{connect.WithReadMaxBytes(1 << 20)}
			case golfv1connect.RepositoryReleasePublicationServiceSubmitRepositoryReleasePublicationProcedure, golfv1connect.RepositoryEnvironmentServiceSaveRepositoryEnvironmentProcedure, golfv1connect.OrganizationExecutionValueServiceSaveOrganizationExecutionValueProcedure, golfv1connect.RepositoryExecutionValueServiceSaveRepositoryExecutionValueProcedure, golfv1connect.RepositoryExecutionValueServiceSaveRepositoryExecutionBindingProcedure:
				// Eight-KiB values can double under JSON escaping; organization
				// requests also carry bounded selected-repository identities.
				// Typed binding approvals include escaped inputs and scoped value IDs.
				return []connect.HandlerOption{connect.WithReadMaxBytes(64 << 10)}
			case golfv1connect.RepositoryServiceSavePullRequestReviewDraftProcedure:
				return []connect.HandlerOption{connect.WithReadMaxBytes(2 << 20), connect.WithSendMaxBytes(6 << 20)}
			case golfv1connect.RepositoryServiceGetPullRequestReviewDraftProcedure:
				return []connect.HandlerOption{connect.WithSendMaxBytes(6 << 20)}
			}
			return nil
		}),
		connect.WithInterceptors(connect.UnaryInterceptorFunc(s.apiReadInterceptor)),
		connect.WithRecover(func(_ context.Context, _ connect.Spec, _ http.Header, value any) error {
			if value == http.ErrAbortHandler {
				panic(http.ErrAbortHandler)
			}
			return rpcError(errors.New("RPC panic"))
		}),
	}
	mux := http.NewServeMux()
	mux.Handle(golfv1connect.NewCodexAccountServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewAgentUsageServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewAgentTaskServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewReviewerServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewSessionServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewProfileServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewAccountSecurityServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewAutomationGrantServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewDiscussionCollaborationServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryActivityServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewOrganizationServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewOrganizationAdminServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewInstanceAdminServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryAccessServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryTeamAccessServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryDeployKeyServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryWebhookServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryLifecycleServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryEnvironmentServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewEmailNotificationServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryExecutionValueServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewOrganizationExecutionValueServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryInvitationServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryRulesServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewPullMergeObservationServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewStandardPullMergeServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryReleasePublicationServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryReleaseManagementServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryRefMutationServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryFileMutationServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositoryDeploymentServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRunnerControlServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRunnerPoolServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewWorkflowServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewExecutionPolicyServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewOrganizationCreationServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewInfrastructureConnectionServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewWorkflowRunServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewWorkflowArtifactServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewActionRunServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewCapabilityServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewAuditServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewApiCredentialServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewGitAccessServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewGitTransportServiceHandler(s, options...))
	mux.Handle(golfv1connect.NewRepositorySettingsServiceHandler(s, options...))
	return mux
}

// This HTTP boundary runs before Connect reads, decompresses or decodes a body.
// Only explicitly named public procedures skip opaque-session authentication.
func (s *Server) rpcBoundary(next http.Handler) http.Handler {
	writer := connect.NewErrorWriter(connect.WithRequireConnectProtocolHeader())
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fail := func(err error) { _ = writer.Write(w, r, err) }
		if r.Method != http.MethodPost {
			fail(connect.NewError(connect.CodeInvalidArgument, errors.New("RPC requests require POST.")))
			return
		}
		if r.Header.Get("Origin") != s.config.PublicURL || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			fail(connect.NewError(connect.CodePermissionDenied, errors.New("Request origin must match the configured Golf public URL.")))
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.EscapedPath() != r.URL.Path {
			fail(rpcError(invalid("RPC URLs do not accept query parameters or escaped procedure names.")))
			return
		}
		procedure := strings.TrimPrefix(r.URL.Path, "/rpc")
		apiHash, delegated, err := apiHeader(r.Header)
		if err != nil {
			fail(rpcError(err))
			return
		}
		if delegated {
			if !apiReadProcedure(procedure) && (apiWriteScope(procedure) == "" || !strings.HasPrefix(strings.Split(r.Header.Get("Authorization"), " ")[1], apiWriteTokenPrefix)) {
				fail(rpcError(errApiCredentialReadOnly))
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), apiAuthKey{}, apiAuth{hash: apiHash, procedure: procedure}))
		}
		public := false
		switch procedure {
		case golfv1connect.SessionServiceGetAuthenticationOptionsProcedure, golfv1connect.SessionServiceBeginGiteaOAuthProcedure, golfv1connect.SessionServiceLoginWithGiteaTokenProcedure, golfv1connect.SessionServiceLoginWithPasswordProcedure, golfv1connect.SessionServiceLogoutProcedure, golfv1connect.CapabilityServiceListCapabilitiesProcedure:
			public = true
		case golfv1connect.ReviewerServiceGetReviewerProcedure, golfv1connect.ReviewerServiceSaveReviewerProcedure, golfv1connect.ReviewerServiceListReviewerRunsProcedure, golfv1connect.ReviewerServiceRequestReviewProcedure, golfv1connect.AgentTaskServiceCreateAgentTaskProcedure, golfv1connect.AgentTaskServiceListAgentTasksProcedure, golfv1connect.AgentTaskServiceGetAgentTaskProcedure, golfv1connect.AgentTaskServiceCancelAgentTaskProcedure, golfv1connect.AgentTaskServiceListAgentTaskEventsProcedure, golfv1connect.AgentUsageServicePreviewAgentTaskProcedure, golfv1connect.AgentUsageServiceGetAgentUsageProcedure, golfv1connect.AgentUsageServiceSaveAgentUsageProcedure, golfv1connect.AgentUsageServiceListAgentModelsProcedure, golfv1connect.CodexAccountServiceCompleteAgentLoginProcedure, golfv1connect.CodexAccountServiceListCodexConnectionsProcedure, golfv1connect.CodexAccountServiceCreateCodexConnectionProcedure, golfv1connect.CodexAccountServiceSetCodexConnectionAccessProcedure, golfv1connect.CodexAccountServiceGetCodexConnectionProcedure, golfv1connect.CodexAccountServiceStartCodexLoginProcedure, golfv1connect.CodexAccountServiceCancelCodexLoginProcedure, golfv1connect.CodexAccountServiceRefreshCodexConnectionProcedure, golfv1connect.CodexAccountServiceDisconnectCodexConnectionProcedure,
			golfv1connect.AutomationGrantServiceListAutomationGrantsProcedure, golfv1connect.AutomationGrantServiceCreateAutomationGrantProcedure, golfv1connect.AutomationGrantServiceRevokeAutomationGrantProcedure,
			golfv1connect.AccountSecurityServiceGetAccountSecurityProcedure, golfv1connect.AccountSecurityServiceChangeOwnPasswordProcedure, golfv1connect.AccountSecurityServiceChangeOwnLoginEmailProcedure,
			golfv1connect.InstanceAdminServiceEnrollRegularLocalAccountProcedure, golfv1connect.InstanceAdminServiceResetRegularLocalPasswordProcedure, golfv1connect.InstanceAdminServiceEnableRegularLocalAccountProcedure,
			golfv1connect.ProfileServiceGetProfileProcedure, golfv1connect.ProfileServiceUpdateProfileProcedure,
			golfv1connect.InfrastructureConnectionServiceListInfrastructureConnectionsProcedure, golfv1connect.InfrastructureConnectionServiceSaveInfrastructureConnectionProcedure, golfv1connect.InfrastructureConnectionServiceTestInfrastructureConnectionProcedure, golfv1connect.InfrastructureConnectionServiceActivateInfrastructureConnectionProcedure,
			golfv1connect.OrganizationCreationServiceGetOrganizationCreationPolicyProcedure, golfv1connect.OrganizationCreationServiceUpdateOrganizationCreationPolicyProcedure, golfv1connect.OrganizationCreationServiceCreateOrganizationProcedure,
			golfv1connect.ExecutionPolicyServiceGetExecutionPolicyProcedure, golfv1connect.ExecutionPolicyServiceUpdateExecutionPolicyProcedure,
			golfv1connect.ActionRunServiceListActionRunsProcedure, golfv1connect.ActionRunServiceGetActionRunProcedure,
			golfv1connect.WorkflowArtifactServiceGetWorkflowArtifactProcedure, golfv1connect.WorkflowRunServicePrepareWorkflowDispatchProcedure, golfv1connect.WorkflowRunServiceDispatchWorkflowProcedure, golfv1connect.WorkflowRunServiceGetWorkflowRunProcedure, golfv1connect.WorkflowRunServiceGetWorkflowDispatchProcedure, golfv1connect.WorkflowRunServiceListWorkflowRunsProcedure, golfv1connect.WorkflowRunServiceCancelWorkflowRunProcedure, golfv1connect.WorkflowRunServiceGetWorkflowRunLogsProcedure,
			golfv1connect.InstanceAdminServiceDisableLocalAccountProcedure, golfv1connect.WorkflowServiceInspectWorkflowsProcedure,
			golfv1connect.RepositoryWebhookServiceListRepositoryWebhooksProcedure, golfv1connect.RepositoryWebhookServiceSaveRepositoryWebhookProcedure, golfv1connect.RepositoryWebhookServiceListRepositoryWebhookDeliveriesProcedure, golfv1connect.RepositoryWebhookServiceTestRepositoryWebhookProcedure, golfv1connect.RepositoryWebhookServiceRedeliverRepositoryWebhookProcedure,
			golfv1connect.StandardPullMergeServiceSubmitStandardPullMergeProcedure, golfv1connect.StandardPullMergeServiceGetStandardPullMergeOperationProcedure,
			golfv1connect.RepositoryDeploymentServicePrepareStaticDeploymentProcedure, golfv1connect.RepositoryDeploymentServiceCreateRepositoryDeploymentProcedure, golfv1connect.RepositoryDeploymentServiceGetRepositoryDeploymentProcedure, golfv1connect.RepositoryDeploymentServiceListRepositoryDeploymentsProcedure, golfv1connect.RepositoryDeploymentServiceReviewRepositoryDeploymentProcedure, golfv1connect.RepositoryDeploymentServiceActivateRepositoryDeploymentProcedure, golfv1connect.RepositoryDeploymentServiceRevokeRepositoryDeploymentProcedure,
			golfv1connect.RepositoryReleasePublicationServiceSubmitRepositoryReleasePublicationProcedure, golfv1connect.RepositoryReleasePublicationServiceGetRepositoryReleasePublicationOperationProcedure,
			golfv1connect.RepositoryReleaseManagementServiceSubmitRepositoryReleaseOperationProcedure, golfv1connect.RepositoryReleaseManagementServiceGetRepositoryReleaseOperationProcedure,
			golfv1connect.RepositoryRefMutationServiceSubmitRepositoryRefMutationProcedure, golfv1connect.RepositoryRefMutationServiceGetRepositoryRefMutationOperationProcedure,
			golfv1connect.RepositoryFileMutationServiceSubmitRepositoryFileMutationProcedure, golfv1connect.RepositoryFileMutationServiceGetRepositoryFileMutationOperationProcedure,
			golfv1connect.RepositoryServiceSubmitDiscussionResourceOperationProcedure, golfv1connect.RepositoryServiceGetDiscussionResourceOperationProcedure,
			golfv1connect.InstanceAdminServiceListGolfUserAccessProcedure, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, golfv1connect.InstanceAdminServiceGetGolfUserAccessOperationProcedure,
			golfv1connect.PullMergeObservationServiceGetPullRequestMergeObservationProcedure, golfv1connect.RepositoryRulesServiceGetRepositoryRulesProcedure, golfv1connect.RepositoryRulesServiceMutateRepositoryRulesProcedure, golfv1connect.RepositoryRulesServiceGetRepositoryRuleMutationProcedure,
			golfv1connect.RunnerControlServiceGetInstanceRunnerLimitsProcedure, golfv1connect.RunnerControlServiceSetInstanceRunnerLimitsProcedure, golfv1connect.RunnerControlServiceGetInstanceRunnersProcedure, golfv1connect.RunnerControlServiceUpdateRunnerControlProcedure, golfv1connect.RunnerControlServiceGetRepositoryRunnersProcedure,
			golfv1connect.RunnerPoolServiceListRunnerPoolsProcedure, golfv1connect.RunnerPoolServiceSaveRunnerPoolProcedure, golfv1connect.RunnerPoolServiceGetRepositoryRunnerPlacementProcedure, golfv1connect.RunnerPoolServiceSetRepositoryRunnerPlacementProcedure,
			golfv1connect.RepositoryInvitationServicePreviewRepositoryInvitationRecipientProcedure, golfv1connect.RepositoryInvitationServiceCreateRepositoryInvitationProcedure, golfv1connect.RepositoryInvitationServiceListRepositoryInvitationsProcedure, golfv1connect.RepositoryInvitationServiceListOwnRepositoryInvitationsProcedure, golfv1connect.RepositoryInvitationServiceRespondRepositoryInvitationProcedure, golfv1connect.RepositoryInvitationServiceRevokeRepositoryInvitationProcedure, golfv1connect.RepositoryInvitationServiceGetRepositoryInvitationOperationProcedure,
			golfv1connect.OrganizationExecutionValueServiceListOrganizationExecutionValuesProcedure, golfv1connect.OrganizationExecutionValueServiceSaveOrganizationExecutionValueProcedure, golfv1connect.OrganizationExecutionValueServiceDeleteOrganizationExecutionValueProcedure, golfv1connect.OrganizationExecutionValueServiceGetOrganizationExecutionVariableProcedure, golfv1connect.OrganizationExecutionValueServiceGetOrganizationExecutionValueOperationProcedure,
			golfv1connect.GitTransportServiceGetGitTransportProcedure, golfv1connect.GitTransportServiceCreateGitCredentialProcedure, golfv1connect.GitTransportServiceListGitCredentialsProcedure, golfv1connect.GitTransportServiceRevokeGitCredentialProcedure, golfv1connect.GitTransportServiceGetGitReceiveOutcomeProcedure,
			golfv1connect.RepositoryExecutionValueServiceListRepositoryExecutionValuesProcedure, golfv1connect.RepositoryExecutionValueServiceSaveRepositoryExecutionValueProcedure, golfv1connect.RepositoryExecutionValueServiceDeleteRepositoryExecutionValueProcedure, golfv1connect.RepositoryExecutionValueServiceGetRepositoryExecutionVariableProcedure, golfv1connect.RepositoryExecutionValueServiceSaveRepositoryExecutionBindingProcedure, golfv1connect.RepositoryExecutionValueServiceDeleteRepositoryExecutionBindingProcedure, golfv1connect.RepositoryExecutionValueServiceGetRepositoryExecutionValueOperationProcedure,
			golfv1connect.EmailNotificationServiceListEmailTransportsProcedure, golfv1connect.EmailNotificationServiceSaveEmailTransportProcedure, golfv1connect.EmailNotificationServiceActivateEmailTransportProcedure, golfv1connect.EmailNotificationServiceDeactivateEmailTransportProcedure, golfv1connect.EmailNotificationServiceGetOwnEmailNotificationsProcedure, golfv1connect.EmailNotificationServiceRequestEmailVerificationProcedure, golfv1connect.EmailNotificationServiceConfirmEmailVerificationProcedure, golfv1connect.EmailNotificationServiceSaveOwnEmailPreferenceProcedure, golfv1connect.EmailNotificationServiceGetRepositoryEmailSubscriptionProcedure, golfv1connect.EmailNotificationServiceSaveRepositoryEmailSubscriptionProcedure, golfv1connect.EmailNotificationServiceListOwnEmailDeliveriesProcedure, golfv1connect.EmailNotificationServiceRedeliverOwnEmailProcedure,
			golfv1connect.RepositoryLifecycleServiceGetRepositoryLifecycleProcedure, golfv1connect.RepositoryLifecycleServiceChangeRepositoryArchiveStateProcedure, golfv1connect.RepositoryLifecycleServiceGetRepositoryLifecycleOperationProcedure, golfv1connect.RepositoryLifecycleServiceDeleteRepositoryProcedure, golfv1connect.RepositoryLifecycleServiceGetRepositoryDeletionOperationProcedure,
			golfv1connect.RepositoryEnvironmentServiceListRepositoryEnvironmentsProcedure, golfv1connect.RepositoryEnvironmentServiceSaveRepositoryEnvironmentProcedure, golfv1connect.RepositoryEnvironmentServiceDeleteRepositoryEnvironmentProcedure, golfv1connect.RepositoryEnvironmentServiceGetRepositoryEnvironmentOperationProcedure,
			golfv1connect.RepositoryDeployKeyServiceListRepositoryDeployKeysProcedure, golfv1connect.RepositoryDeployKeyServiceAddRepositoryDeployKeyProcedure, golfv1connect.RepositoryDeployKeyServiceDeleteRepositoryDeployKeyProcedure,
			golfv1connect.RepositoryTeamAccessServiceListRepositoryTeamAccessProcedure, golfv1connect.RepositoryTeamAccessServiceAttachRepositoryTeamProcedure, golfv1connect.RepositoryTeamAccessServiceDetachRepositoryTeamProcedure,
			golfv1connect.RepositoryAccessServiceGetRepositoryAccessOperationProcedure, golfv1connect.RepositoryAccessServiceGetRepositoryAccessProcedure, golfv1connect.RepositoryAccessServiceListRepositoryCollaboratorsProcedure, golfv1connect.RepositoryAccessServiceResolveRepositoryCollaboratorProcedure, golfv1connect.RepositoryAccessServiceSetRepositoryCollaboratorProcedure, golfv1connect.RepositoryAccessServiceRemoveRepositoryCollaboratorProcedure,
			golfv1connect.InstanceAdminServiceListLocalAccountsProcedure, golfv1connect.OrganizationAdminServiceGetTeamAdministrationProcedure, golfv1connect.OrganizationAdminServiceResolveTeamMemberProcedure, golfv1connect.OrganizationAdminServiceAddTeamMemberProcedure, golfv1connect.OrganizationAdminServiceRemoveTeamMemberProcedure,
			golfv1connect.RepositorySettingsServiceGetRepositorySettingsProcedure, golfv1connect.RepositorySettingsServiceUpdateRepositorySettingsProcedure, golfv1connect.RepositorySettingsServiceUpdateRepositoryTopicsProcedure,
			golfv1connect.GitAccessServiceListSSHKeysProcedure, golfv1connect.GitAccessServiceAddSSHKeyProcedure, golfv1connect.GitAccessServiceDeleteSSHKeyProcedure,
			golfv1connect.AuditServiceListAuditEventsProcedure, golfv1connect.SessionServiceGetSessionProcedure,
			golfv1connect.ApiCredentialServiceCreateApiCredentialProcedure, golfv1connect.ApiCredentialServiceListApiCredentialsProcedure, golfv1connect.ApiCredentialServiceRevokeApiCredentialProcedure,
			golfv1connect.SessionServiceListSessionsProcedure, golfv1connect.SessionServiceRevokeSessionProcedure, golfv1connect.SessionServiceRevokeOtherSessionsProcedure,
			golfv1connect.RepositoryActivityServiceWatchRepositoryProcedure,
			golfv1connect.RepositoryServiceGetRepositoryStarProcedure, golfv1connect.RepositoryServiceSetRepositoryStarProcedure, golfv1connect.RepositoryServiceListRepositoryReleasesProcedure, golfv1connect.RepositoryServiceGetRepositoryReleaseProcedure, golfv1connect.RepositoryServiceListRepositoriesProcedure, golfv1connect.RepositoryServiceCreateRepositoryProcedure, golfv1connect.RepositoryServiceGetRepositoryCreationProcedure, golfv1connect.RepositoryServiceGetRepositoryProcedure, golfv1connect.RepositoryServiceGetRepositoryOverviewProcedure,
			golfv1connect.RepositoryServiceListBranchesProcedure, golfv1connect.RepositoryServiceListTagsProcedure, golfv1connect.RepositoryServiceListCommitsProcedure, golfv1connect.RepositoryServiceGetContentsProcedure, golfv1connect.RepositoryServiceResolveRepositorySourceProcedure,
			golfv1connect.RepositoryServiceGetCommitDiffProcedure, golfv1connect.RepositoryServiceGetPullRequestDiffProcedure, golfv1connect.RepositoryServiceGetRepositoryComparisonProcedure, golfv1connect.RepositoryServiceListPullRequestCommitsProcedure, golfv1connect.RepositoryServiceListPullRequestChecksProcedure, golfv1connect.RepositoryServiceGetRepositoryImageProcedure,
			golfv1connect.RepositoryServiceListIssuesProcedure, golfv1connect.RepositoryServiceGetIssueProcedure,
			golfv1connect.DiscussionCollaborationServiceGetDiscussionEngagementProcedure, golfv1connect.DiscussionCollaborationServiceListDiscussionTimelineProcedure,
			golfv1connect.RepositoryServiceGetPullRequestDiscussionProcedure, golfv1connect.RepositoryServiceListRepositoryLabelsProcedure, golfv1connect.RepositoryServiceListRepositoryAssigneesProcedure, golfv1connect.RepositoryServiceListRepositoryMilestonesProcedure, golfv1connect.RepositoryServiceListIssueCommentsProcedure, golfv1connect.RepositoryServiceGetIssueMutationProcedure, golfv1connect.RepositoryServiceCreateIssueProcedure, golfv1connect.RepositoryServiceCreateIssueCommentProcedure, golfv1connect.RepositoryServiceUpdateIssueProcedure, golfv1connect.RepositoryServiceCreatePullRequestProcedure, golfv1connect.RepositoryServiceUpdatePullRequestProcedure,
			golfv1connect.RepositoryServiceGetPullRequestReviewDraftProcedure, golfv1connect.RepositoryServiceSavePullRequestReviewDraftProcedure, golfv1connect.RepositoryServiceDeletePullRequestReviewDraftProcedure, golfv1connect.RepositoryServicePublishPullRequestReviewDraftProcedure, golfv1connect.RepositoryServiceGetPullRequestInlineReviewMutationProcedure,
			golfv1connect.RepositoryServiceListPullRequestsProcedure, golfv1connect.RepositoryServiceGetPullRequestProcedure, golfv1connect.RepositoryServiceListPullRequestReviewsProcedure, golfv1connect.RepositoryServiceGetPullRequestReviewCommentsProcedure, golfv1connect.RepositoryServiceCreatePullRequestReviewProcedure, golfv1connect.RepositoryServiceGetPullRequestReviewMutationProcedure,
			golfv1connect.OrganizationServiceListOrganizationsProcedure, golfv1connect.OrganizationServiceGetOrganizationProcedure,
			golfv1connect.OrganizationServiceListTeamsProcedure, golfv1connect.OrganizationServiceGetTeamProcedure,
			golfv1connect.OrganizationServiceListTeamMembersProcedure, golfv1connect.OrganizationServiceListTeamRepositoriesProcedure:
		default:
			fail(connect.NewError(connect.CodeNotFound, errors.New("RPC procedure not found.")))
			return
		}
		if !public {
			token, err := s.sessionCredential(r.Context(), s.cookieValue(r.Header))
			if err != nil {
				fail(rpcError(err))
				return
			}
			if delegated {
				if err := s.checkApiCaller(r.Context(), token); err != nil {
					fail(rpcError(err))
					return
				}
			}
			r = r.WithContext(context.WithValue(r.Context(), sessionTokenKey{}, token))
		}
		limit := int64(16 << 10)
		switch procedure {
		case golfv1connect.RepositoryReleaseManagementServiceSubmitRepositoryReleaseOperationProcedure, golfv1connect.RepositoryFileMutationServiceSubmitRepositoryFileMutationProcedure:
			limit = 384 << 10
		case golfv1connect.RepositoryServiceSubmitDiscussionResourceOperationProcedure:
			limit = 1 << 20
		case golfv1connect.RepositoryReleasePublicationServiceSubmitRepositoryReleasePublicationProcedure, golfv1connect.RepositoryEnvironmentServiceSaveRepositoryEnvironmentProcedure, golfv1connect.OrganizationExecutionValueServiceSaveOrganizationExecutionValueProcedure, golfv1connect.RepositoryExecutionValueServiceSaveRepositoryExecutionBindingProcedure:
			limit = 64 << 10
		case golfv1connect.RepositoryServiceSavePullRequestReviewDraftProcedure:
			limit = 2 << 20
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		next.ServeHTTP(w, r)
	})
}
func wireUser(user User) *golfv1.User {
	return &golfv1.User{Id: strconv.FormatInt(user.ID, 10), Login: user.Login, FullName: user.FullName, AvatarUrl: user.AvatarURL, IsInstanceAdmin: user.IsInstanceAdmin}
}
func wireRepository(repo Repository) *golfv1.Repository {
	updated := ""
	if !repo.UpdatedAt.IsZero() {
		updated = repo.UpdatedAt.Format(time.RFC3339Nano)
	}
	return &golfv1.Repository{Id: strconv.FormatInt(repo.ID, 10), Name: repo.Name, FullName: repo.FullName, Description: repo.Description, Private: repo.Private, HtmlUrl: repo.HTMLURL, DefaultBranch: repo.DefaultBranch, UpdatedAt: updated, Empty: repo.Empty, CloneUrl: repo.CloneURL, SshUrl: repo.SSHURL, IssuesEnabled: repo.IssuesEnabled, PullRequestsEnabled: repo.PullRequestsEnabled, WikiEnabled: repo.WikiEnabled}
}
func keyFrom(key *golfv1.RepositoryKey) repositoryKey {
	return repositoryKey{key.GetOwner(), key.GetName()}
}
func pageFrom(page *golfv1.PageRequest) pageRequest {
	return pageRequest{page.GetPage(), page.GetLimit()}
}
func wirePage(next uint32) *golfv1.PageResponse { return &golfv1.PageResponse{NextPage: next} }
func sourceType(value string) golfv1.SourceEntryType {
	switch value {
	case "dir":
		return golfv1.SourceEntryType_SOURCE_ENTRY_TYPE_DIRECTORY
	case "file":
		return golfv1.SourceEntryType_SOURCE_ENTRY_TYPE_FILE
	case "symlink":
		return golfv1.SourceEntryType_SOURCE_ENTRY_TYPE_SYMLINK
	case "submodule":
		return golfv1.SourceEntryType_SOURCE_ENTRY_TYPE_SUBMODULE
	default:
		return golfv1.SourceEntryType_SOURCE_ENTRY_TYPE_UNSPECIFIED
	}
}
func wireEntry(entry sourceEntry) *golfv1.SourceEntry {
	result := &golfv1.SourceEntry{Name: entry.Name, Path: entry.Path, Type: sourceType(entry.Type), Sha: entry.SHA, Size: uint64(entry.Size)}
	if row := entry.LatestChange; row != nil {
		result.LatestChange = &golfv1.Commit{Sha: row.SHA, Message: row.Commit.Message, AuthorName: row.Commit.Author.Name, AuthoredAt: row.Commit.Author.Date}
	}
	return result
}
func wireIssue(issue Issue) *golfv1.Issue {
	state := golfv1.IssueState_ISSUE_STATE_OPEN
	if issue.State == "closed" {
		state = golfv1.IssueState_ISSUE_STATE_CLOSED
	}
	metadata, _ := discussionMetadata(issue.forgeDiscussionMetadata)
	return &golfv1.Issue{Id: strconv.FormatInt(issue.ID, 10), Number: uint32(issue.Number), Title: issue.Title, Body: issue.Body, State: state, User: wireUser(issue.User), Comments: uint32(issue.Comments), CreatedAt: issue.CreatedAt, UpdatedAt: issue.UpdatedAt, HtmlUrl: issue.HTMLURL, Revision: issueRevision(issue), Metadata: metadata}
}
func (s *Server) LoginWithPassword(ctx context.Context, req *connect.Request[golfv1.LoginWithPasswordRequest]) (*connect.Response[golfv1.LoginWithPasswordResponse], error) {
	result, err := s.loginLocalSession(ctx, req.Msg.Username, req.Msg.Password, s.cookieValue(req.Header()))
	if err != nil {
		return nil, rpcError(err)
	}
	response := connect.NewResponse(&golfv1.LoginWithPasswordResponse{User: wireUser(result.User)})
	response.Header().Add("Set-Cookie", s.sessionCookie(result.Value, result.Expires, int(sessionLifetime.Seconds())).String())
	return response, nil
}
func (s *Server) LoginWithGiteaToken(ctx context.Context, req *connect.Request[golfv1.LoginWithGiteaTokenRequest]) (*connect.Response[golfv1.LoginWithGiteaTokenResponse], error) {
	result, err := s.loginSession(ctx, req.Msg.Token, s.cookieValue(req.Header()))
	if err != nil {
		return nil, rpcError(err)
	}
	response := connect.NewResponse(&golfv1.LoginWithGiteaTokenResponse{User: wireUser(result.User)})
	response.Header().Add("Set-Cookie", s.sessionCookie(result.Value, result.Expires, int(sessionLifetime.Seconds())).String())
	return response, nil
}
func (s *Server) GetSession(ctx context.Context, req *connect.Request[golfv1.GetSessionRequest]) (*connect.Response[golfv1.GetSessionResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	user, err := s.currentUser(ctx, token)
	if err != nil {
		return nil, rpcError(err)
	}
	user, err = s.localSessionUser(ctx, s.cookieValue(req.Header()), user)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetSessionResponse{User: wireUser(user)}), nil
}
func (s *Server) Logout(ctx context.Context, req *connect.Request[golfv1.LogoutRequest]) (*connect.Response[golfv1.LogoutResponse], error) {
	if err := s.logoutSession(ctx, s.cookieValue(req.Header())); err != nil {
		return nil, rpcError(err)
	}
	response := connect.NewResponse(&golfv1.LogoutResponse{})
	response.Header().Add("Set-Cookie", s.sessionCookie("", time.Unix(1, 0), -1).String())
	return response, nil
}
func (s *Server) ListSessions(ctx context.Context, req *connect.Request[golfv1.ListSessionsRequest]) (*connect.Response[golfv1.ListSessionsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listSessions(ctx, s.cookieValue(req.Header()), token, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListSessionsResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Sessions = append(response.Sessions, &golfv1.SessionInfo{Id: strconv.FormatInt(row.SessionID, 10),
			CreatedAt: row.CreatedAt.Format(time.RFC3339Nano), ExpiresAt: row.ExpiresAt.Format(time.RFC3339Nano),
			Current: row.IsCurrent, CredentialKind: row.CredentialKind})
	}
	return connect.NewResponse(response), nil
}
func (s *Server) RevokeSession(ctx context.Context, req *connect.Request[golfv1.RevokeSessionRequest]) (*connect.Response[golfv1.RevokeSessionResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	current, err := s.revokeSession(ctx, s.cookieValue(req.Header()), token, req.Msg.SessionId)
	if err != nil {
		return nil, rpcError(err)
	}
	response := connect.NewResponse(&golfv1.RevokeSessionResponse{CurrentSessionRevoked: current})
	if current {
		response.Header().Add("Set-Cookie", s.sessionCookie("", time.Unix(1, 0), -1).String())
	}
	return response, nil
}
func (s *Server) RevokeOtherSessions(ctx context.Context, req *connect.Request[golfv1.RevokeOtherSessionsRequest]) (*connect.Response[golfv1.RevokeOtherSessionsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	count, err := s.revokeOtherSessions(ctx, s.cookieValue(req.Header()), token)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.RevokeOtherSessionsResponse{RevokedCount: count}), nil
}
func (s *Server) ListRepositories(ctx context.Context, req *connect.Request[golfv1.ListRepositoriesRequest]) (*connect.Response[golfv1.ListRepositoriesResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listRepositories(ctx, token, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListRepositoriesResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Repositories = append(response.Repositories, s.wireGitRepository(row))
	}
	return connect.NewResponse(response), nil
}
func wireRepositoryCreation(record database.GolfRepositoryCreation) *golfv1.RepositoryCreation {
	state := golfv1.RepositoryCreationState_REPOSITORY_CREATION_STATE_OUTCOME_UNKNOWN
	switch record.State {
	case "SUCCEEDED":
		state = golfv1.RepositoryCreationState_REPOSITORY_CREATION_STATE_SUCCEEDED
	case "REJECTED":
		state = golfv1.RepositoryCreationState_REPOSITORY_CREATION_STATE_REJECTED
	}
	repositoryID := ""
	if record.RepositoryID.Valid {
		repositoryID = strconv.FormatInt(record.RepositoryID.Int64, 10)
	}
	return &golfv1.RepositoryCreation{Id: strconv.FormatInt(record.ID, 10), IdempotencyKey: record.IdempotencyKey,
		State: state, RequestedName: record.RequestedName, Private: record.Private, CreatedAt: record.CreatedAt.Format(time.RFC3339Nano),
		UpdatedAt: record.UpdatedAt.Format(time.RFC3339Nano), RepositoryId: repositoryID, FailureCode: record.FailureCode}
}
func (s *Server) CreateRepository(ctx context.Context, req *connect.Request[golfv1.CreateRepositoryRequest]) (*connect.Response[golfv1.CreateRepositoryResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	creation, repo, err := s.createRepository(ctx, s.cookieValue(req.Header()), token, req.Msg.Name, req.Msg.Description, req.Msg.Private, req.Msg.IdempotencyKey)
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.CreateRepositoryResponse{Creation: wireRepositoryCreation(creation)}
	if repo != nil {
		response.Repository = s.wireGitRepository(*repo)
	}
	return connect.NewResponse(response), nil
}
func (s *Server) GetRepositoryCreation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryCreationRequest]) (*connect.Response[golfv1.GetRepositoryCreationResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	creation, repo, err := s.getRepositoryCreation(ctx, s.cookieValue(req.Header()), token, req.Msg.IdempotencyKey)
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.GetRepositoryCreationResponse{Creation: wireRepositoryCreation(creation)}
	if repo != nil {
		response.Repository = s.wireGitRepository(*repo)
	}
	return connect.NewResponse(response), nil
}
func (s *Server) GetRepository(ctx context.Context, req *connect.Request[golfv1.GetRepositoryRequest]) (*connect.Response[golfv1.GetRepositoryResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	repo, err := s.getRepository(ctx, token, keyFrom(req.Msg.Repository))
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetRepositoryResponse{Repository: s.wireGitRepository(repo)}), nil
}
func (s *Server) ListBranches(ctx context.Context, req *connect.Request[golfv1.ListBranchesRequest]) (*connect.Response[golfv1.ListBranchesResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	var rows []branch
	var next uint32
	var total int64 = -1
	if req.Msg.RepositoryId != "" {
		var id int64
		id, err = discussionID(req.Msg.RepositoryId)
		if err == nil {
			rows, next, total, err = s.listBoundBranches(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), id, pageFrom(req.Msg.Page))
		}
	} else {
		rows, next, err = s.listBranches(ctx, token, keyFrom(req.Msg.Repository), pageFrom(req.Msg.Page))
	}
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListBranchesResponse{Page: wirePage(next), RepositoryId: req.Msg.RepositoryId}
	if total >= 0 {
		value := strconv.FormatInt(total, 10)
		response.TotalCount = &value
	}
	for _, row := range rows {
		response.Branches = append(response.Branches, &golfv1.Branch{Name: row.Name, CommitId: row.CommitID, Protected: row.Protected})
	}
	return connect.NewResponse(response), nil
}
func (s *Server) ListTags(ctx context.Context, req *connect.Request[golfv1.ListTagsRequest]) (*connect.Response[golfv1.ListTagsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	id, err := discussionID(req.Msg.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	rows, next, total, err := s.listTags(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), id, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	count := strconv.FormatInt(total, 10)
	response := &golfv1.ListTagsResponse{Page: wirePage(next), TotalCount: &count, RepositoryId: req.Msg.RepositoryId}
	for _, row := range rows {
		response.Tags = append(response.Tags, &golfv1.Tag{Name: row.Name, CommitId: row.Commit.SHA, Id: row.ID, Message: row.Message})
	}
	return connect.NewResponse(response), nil
}
func (s *Server) ListCommits(ctx context.Context, req *connect.Request[golfv1.ListCommitsRequest]) (*connect.Response[golfv1.ListCommitsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	var rows []forgeCommit
	var next uint32
	if req.Msg.Path != "" {
		var id int64
		id, err = discussionID(req.Msg.RepositoryId)
		if err == nil {
			rows, next, err = s.listPathCommits(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), id, req.Msg.Ref, req.Msg.Path, pageFrom(req.Msg.Page))
		}
	} else if req.Msg.RepositoryId != "" {
		var id int64
		id, err = discussionID(req.Msg.RepositoryId)
		if err == nil {
			rows, next, err = s.listBoundCommits(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), id, req.Msg.Ref, pageFrom(req.Msg.Page))
		}
	} else {
		rows, next, err = s.listCommits(ctx, token, keyFrom(req.Msg.Repository), req.Msg.Ref, pageFrom(req.Msg.Page))
	}
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListCommitsResponse{Page: wirePage(next)}
	if req.Msg.RepositoryId != "" {
		response.CommitId, response.Path, response.RepositoryId = req.Msg.Ref, req.Msg.Path, req.Msg.RepositoryId
	}
	for _, row := range rows {
		response.Commits = append(response.Commits, &golfv1.Commit{Sha: row.SHA, Message: row.Commit.Message, AuthorName: row.Commit.Author.Name, AuthoredAt: row.Commit.Author.Date})
	}
	return connect.NewResponse(response), nil
}
func (s *Server) GetCommitDiff(ctx context.Context, req *connect.Request[golfv1.GetCommitDiffRequest]) (*connect.Response[golfv1.GetCommitDiffResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.getCommitDiff(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), req.Msg.CommitId)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) GetPullRequestDiff(ctx context.Context, req *connect.Request[golfv1.GetPullRequestDiffRequest]) (*connect.Response[golfv1.GetPullRequestDiffResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.getPullRequestDiff(ctx, s.cookieValue(req.Header()), token, req.Msg)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) GetContents(ctx context.Context, req *connect.Request[golfv1.GetContentsRequest]) (*connect.Response[golfv1.GetContentsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	var id int64
	if req.Msg.RepositoryId != "" {
		id, err = discussionID(req.Msg.RepositoryId)
		if err != nil {
			return nil, rpcError(err)
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result, err := s.getBoundContents(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), id, req.Msg.Ref, req.Msg.Path, req.Msg.IncludeLatestChanges)
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.GetContentsResponse{RepositoryId: strconv.FormatInt(result.RepositoryID, 10), CommitId: result.CommitID, Path: result.Path, Kind: sourceType(result.Kind)}
	for _, entry := range result.Entries {
		response.Entries = append(response.Entries, wireEntry(entry))
	}
	if result.File != nil {
		response.File = &golfv1.SourceFile{Entry: wireEntry(result.File.sourceEntry), Content: result.File.Content, PreviewReason: result.File.PreviewReason}
	}
	return connect.NewResponse(response), nil
}
func (s *Server) ListIssues(ctx context.Context, req *connect.Request[golfv1.ListIssuesRequest]) (*connect.Response[golfv1.ListIssuesResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	state := "open"
	switch req.Msg.State {
	case golfv1.IssueState_ISSUE_STATE_UNSPECIFIED, golfv1.IssueState_ISSUE_STATE_OPEN:
	case golfv1.IssueState_ISSUE_STATE_CLOSED:
		state = "closed"
	case golfv1.IssueState_ISSUE_STATE_ALL:
		state = "all"
	default:
		return nil, rpcError(invalid("Issue state is not supported."))
	}
	if _, _, err := pagination(pageFrom(req.Msg.Page)); err != nil {
		return nil, rpcError(err)
	}
	if err := validateDiscussionQuery(req.Msg.Query); err != nil {
		return nil, rpcError(err)
	}
	var rows []Issue
	var next uint32
	err = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), func(base string, repo Repository) error {
		var readErr error
		if nonemptyDiscussionQuery(req.Msg.Query) {
			rows, next, readErr = s.searchIssues(ctx, token, base, repo, state, pageFrom(req.Msg.Page), req.Msg.Query)
		} else {
			rows, next, readErr = s.listIssues(ctx, token, keyFrom(req.Msg.Repository), state, pageFrom(req.Msg.Page))
		}
		return readErr
	})
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListIssuesResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Issues = append(response.Issues, wireIssue(row))
	}
	return connect.NewResponse(response), nil
}
func (s *Server) GetIssue(ctx context.Context, req *connect.Request[golfv1.GetIssueRequest]) (*connect.Response[golfv1.GetIssueResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	if err := issueNumber(req.Msg.Number); err != nil {
		return nil, rpcError(err)
	}
	var issue Issue
	err = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), func(string, Repository) error {
		var readErr error
		issue, readErr = s.getIssue(ctx, token, keyFrom(req.Msg.Repository), req.Msg.Number)
		return readErr
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetIssueResponse{Issue: wireIssue(issue)}), nil
}
func (s *Server) ListCapabilities(ctx context.Context, _ *connect.Request[golfv1.ListCapabilitiesRequest]) (*connect.Response[golfv1.ListCapabilitiesResponse], error) {
	_, ready := s.dependencyChecks(ctx)
	state, reason := golfv1.CapabilityState_CAPABILITY_STATE_READY, "Browse and create repositories, explore code, and read issues using your account permissions."
	if !ready {
		state, reason = golfv1.CapabilityState_CAPABILITY_STATE_DEGRADED, "A required service is unavailable. Check system health before using repositories."
	}
	capabilities := []*golfv1.Capability{{Id: "repositories", Label: "Repositories", State: state, Reason: reason}}
	pipelineState, pipelineReason := golfv1.CapabilityState_CAPABILITY_STATE_DISABLED, "Manual Docker shell execution requires an enrolled worker; higher-level policies default to deny."
	if len(s.runnerKeys) > 0 {
		pipelineState, pipelineReason = golfv1.CapabilityState_CAPABILITY_STATE_DEGRADED, "Manual Docker shell execution is configured; no currently enrolled worker heartbeat is confirmed."
		ids := []string{}
		for id := range s.runnerKeys {
			ids = append(ids, id)
		}
		encoded, _ := json.Marshal(ids)
		var alive bool
		if s.db != nil && ready && s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_runner_presence WHERE forge_url=$1 AND last_seen>clock_timestamp()-interval '15 seconds' AND runner_id IN (SELECT jsonb_array_elements_text($2::jsonb)))`, s.config.GiteaURL, string(encoded)).Scan(&alive) == nil && alive {
			pipelineState, pipelineReason = golfv1.CapabilityState_CAPABILITY_STATE_READY, "An enrolled Docker worker is polling. Only the bounded manual shell catalog is available; exact repository/workflow policies govern each run. Provider engine parity and trusted merge checks remain unavailable."
		}
	}
	capabilities = append(capabilities, &golfv1.Capability{Id: "pipelines", Label: "Manual shell pipelines", State: pipelineState, Reason: pipelineReason})
	eventState, eventReason := golfv1.CapabilityState_CAPABILITY_STATE_DISABLED, "No native push webhook connection is configured. Durable intake is separate from automatic execution."
	if len(s.repositoryEventConnections) > 0 {
		eventState, eventReason = golfv1.CapabilityState_CAPABILITY_STATE_DEGRADED, "Native push intake is configured; its database is unavailable."
		if s.db != nil && s.db.PingContext(ctx) == nil {
			eventState, eventReason = golfv1.CapabilityState_CAPABILITY_STATE_READY, "Authenticated native push deliveries can be recorded and deduplicated by signed payload. Push execution requires its separate operator switch, grants and policy ceilings."
		}
	}
	capabilities = append(capabilities, &golfv1.Capability{Id: "events.native", Label: "Native push event intake", State: eventState, Reason: eventReason})
	automaticState, automaticReason := golfv1.CapabilityState_CAPABILITY_STATE_DISABLED, "Automatic push admission is disabled by the operator. Existing admitted runs retain their grant and policy fences; disable push policy or revoke the grant to stop them."
	if s.config.PushCIEnabled {
		automaticState, automaticReason = golfv1.CapabilityState_CAPABILITY_STATE_DEGRADED, "Push execution is enabled, but the coordinator or enrolled worker is not currently healthy."
		seen := s.pushCoordinatorSeen.Load()
		if seen > 0 && time.Since(time.Unix(0, seen)) < 5*time.Second && pipelineState == golfv1.CapabilityState_CAPABILITY_STATE_READY {
			automaticState, automaticReason = golfv1.CapabilityState_CAPABILITY_STATE_READY, "The coordinator and Docker worker are active. Only sponsor-authored branch pushes with fresh native activity, an unexpired grant, approved image and every push policy ceiling can run. Native engine parity remains unavailable."
		}
	}
	capabilities = append(capabilities, &golfv1.Capability{Id: "pipelines.automatic", Label: "Automatic push pipelines", State: automaticState, Reason: automaticReason})
	agentState, agentReason := golfv1.CapabilityState_CAPABILITY_STATE_DISABLED, "Managed Docker coding-task worker is not configured. Native account connections are separate."
	if s.config.AgentImage != "" {
		agentState, agentReason = golfv1.CapabilityState_CAPABILITY_STATE_DEGRADED, "Managed task image is configured, but its qualified worker heartbeat is unavailable."
		if s.agentAvailable(ctx) {
			agentState, agentReason = golfv1.CapabilityState_CAPABILITY_STATE_READY, "Qualified Docker worker is connected for manual Codex ChatGPT tasks. Current account grants, model selection and every usage policy must permit each task. API billing, automatic triggers and publication are unavailable."
		}
	}
	capabilities = append(capabilities, &golfv1.Capability{Id: "agents.codex", Label: "Codex manual coding tasks", State: agentState, Reason: agentReason})
	for _, entry := range []struct{ id, label, reason string }{
		{"webhooks.outbound", "Outbound webhooks and Slack notifications", "Planned. Event subscriptions, protected destinations, durable delivery history and retries are not implemented."},
		{"email.outbound", "Outbound email", "Planned. Configurable SMTP/API delivery, verified addresses and notification preferences are not implemented."},
		{"email.inbound", "Inbound email", "Planned. Authorized email-to-comment, issue and task routing is not implemented."},
		{"deployments", "Protected previews and deployment", "Planned. Portable and Cloudflare deployment targets require their own qualified adapters."},
		{"agents.claude-code", "Claude Code", "Native Claude account/API setup is available in account settings. Model access and managed task execution require separate qualification."},
		{"agents.opencode", "OpenCode", "Native OpenCode provider API-key setup is available in account settings. Provider OAuth, model access and managed execution require separate qualification."},
		{"agents.grok", "Grok", "Planned Golf adapter. Local execution and supported native authentication/protocol need qualification."},
		{"agents.pi", "Pi", "Planned Golf adapter. Local execution and supported native authentication/protocol need qualification."},
		{"cloudflare.workers", "Workers: routing and event intake", "Not implemented or connected. Edge routing and provider webhook adapters need live qualification."},
		{"cloudflare.queues", "Queues: event and work delivery", "Not implemented or connected. Portable event intake does not establish a Cloudflare queue connection."},
		{"cloudflare.workflows", "Workflows: durable provider steps", "Not implemented or connected. Provisioning, deployment and approval-wait adapters need qualification."},
		{"cloudflare.sandboxes", "Sandboxes: coding agent execution", "Not implemented or connected. Agent execution remains a generic Golf capability with portable runners."},
		{"cloudflare.containers", "Containers: CI and application runtime", "Not implemented or connected. Each workload, isolation boundary and capacity must be qualified."},
		{"cloudflare.r2", "R2: sources, artifacts and backups", "No qualified Cloudflare connection. Each storage consumer must be enabled and tested separately."},
		{"cloudflare.ai-gateway", "AI Gateway: inference routing", "Not implemented or connected. Provider routes, billing owner and data retention require explicit configuration."},
		{"cloudflare.workers-ai", "Workers AI: optional inference", "Not implemented or connected. Harness/model combinations must be qualified; AI remains optional."},
		{"cloudflare.email", "Email Service: sending and routing", "Not implemented or connected. Generic Golf email delivery and inbound authorization require adapters."},
		{"cloudflare.browser", "Browser Run: preview tests", "Not implemented or connected. Portable browser testing remains an independent option."},
		{"cloudflare.access", "Access: protected previews", "Not implemented or connected. Authentication policies and preview expiry need qualification."},
		{"cloudflare.dns", "DNS and TLS: deployment domains", "Not implemented or connected. Exact destination plans, domain readiness and rollback need qualification."},
		{"cloudflare.tunnel", "Tunnel: approved private origins", "Not implemented or connected. Private-origin reachability requires explicit network authorization."},
		{"cloudflare.secrets", "Secrets Store: Worker credentials", "Not implemented or connected. Supported consumers and secret references must be qualified."},
		{"cloudflare.search", "AI Search and Vectorize: retrieval", "Not implemented or connected. Optional derived indexes must enforce current repository access."},
		{"cloudflare.logs", "Workers logs: runtime diagnosis", "Not implemented or connected. Deployment correlation, private access and retention require adapters."},
	} {
		capabilities = append(capabilities, &golfv1.Capability{Id: entry.id, Label: entry.label, State: golfv1.CapabilityState_CAPABILITY_STATE_DISABLED, Reason: entry.reason})
	}
	return connect.NewResponse(&golfv1.ListCapabilitiesResponse{Capabilities: capabilities}), nil
}

func wireOrganization(org forgeOrganization) *golfv1.Organization {
	visibility := golfv1.OrganizationVisibility(golfv1.OrganizationVisibility_value["ORGANIZATION_VISIBILITY_"+strings.ToUpper(org.Visibility)])
	return &golfv1.Organization{Id: strconv.FormatInt(org.ID, 10), Name: org.Name, FullName: org.FullName, Description: org.Description, Visibility: visibility}
}
func wireOrganizationTeam(team forgeOrganizationTeam) *golfv1.OrganizationTeam {
	permission := func(value string) golfv1.TeamPermission {
		return golfv1.TeamPermission(golfv1.TeamPermission_value["TEAM_PERMISSION_"+strings.ToUpper(value)])
	}
	units := make(map[string]golfv1.TeamPermission, len(team.UnitPermissions))
	for unit, value := range team.UnitPermissions {
		units[unit] = permission(value)
	}
	visibility := golfv1.TeamVisibility(golfv1.TeamVisibility_value["TEAM_VISIBILITY_"+strings.ToUpper(team.Visibility)])
	return &golfv1.OrganizationTeam{Id: strconv.FormatInt(team.ID, 10), Name: team.Name, Description: team.Description, Permission: permission(team.Permission), UnitPermissions: units, IncludesAllRepositories: team.IncludesAllRepositories, Visibility: visibility}
}
func (s *Server) ListOrganizations(ctx context.Context, req *connect.Request[golfv1.ListOrganizationsRequest]) (*connect.Response[golfv1.ListOrganizationsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listOrganizations(ctx, s.cookieValue(req.Header()), token, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListOrganizationsResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Organizations = append(response.Organizations, wireOrganization(row))
	}
	return connect.NewResponse(response), nil
}
func (s *Server) GetOrganization(ctx context.Context, req *connect.Request[golfv1.GetOrganizationRequest]) (*connect.Response[golfv1.GetOrganizationResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	org, err := s.getOrganization(ctx, s.cookieValue(req.Header()), token, req.Msg.Organization)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetOrganizationResponse{Organization: wireOrganization(org)}), nil
}
func (s *Server) ListTeams(ctx context.Context, req *connect.Request[golfv1.ListTeamsRequest]) (*connect.Response[golfv1.ListTeamsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listOrganizationTeams(ctx, s.cookieValue(req.Header()), token, req.Msg.Organization, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListTeamsResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Teams = append(response.Teams, wireOrganizationTeam(row))
	}
	return connect.NewResponse(response), nil
}
func (s *Server) GetTeam(ctx context.Context, req *connect.Request[golfv1.GetTeamRequest]) (*connect.Response[golfv1.GetTeamResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	team, err := s.getOrganizationTeam(ctx, s.cookieValue(req.Header()), token, req.Msg.Organization, req.Msg.TeamId)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetTeamResponse{Team: wireOrganizationTeam(team)}), nil
}
func (s *Server) ListTeamMembers(ctx context.Context, req *connect.Request[golfv1.ListTeamMembersRequest]) (*connect.Response[golfv1.ListTeamMembersResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listOrganizationTeamMembers(ctx, s.cookieValue(req.Header()), token, req.Msg.Organization, req.Msg.TeamId, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListTeamMembersResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Members = append(response.Members, wireUser(row))
	}
	return connect.NewResponse(response), nil
}
func (s *Server) ListTeamRepositories(ctx context.Context, req *connect.Request[golfv1.ListTeamRepositoriesRequest]) (*connect.Response[golfv1.ListTeamRepositoriesResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listOrganizationTeamRepositories(ctx, s.cookieValue(req.Header()), token, req.Msg.Organization, req.Msg.TeamId, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListTeamRepositoriesResponse{Page: wirePage(next)}
	for _, row := range rows {
		response.Repositories = append(response.Repositories, s.wireGitRepository(row))
	}
	return connect.NewResponse(response), nil
}

func (s *Server) ListPullRequests(ctx context.Context, req *connect.Request[golfv1.ListPullRequestsRequest]) (*connect.Response[golfv1.ListPullRequestsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listPullRequests(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), req.Msg.State, pageFrom(req.Msg.Page), pullListQuery{Discussion: req.Msg.Query, Sort: req.Msg.Sort, BaseBranch: req.Msg.BaseBranch})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.ListPullRequestsResponse{PullRequests: rows, Page: wirePage(next)}), nil
}
func (s *Server) GetPullRequest(ctx context.Context, req *connect.Request[golfv1.GetPullRequestRequest]) (*connect.Response[golfv1.GetPullRequestResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	row, err := s.getPullRequest(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), req.Msg.Number)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetPullRequestResponse{PullRequest: row}), nil
}
func (s *Server) ListPullRequestReviews(ctx context.Context, req *connect.Request[golfv1.ListPullRequestReviewsRequest]) (*connect.Response[golfv1.ListPullRequestReviewsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, err := s.listPullRequestReviews(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), req.Msg.Number, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.ListPullRequestReviewsResponse{Reviews: rows, Page: wirePage(next)}), nil
}

func (s *Server) ListAuditEvents(ctx context.Context, req *connect.Request[golfv1.ListAuditEventsRequest]) (*connect.Response[golfv1.ListAuditEventsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	rows, next, snapshot, err := s.listAuditEvents(ctx, s.cookieValue(req.Header()), token, req.Msg.Limit, req.Msg.BeforeId, req.Msg.SnapshotId)
	if err != nil {
		return nil, rpcError(err)
	}
	response := &golfv1.ListAuditEventsResponse{NextBeforeId: next, SnapshotId: snapshot}
	for _, row := range rows {
		action := golfv1.AuditAction(golfv1.AuditAction_value["AUDIT_ACTION_"+row.Action])
		if action == golfv1.AuditAction_AUDIT_ACTION_UNSPECIFIED {
			return nil, rpcError(errStorageUnavailable)
		}
		event := &golfv1.AuditEvent{Id: strconv.FormatInt(row.ID, 10), OccurredAt: row.OccurredAt.Format(time.RFC3339Nano), Action: action,
			ActorSessionId: strconv.FormatInt(row.ActorSessionID, 10), CredentialKind: row.CredentialKind, RevokedCount: uint64(row.RevokedCount), OperationId: row.OperationID}
		if row.ResourceID.Valid {
			event.ResourceId = row.ResourceID.UUID.String()
		}
		if row.TargetSessionID.Valid {
			event.TargetSessionId = strconv.FormatInt(row.TargetSessionID.Int64, 10)
		}
		if row.ExpiresAt.Valid {
			expiry := row.ExpiresAt.Time.Format(time.RFC3339Nano)
			event.ExpiresAt = &expiry
		}
		response.Events = append(response.Events, event)
	}
	return connect.NewResponse(response), nil
}

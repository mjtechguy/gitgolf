# Settings needed for real product testing

Golf settings must show current values, offer explicit New/Edit actions, enforce the acting user's authority, persist changes and let another session verify them. A planned field is not a working setting. Instance administration does not substitute for organization/repository ownership.

## Current controls

| Scope | Working controls | Qualification boundary |
| --- | --- | --- |
| Personal | Sessions/revocation, SSH keys, issue/comment writes, repository creation, read-only API credentials, appearance, public display name/bio/location/website | Own account only; API credentials do not authorize Git or writes. Username/email/password/avatar management remain separate. |
| Repository | Description, existing default branch, issue/wiki/PR flags, direct existing-user collaborator grants, workflow selection and supported manual run/cancel | Native permission required. Invitations, organization/team grants, protections, full workflow engines and deploy keys are not covered. |
| Organization | Existing-user membership in ordinary teams, repository/workflow execution ceilings | Owner-team administration, full role/grant editing and invitations remain open. |
| Instance | Disable ordinary enrolled password accounts, organization-creation policy, execution ceilings, encrypted infrastructure profiles/tests/object-source activation | Enrollment/reset/reactivation and database cutover are still operator actions. Cloudflare/AWS account qualification is separate. |

## Next editable settings, in order

| Priority | Controls to implement | Required real test |
| --- | --- | --- |
| 1 (implemented public fields) | Public profile display name, bio, location and website; avatar/privacy controls remain open | Edit own profile; verify persisted values in a new session; deny another user's target; stale form and dropped receipt remain explicit. |
| 2 | Change password, enrolled login email, verified email flow and recovery | Current-password confirmation; unique email; coordinated login/native mappings; revoke old sessions; old login/password fail and new values succeed. Email verification needs actual delivery. |
| 3 | Admin user enrollment, reset, re-enable and role lifecycle | Ordinary and administrator protections; prevent last-admin lockout; exact actor/target attribution; ordinary user cannot administer anyone. |
| 4 | Organization general settings, members/invitations, teams and repository grants | Owner/admin/member/outside-user matrix, final-owner protection, invitation acceptance/expiry and permission loss during writes. |
| 5 | Repository visibility/archive/transfer/delete and branch/review rules | Explicit confirmations, source/destination authority, credential/clone behavior, URL changes and Git/API enforcement. A settings editor alone does not establish protection. |
| 6 | CI pool enrollment/drain/revocation, repo eligibility, variables/secrets, quotas and retention | Actual job access, inherited ceilings, credential non-disclosure, fork denial/approval, expired worker rejection and resource cleanup. |
| 7 | GitHub/GitLab connections and direct imports | Scoped credentials, public/private imports, branches/tags/LFS/submodules, provider revocation and explicit unsupported pipeline behavior. |
| 8 | Agent provider/harness connections, MCP/ACP policy and budgets | Actual harness invocation, own/org credential ownership, tool approvals, cancellation, accounting and denied writes. |
| 9 | Webhooks/email and protected previews/CD/destinations/DNS | Real delivery with verification/signatures/retry control; private preview expiration, exact artifact promotion, destination authority and rollback. |
| 10 | Storage/database/backups and enterprise identity | Independently selected backends, live provider test, object history retention, coordinated fresh restore, explicit database cutover, SSO/MFA enforcement. Dev installs may be reset. |

## Table requirements

All shared inventories need page controls and a common page-size selector. Search and sorting currently apply to loaded data and must say so. Loading another server page must remain available when the API reports one; local pagination cannot hide the fact that more rows exist remotely. Filtering resets/clamps the page, denied access clears private rows, and mobile/keyboard controls remain usable. Workflow run history must not stop permanently at the first 20 runs.

## References

The current implementation boundary is recorded in [implementation status](IMPLEMENTATION_STATUS.md). Relevant upstream scope includes [GitHub account management](https://docs.github.com/en/account-and-profile/how-tos/account-management), [organization settings](https://docs.github.com/en/organizations/managing-organization-settings) and [repository Actions policy](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository). Golf must enforce the features it implements rather than expose every upstream setting as an inert form.

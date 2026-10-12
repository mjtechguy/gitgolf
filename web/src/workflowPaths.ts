// Keep admission's ASCII/literal filename contract aligned with internal/workflowpath.
export const isActionsWorkflowPath = (value: string) => value.length <= 255 && !value.includes('..') && /^\.(?:forgejo|gitea|github)\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(value);
export const isWorkflowPath = (value: string) => value === '.gitlab-ci.yml' || isActionsWorkflowPath(value);

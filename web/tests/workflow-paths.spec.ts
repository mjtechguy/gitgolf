import { expect, test } from '@playwright/test';
import { isActionsWorkflowPath, isWorkflowPath } from '../src/workflowPaths';

test('all workflow editors share the literal native path boundary', () => {
  for (const directory of ['.forgejo/workflows/', '.github/workflows/']) {
    for (const filename of ['check.yml', 'golf-test.yaml', 'a.b.yml']) {
      expect(isActionsWorkflowPath(directory + filename)).toBe(true);
      expect(isWorkflowPath(directory + filename)).toBe(true);
    }
    for (const filename of ['', '*.yml', 'nested/a.yml', '../a.yml', 'a..b.yml', 'a.yml\n', 'a.yml?next', 'a\\b.yml', 'résumé.yml', 'a'.repeat(256) + '.yml']) {
      expect(isWorkflowPath(directory + filename)).toBe(false);
    }
  }
  expect(isWorkflowPath('.gitlab-ci.yml')).toBe(true);
  expect(isActionsWorkflowPath('.gitlab-ci.yml')).toBe(false);
  expect(isWorkflowPath('.ci/workflows/a.yml')).toBe(false);
});

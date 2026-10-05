import type { Issue } from '@cumulus/shared';

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const id = overrides.id ?? '1';
  return {
    id,
    native_ref: null,
    identifier: `AB#${id}`,
    title: `Issue ${id}`,
    description: null,
    priority: null,
    state: 'Dev',
    branch_name: null,
    url: null,
    assignee_id: null,
    labels: ['cumulus'],
    blocked_by: [],
    dispatchable: true,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

import type { Issue } from '@cumulus/shared';
import { describe, expect, it } from 'vitest';
import type { Tracker } from '../../src/tracker/types.js';

/**
 * §17.3 shared contract. `setup` seeds issues (state = provider state name) and returns a tracker
 * plus a counter of provider requests.
 */
export interface TrackerHarness {
  tracker: Tracker;
  providerCalls(): number;
}

export function trackerContract(
  name: string,
  setup: (issues: Issue[]) => Promise<TrackerHarness>,
  sample: (id: string, state: string) => Issue,
): void {
  describe(`${name} tracker contract`, () => {
    it('§17.3 empty fetch_issues_by_states([]) returns empty without a provider call', async () => {
      const h = await setup([sample('1', 'Dev')]);
      expect(await h.tracker.fetchIssuesByStates([])).toEqual([]);
      expect(h.providerCalls()).toBe(0);
    });

    it('§17.3 empty fetch_issues_by_ids([]) returns empty without a provider call', async () => {
      const h = await setup([sample('1', 'Dev')]);
      expect(await h.tracker.fetchIssuesByIds([])).toEqual([]);
      expect(h.providerCalls()).toBe(0);
    });

    it('§17.3 candidate fetch returns only requested states', async () => {
      const h = await setup([sample('1', 'Dev'), sample('2', 'Closed')]);
      const issues = await h.tracker.fetchIssuesByStates(['Dev']);
      expect(issues.map((i) => i.id)).toEqual(['1']);
    });

    it('§17.3 refresh by id returns full normalized snapshots and omits invisible ids', async () => {
      const h = await setup([sample('1', 'Dev')]);
      const issues = await h.tracker.fetchIssuesByIds(['1', '999']);
      expect(issues).toHaveLength(1);
      const issue = issues[0]!;
      for (const key of [
        'id',
        'native_ref',
        'identifier',
        'title',
        'description',
        'priority',
        'state',
        'branch_name',
        'url',
        'assignee_id',
        'labels',
        'blocked_by',
        'dispatchable',
        'created_at',
        'updated_at',
      ]) {
        expect(issue).toHaveProperty(key);
      }
      expect(typeof issue.dispatchable).toBe('boolean');
    });

    it('§11.1 refresh treats input ids as a set', async () => {
      const h = await setup([sample('1', 'Dev')]);
      expect(await h.tracker.fetchIssuesByIds(['1', '1'])).toHaveLength(1);
    });

    it('§11.3 labels are trimmed and lowercased', async () => {
      const h = await setup([sample('1', 'Dev')]);
      const [issue] = await h.tracker.fetchIssuesByStates(['Dev']);
      for (const label of issue!.labels) expect(label).toBe(label.trim().toLowerCase());
    });
  });
}

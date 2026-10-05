import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createAzureDevOpsTracker } from '../../src/tracker/azure-devops.js';

/**
 * §17.8 real integration profile. Read-only. Enable with CUMULUS_LIVE_ADO=1 (uses the az CLI login).
 * Reported as skipped when disabled.
 */
const enabled = process.env['CUMULUS_LIVE_ADO'] === '1';

describe.skipIf(!enabled)('azure_devops live (read-only)', () => {
  const token = async () =>
    execFileSync(
      'az',
      [
        'account',
        'get-access-token',
        '--resource',
        '499b84ac-1321-427f-aa17-267ca6975798',
        '--query',
        'accessToken',
        '-o',
        'tsv',
      ],
      {
        encoding: 'utf8',
      },
    ).trim();
  const tracker = createAzureDevOpsTracker(
    {
      provider: {
        organization: 'adlibsoftware',
        project: 'AdlibCTP',
        team: 'DevOps',
        area_path: 'AdlibCTP\\DevOps',
        iteration_path: 'AdlibCTP\\Backlogs\\DevOps',
      },
      activeStates: ['Backlog', 'Dev', 'Test'],
      terminalStates: ['Closed'],
    },
    { env: {}, token },
  );

  it('fetches active-column issues and refreshes them by id', async () => {
    const issues = await tracker.fetchIssuesByStates(['Dev', 'Test']);
    for (const i of issues) expect(['dev', 'test']).toContain(i.state.toLowerCase());
    if (issues.length > 0) {
      const ids = issues.slice(0, 3).map((i) => i.id);
      const refreshed = await tracker.fetchIssuesByIds(ids);
      expect(refreshed.map((i) => i.id).sort()).toEqual([...ids].sort());
    }
  }, 60_000);

  it('loads the board column mapping', async () => {
    const specs = tracker.agentToolSpecs();
    expect(specs).toHaveLength(2);
    // Access the board through a no-op: an invalid column fails validation before any write.
    const res = await tracker.executeAgentTool(
      'azure_devops_move_card',
      { column: 'Closed' },
      {
        issue: { id: '0' } as never,
      },
    );
    expect(res.ok).toBe(false);
  });
});

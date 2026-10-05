import { describe, expect, it } from 'vitest';
import { AzureDevOpsTracker, createAzureDevOpsTracker } from '../../src/tracker/azure-devops.js';
import { TrackerError } from '../../src/tracker/types.js';
import { trackerContract } from '../contracts/tracker.contract.js';
import { makeIssue } from '../fixtures/issues.js';
import { FakeAdo, adoItem, predecessor } from './ado-fake.js';

const provider = {
  organization: 'adlibsoftware',
  project: 'AdlibCTP',
  team: 'DevOps',
  area_path: 'AdlibCTP\\DevOps',
  iteration_path: 'AdlibCTP\\Backlogs\\DevOps',
};
const trackerConfig = { activeStates: ['Backlog', 'Dev', 'Test'], terminalStates: ['Closed'] };

function build(fake: FakeAdo, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  return createAzureDevOpsTracker(
    { provider: { ...provider, ...extra }, ...trackerConfig },
    { env, fetch: fake.fetch, token: async () => 'tok' },
  );
}

trackerContract(
  'azure_devops',
  async (issues) => {
    const fake = new FakeAdo(issues.map((i) => adoItem(Number(i.id), i.state)));
    return { tracker: build(fake), providerCalls: () => fake.providerCalls };
  },
  (id, state) => makeIssue({ id, state }),
);

describe('azure_devops adapter', () => {
  it('C-1 WIQL scopes by area, iteration, work item types and board column', async () => {
    const fake = new FakeAdo([adoItem(1, 'Dev')]);
    await build(fake).fetchIssuesByStates(['Dev', "O'Brien"]);
    const query = (fake.requests[0]!.body as { query: string }).query;
    expect(query).toContain("[System.AreaPath] UNDER 'AdlibCTP\\DevOps'");
    expect(query).toContain("[System.IterationPath] UNDER 'AdlibCTP\\Backlogs\\DevOps'");
    expect(query).toContain("[System.WorkItemType] IN ('User Story', 'Bug')");
    expect(query).toContain("[System.BoardColumn] IN ('Dev', 'O''Brien')");
    expect(fake.requests[0]!.url.pathname).toBe('/adlibsoftware/AdlibCTP/_apis/wit/wiql');
  });

  it('C-1 reports the board column as state', async () => {
    const fake = new FakeAdo([adoItem(1, 'Dev')]);
    const [issue] = await build(fake).fetchIssuesByStates(['Dev']);
    expect(issue!.state).toBe('Dev');
  });

  it('C-1 falls back to System.State when the item has no board column', async () => {
    const fake = new FakeAdo([
      adoItem(1, 'Dev', { 'System.BoardColumn': undefined, 'System.State': 'Removed' }),
    ]);
    const [issue] = await build(fake).fetchIssuesByIds(['1']);
    expect(issue!.state).toBe('Removed');
  });

  it('§17.3 normalizes fields from the provider payload', async () => {
    const fake = new FakeAdo([
      adoItem(42, 'Dev', {
        'System.Title': 'Do a thing',
        'System.Tags': ' Cumulus; Infra ;; infra',
        'Microsoft.VSTS.Common.Priority': 2,
        'System.Description': '<p>Hello <b>world</b></p><div>Line&nbsp;2 &amp; more</div>',
        'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>works</li></ul>',
        'System.AssignedTo': { uniqueName: 'a@adlibsoftware.com', id: 'abc' },
      }),
    ]);
    const [issue] = await build(fake).fetchIssuesByIds(['42']);
    expect(issue).toEqual({
      id: '42',
      native_ref: {
        work_item_id: 42,
        rev: 3,
        work_item_type: 'User Story',
        area_path: 'AdlibCTP\\DevOps',
        project: 'AdlibCTP',
      },
      identifier: 'AB#42',
      title: 'Do a thing',
      description: 'Hello world\nLine 2 & more\n\nAcceptance criteria:\nworks',
      priority: 2,
      state: 'Dev',
      branch_name: null,
      url: 'https://dev.azure.com/adlibsoftware/AdlibCTP/_workitems/edit/42',
      assignee_id: 'a@adlibsoftware.com',
      labels: ['cumulus', 'infra'],
      blocked_by: [],
      dispatchable: true,
      created_at: '2026-09-25T15:59:09.080Z',
      updated_at: '2026-10-02T20:16:52.240Z',
    });
  });

  it('§17.3 unusable optional metadata normalizes to null without hiding required fields', async () => {
    const fake = new FakeAdo([
      adoItem(5, 'Dev', {
        'Microsoft.VSTS.Common.Priority': 'high',
        'System.CreatedDate': 'not a date',
        'System.Tags': undefined,
      }),
    ]);
    const [issue] = await build(fake).fetchIssuesByIds(['5']);
    expect(issue).toMatchObject({ id: '5', priority: null, created_at: null, labels: [] });
  });

  it('§17.3 pagination fetches details in chunks of 200 preserving order', async () => {
    const items = Array.from({ length: 450 }, (_, i) => adoItem(i + 1, 'Dev'));
    const fake = new FakeAdo(items);
    const issues = await build(fake).fetchIssuesByStates(['Dev']);
    expect(issues.map((i) => Number(i.id))).toEqual(items.map((i) => i.id));
    const batchSizes = fake.requests
      .filter((r) => r.url.pathname.endsWith('workitemsbatch'))
      .map((r) => (r.body as { ids: number[] }).ids.length);
    expect(batchSizes).toEqual([200, 200, 50]);
  });

  it('§17.3 pagination integrity: a WIQL result at the $top cap fails', async () => {
    const fake = new FakeAdo([adoItem(1, 'Dev'), adoItem(2, 'Dev')]);
    fake.wiqlTop = 2;
    const tracker = build(fake, { max_results: 2 });
    await expect(tracker.fetchIssuesByStates(['Dev'])).rejects.toMatchObject({
      category: 'tracker_pagination',
    });
  });

  it('§17.3 open predecessors make an issue non-dispatchable and appear in blocked_by', async () => {
    const fake = new FakeAdo([
      adoItem(1, 'Dev', {}, [predecessor(2)]),
      adoItem(2, 'Dev', { 'System.State': 'Active' }),
      adoItem(3, 'Dev', {}, [predecessor(4)]),
      adoItem(4, 'Closed', { 'System.State': 'Closed' }),
    ]);
    const issues = await build(fake).fetchIssuesByIds(['1', '3']);
    const byId = Object.fromEntries(issues.map((i) => [i.id, i]));
    expect(byId['1']).toMatchObject({
      dispatchable: false,
      blocked_by: [{ id: '2', identifier: 'AB#2', state: 'Active' }],
    });
    expect(byId['3']).toMatchObject({
      dispatchable: true,
      blocked_by: [{ id: '4', identifier: 'AB#4', state: 'Closed' }],
    });
  });

  it('§11.1 id refresh omits items that moved out of scope', async () => {
    const fake = new FakeAdo([adoItem(1, 'Dev', { 'System.AreaPath': 'AdlibCTP\\Transform' })]);
    expect(await build(fake).fetchIssuesByIds(['1'])).toEqual([]);
  });

  it('§17.3 state-list reads omit malformed records', async () => {
    const fake = new FakeAdo([adoItem(1, 'Dev', { 'System.Title': '' }), adoItem(2, 'Dev')]);
    const issues = await build(fake).fetchIssuesByStates(['Dev']);
    expect(issues.map((i) => i.id)).toEqual(['2']);
  });

  it('§17.3 id refresh fails on a malformed requested record', async () => {
    const fake = new FakeAdo([adoItem(1, 'Dev', { 'System.Title': '' })]);
    await expect(build(fake).fetchIssuesByIds(['1'])).rejects.toMatchObject({ category: 'tracker_response' });
  });

  it('§17.3 error mapping: transport failure is tracker_request', async () => {
    const fake = new FakeAdo();
    fake.forced.push(new TypeError('fetch failed'));
    await expect(build(fake).fetchIssuesByStates(['Dev'])).rejects.toMatchObject({
      category: 'tracker_request',
    });
  });

  it('§17.3 error mapping: non-success response is tracker_status', async () => {
    const fake = new FakeAdo();
    fake.forced.push({ status: 500, body: 'boom' });
    await expect(build(fake).fetchIssuesByStates(['Dev'])).rejects.toMatchObject({
      category: 'tracker_status',
    });
  });

  it('§17.3 error mapping: 429 is tracker_rate_limited with retry_after_ms', async () => {
    const fake = new FakeAdo();
    fake.forced.push({ status: 429, body: '', headers: { 'retry-after': '7' } });
    const err = await build(fake)
      .fetchIssuesByStates(['Dev'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerError);
    expect(err).toMatchObject({ category: 'tracker_rate_limited', retryAfterMs: 7000 });
  });

  it('§17.3 error mapping: malformed payload is tracker_response', async () => {
    const fake = new FakeAdo();
    fake.forced.push({ status: 200, body: 'not json' });
    await expect(build(fake).fetchIssuesByStates(['Dev'])).rejects.toMatchObject({
      category: 'tracker_response',
    });
  });

  it('§17.3 error mapping: missing required provider keys is invalid_tracker_config', () => {
    expect(() =>
      createAzureDevOpsTracker({ provider: { project: 'x' }, ...trackerConfig }, { env: {} }),
    ).toThrow(expect.objectContaining({ category: 'invalid_tracker_config' }));
  });

  it('§5.3.1 a documented secret $VAR that resolves empty is missing_tracker_secret', () => {
    expect(() =>
      createAzureDevOpsTracker(
        { provider: { ...provider, pat: '$ADO_PAT' }, ...trackerConfig },
        { env: { ADO_PAT: '' } },
      ),
    ).toThrow(expect.objectContaining({ category: 'missing_tracker_secret' }));
  });

  it('C-1 uses a bearer token from workload identity by default', async () => {
    const fake = new FakeAdo([adoItem(1, 'Dev')]);
    await build(fake).fetchIssuesByIds(['1']);
    expect(fake.requests[0]!.headers['authorization']).toBe('Bearer tok');
  });

  it('C-1 uses basic auth when a PAT is configured', async () => {
    const fake = new FakeAdo([adoItem(1, 'Dev')]);
    await build(fake, { pat: '$ADO_PAT' }, { ADO_PAT: 'secret' }).fetchIssuesByIds(['1']);
    expect(fake.requests[0]!.headers['authorization']).toBe(
      `Basic ${Buffer.from(':secret').toString('base64')}`,
    );
  });

  it('§10.5 declares secret environment names for removal from child environments', () => {
    const tracker = build(new FakeAdo(), { pat: '$MY_PAT' }, { MY_PAT: 'x' });
    expect(tracker.secretEnvironmentNames()).toEqual(
      expect.arrayContaining(['MY_PAT', 'AZURE_DEVOPS_EXT_PAT', 'SYSTEM_ACCESSTOKEN']),
    );
  });

  describe('C-11 provider-native tools', () => {
    it('advertises move_card and add_comment', () => {
      expect(
        build(new FakeAdo())
          .agentToolSpecs()
          .map((t) => t.name),
      ).toEqual(['azure_devops_move_card', 'azure_devops_add_comment']);
    });

    it('move_card sets the board column field and the mapped state', async () => {
      const fake = new FakeAdo([adoItem(1, 'Dev')]);
      const tracker = build(fake);
      const [issue] = await tracker.fetchIssuesByIds(['1']);
      const result = await tracker.executeAgentTool(
        'azure_devops_move_card',
        { column: 'Test' },
        { issue: issue! },
      );
      expect(result.ok).toBe(true);
      const patch = fake.requests.find((r) => r.method === 'PATCH')!;
      expect(patch.headers['content-type']).toBe('application/json-patch+json');
      expect(patch.body).toEqual([
        { op: 'add', path: '/fields/System.State', value: 'Resolved' },
        { op: 'add', path: '/fields/WEF_ABC_Kanban.Column', value: 'Test' },
      ]);
    });

    it('move_card rejects columns outside agent_columns', async () => {
      const fake = new FakeAdo([adoItem(1, 'Dev')]);
      const tracker = build(fake);
      const [issue] = await tracker.fetchIssuesByIds(['1']);
      const result = await tracker.executeAgentTool(
        'azure_devops_move_card',
        { column: 'Closed' },
        { issue: issue! },
      );
      expect(result).toMatchObject({ ok: false, output: { error: { code: 'invalid_arguments' } } });
      expect(fake.requests.some((r) => r.method === 'PATCH')).toBe(false);
    });

    it('add_comment posts markdown to the work item', async () => {
      const fake = new FakeAdo([adoItem(1, 'Dev')]);
      const tracker = build(fake);
      const [issue] = await tracker
        .executeAgentTool(
          'azure_devops_add_comment',
          { markdown: 'PR opened' },
          {
            issue: makeIssue({ id: '1' }),
          },
        )
        .then((r) => [r]);
      expect(issue!.ok).toBe(true);
      const post = fake.requests.find((r) => r.url.pathname.endsWith('/comments'))!;
      expect(post.url.searchParams.get('format')).toBe('markdown');
      expect(post.body).toEqual({ text: 'PR opened' });
    });

    it('invalid arguments return a structured failure', async () => {
      const result = await build(new FakeAdo()).executeAgentTool(
        'azure_devops_add_comment',
        { nope: 1 },
        {
          issue: makeIssue({ id: '1' }),
        },
      );
      expect(result).toMatchObject({ ok: false, output: { error: { code: 'invalid_arguments' } } });
    });

    it('transport failures return a structured failure instead of throwing', async () => {
      const fake = new FakeAdo();
      fake.forced.push(new TypeError('fetch failed'));
      const result = await build(fake).executeAgentTool(
        'azure_devops_add_comment',
        { markdown: 'x' },
        {
          issue: makeIssue({ id: '1' }),
        },
      );
      expect(result).toMatchObject({ ok: false, output: { error: { code: 'tracker_request' } } });
    });

    it('unsupported tool names fail without throwing', async () => {
      const result = await build(new FakeAdo()).executeAgentTool(
        'delete_everything',
        {},
        { issue: makeIssue() },
      );
      expect(result).toMatchObject({ ok: false, output: { error: { code: 'unsupported_tool' } } });
    });
  });

  it('is an AzureDevOpsTracker with kind azure_devops', () => {
    const t = build(new FakeAdo());
    expect(t).toBeInstanceOf(AzureDevOpsTracker);
    expect(t.kind).toBe('azure_devops');
  });
});

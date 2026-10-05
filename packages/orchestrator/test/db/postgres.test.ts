import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresStore } from '../../src/db/postgres.js';
import { makeIssue } from '../fixtures/issues.js';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** C-5 / C-6 against a real Postgres 14 (the production server version). Skipped without Docker. */
describe.skipIf(!dockerAvailable())('PostgresStore', () => {
  let container: { stop(): Promise<unknown>; getConnectionUri(): string };
  let store: PostgresStore;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    container = await new PostgreSqlContainer('postgres:14-alpine').start();
    store = PostgresStore.fromConnectionString(container.getConnectionUri());
    await store.migrate();
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    await store.truncateForTests();
  });

  it('C-5 migrations are idempotent', async () => {
    await expect(store.migrate()).resolves.toBeUndefined();
  });

  it('C-5 records a run lifecycle with transitions, digest and tokens', async () => {
    const issue = makeIssue({ id: '42', identifier: 'AB#42' });
    await store.runClaimed({ runId: 'r1', issue, attempt: null, agent: 'opencode', workspaceKey: 'AB_42-x' });
    await store.runTransition('r1', 'pod_created', { workerName: 'pod-1', imageDigest: 'img@sha256:abc' });
    await store.runTransition('r1', 'running');
    await store.runEnded('r1', 'completed', {
      exitReason: null,
      tokens: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });

    const page = await store.listRuns({ limit: 10, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: 'r1',
      issue_id: '42',
      issue_identifier: 'AB#42',
      attempt: null,
      agent: 'opencode',
      worker_name: 'pod-1',
      image_digest: 'img@sha256:abc',
      status: 'completed',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
    expect(page.items[0]!.ended_at).not.toBeNull();
    expect(await store.transitions('r1')).toEqual(['claimed', 'pod_created', 'running', 'completed']);
  });

  it('C-5 filters and pages runs newest first', async () => {
    for (const [i, status] of (['completed', 'failed', 'failed'] as const).entries()) {
      await store.runClaimed({
        runId: `r${i}`,
        issue: makeIssue({ id: String(i) }),
        attempt: i,
        agent: 'opencode',
        workspaceKey: `k${i}`,
      });
      await store.runEnded(`r${i}`, status, {
        exitReason: status === 'failed' ? 'boom' : null,
        tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      });
    }
    const failed = await store.listRuns({ limit: 1, offset: 0, status: 'failed' });
    expect(failed.total).toBe(2);
    expect(failed.items.map((r) => r.id)).toEqual(['r2']);
  });

  it('C-4 marks stale running runs as interrupted', async () => {
    await store.runClaimed({
      runId: 'r1',
      issue: makeIssue(),
      attempt: null,
      agent: 'opencode',
      workspaceKey: 'k',
    });
    await store.runTransition('r1', 'running');
    await store.runClaimed({
      runId: 'r2',
      issue: makeIssue({ id: '2' }),
      attempt: null,
      agent: 'opencode',
      workspaceKey: 'k2',
    });
    await store.runEnded('r2', 'completed', {
      exitReason: null,
      tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
    await store.markStaleRunsInterrupted();
    const runs = (await store.listRuns({ limit: 10, offset: 0 })).items;
    expect(Object.fromEntries(runs.map((r) => [r.id, r.status]))).toEqual({
      r1: 'interrupted',
      r2: 'completed',
    });
  });

  it('C-5 persists, replaces and deletes retry queue entries', async () => {
    const dueAt = new Date('2026-10-05T12:00:10Z');
    await store.saveRetry({ issueId: '1', identifier: 'AB#1', attempt: 1, dueAt, error: 'x' });
    await store.saveRetry({ issueId: '1', identifier: 'AB#1', attempt: 2, dueAt, error: 'y' });
    expect(await store.loadRetries()).toEqual([
      { issueId: '1', identifier: 'AB#1', attempt: 2, dueAt, error: 'y' },
    ]);
    await store.deleteRetry('1');
    expect(await store.loadRetries()).toEqual([]);
  });

  it('C-6 stores settings overrides with history', async () => {
    const at = new Date('2026-10-05T00:00:00Z');
    await store.set('agent.max_concurrent_agents', 7, 'tim', at);
    await store.set('agent.max_concurrent_agents', 8, 'tim', at);
    expect((await store.load()).get('agent.max_concurrent_agents')).toEqual({
      value: 8,
      updatedBy: 'tim',
      updatedAt: at,
    });
    await store.delete('agent.max_concurrent_agents', 'sam');
    expect((await store.load()).size).toBe(0);
    expect(await store.settingsHistory('agent.max_concurrent_agents')).toEqual([
      { value: 7, changedBy: 'tim' },
      { value: 8, changedBy: 'tim' },
      { value: null, changedBy: 'sam' },
    ]);
  });

  it('C-9 maps workspace keys back to issue ids', async () => {
    await store.runClaimed({
      runId: 'r1',
      issue: makeIssue({ id: '5', identifier: 'AB#5' }),
      attempt: null,
      agent: 'opencode',
      workspaceKey: 'AB_5-abc',
    });
    expect(await store.workspaceKeys()).toEqual(new Map([['AB_5-abc', '5']]));
  });

  it('C-5 audit writes fail open when the database is unreachable', async () => {
    const broken = PostgresStore.fromConnectionString('postgres://u:p@127.0.0.1:1/db', { timeoutMs: 500 });
    await expect(
      broken.runClaimed({ runId: 'x', issue: makeIssue(), attempt: null, agent: 'a', workspaceKey: 'k' }),
    ).resolves.toBeUndefined();
    await expect(broken.loadRetries()).resolves.toEqual([]);
    await expect(broken.load()).rejects.toThrow();
    await broken.close();
  });
});

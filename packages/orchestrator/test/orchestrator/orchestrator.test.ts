import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunnerError } from '../../src/runner/types.js';
import { TrackerError } from '../../src/tracker/types.js';
import { makeIssue } from '../fixtures/issues.js';
import { harness } from './harness.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

async function started(h: ReturnType<typeof harness>) {
  await h.orchestrator.start();
  await h.flush();
  return h;
}

describe('dispatch (§8.1–§8.3)', () => {
  it('§16.1 startup dispatches eligible issues on an immediate tick', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    expect(h.executor.specs.map((s) => s.issue.id)).toEqual(['1']);
    expect(h.runner.prompts[0]!.prompt).toBe('Work on AB#1 attempt=');
  });

  it('§17.4 dispatch order is priority then oldest creation time', async () => {
    const h = await started(
      harness({
        maxConcurrent: 1,
        issues: [
          makeIssue({ id: 'late', priority: 2, created_at: '2026-02-01T00:00:00Z' }),
          makeIssue({ id: 'early', priority: 2, created_at: '2026-01-01T00:00:00Z' }),
        ],
      }),
    );
    expect(h.executor.specs.map((s) => s.issue.id)).toEqual(['early']);
  });

  it('§17.4 dispatchable=false issues are not eligible', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1', dispatchable: false })] }));
    expect(h.executor.specs).toHaveLength(0);
  });

  it('§17.4 required-label filtering is case-insensitive', async () => {
    const h = await started(
      harness({
        issues: [makeIssue({ id: '1', labels: ['CUMULUS'] }), makeIssue({ id: '2', labels: ['other'] })],
      }),
    );
    expect(h.executor.specs.map((s) => s.issue.id)).toEqual(['1']);
  });

  it('§8.2 non-active states are not dispatched', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1', state: 'Review' })] }));
    expect(h.executor.specs).toHaveLength(0);
  });

  it('C-6 respects the effective max concurrent runs', async () => {
    const h = await started(
      harness({ maxConcurrent: 2, issues: ['1', '2', '3'].map((id) => makeIssue({ id })) }),
    );
    expect(h.executor.specs).toHaveLength(2);
    h.setMaxConcurrent(3);
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.specs).toHaveLength(3);
  });

  it('§8.3 per-state limits cap dispatch by tracked state', async () => {
    const h = await started(
      harness({
        workflow: { agent: { max_concurrent_agents_by_state: { dev: 1 } } },
        issues: [
          makeIssue({ id: '1', state: 'Dev' }),
          makeIssue({ id: '2', state: 'Dev' }),
          makeIssue({ id: '3', state: 'Backlog' }),
        ],
      }),
    );
    expect(h.executor.specs.map((s) => s.issue.id).sort()).toEqual(['1', '3']);
  });

  it('§7.4 running issues are not dispatched twice across ticks', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.specs).toHaveLength(1);
  });

  it('§6.3 invalid dispatch config skips dispatch but still reconciles', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.tracker.upsert(makeIssue({ id: '1', state: 'Review' }));
    h.tracker.upsert(makeIssue({ id: '2' }));
    h.setWorkflowError('workflow_parse_error: bad yaml');
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.handles[0]!.killed).toBe(true);
    expect(h.executor.specs).toHaveLength(1);
    expect(h.orchestrator.snapshot().config_error).toContain('bad yaml');
  });

  it('§16.1 startup fails when dispatch config is invalid', async () => {
    const h = harness({ workflow: { runner: { command: '' } } });
    await expect(h.orchestrator.start()).rejects.toThrow(/runner.command/);
  });

  it('§14.2 candidate fetch failure skips the tick', async () => {
    const h = harness({ issues: [makeIssue({ id: '1' })] });
    h.tracker.failNext = new TrackerError('tracker_request', 'down');
    await started(h);
    expect(h.executor.specs).toHaveLength(0);
    expect(h.logs.some((l) => l.level === 'warn' && /candidate fetch failed/.test(l.msg))).toBe(true);
  });

  it('§8.1 schedules the next tick after polling.interval_ms', async () => {
    const h = await started(harness());
    h.tracker.upsert(makeIssue({ id: '9' }));
    await h.advance(29_000);
    expect(h.executor.specs).toHaveLength(0);
    await h.advance(1_000);
    expect(h.executor.specs).toHaveLength(1);
  });

  it('§13.7 refresh queues an immediate poll and coalesces repeats', async () => {
    const h = await started(harness());
    h.tracker.upsert(makeIssue({ id: '9' }));
    expect(h.orchestrator.requestRefresh()).toMatchObject({ queued: true, coalesced: false });
    expect(h.orchestrator.requestRefresh()).toMatchObject({ queued: true, coalesced: true });
    await h.flush();
    expect(h.executor.specs).toHaveLength(1);
  });
});

describe('worker attempts (§16.5)', () => {
  it('C-10 passes run identity, branch, workspace and MCP tools to the worker', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1', identifier: 'AB#1' })] }));
    const spec = h.executor.specs[0]!;
    expect(spec.runId).toBe('run-1');
    expect(spec.command).toBe('opencode acp --built');
    expect(spec.workspacePath).toMatch(/symphony_workspaces\/AB_1-[0-9a-f]{16}$/);
    expect(spec.env).toMatchObject({
      CUMULUS_RUN_ID: 'run-1',
      CUMULUS_INTERNAL_URL: 'http://cumulus.agents.svc:8080',
      CUMULUS_ISSUE_IDENTIFIER: 'AB#1',
    });
    expect(spec.env['CUMULUS_BRANCH']).toMatch(/^cumulus\/AB_1-/);
    expect(h.runner.options[0]!.cwd).toBe(spec.workspacePath);
    expect(h.runner.options[0]!.mcpServers).toEqual([
      {
        name: 'cumulus',
        url: 'http://cumulus.agents.svc:8080/mcp/runs/run-1',
        headers: { authorization: 'Bearer ${CUMULUS_RUN_TOKEN}' },
      },
    ]);
    // §15.3: the run token travels as a secret, never in plain env, args or headers.
    expect(h.runner.options[0]!.secrets).toEqual({ CUMULUS_RUN_TOKEN: 'token-1' });
    expect(spec.secretEnv).toEqual({ CUMULUS_RUN_TOKEN: 'token-1' });
    expect(spec.env).not.toHaveProperty('CUMULUS_RUN_TOKEN');
    expect(h.registry.registered).toEqual(['run-1']);
  });

  it('C-3 passes worker.env to workers without letting it override run identity', async () => {
    const h = await started(
      harness({
        workflow: {
          worker: { executor: 'local', env: { OPENCODE_CONFIG_CONTENT: '{}', CUMULUS_RUN_ID: 'evil' } },
        },
        issues: [makeIssue({ id: '1' })],
      }),
    );
    expect(h.executor.specs[0]!.env).toMatchObject({
      OPENCODE_CONFIG_CONTENT: '{}',
      CUMULUS_RUN_ID: 'run-1',
    });
  });

  it('§15.3 removes tracker secret env names from the worker environment', async () => {
    const h = harness({ issues: [makeIssue({ id: '1' })] });
    h.tracker.secretEnvironmentNames = () => ['ADO_PAT'];
    await started(h);
    expect(h.executor.specs[0]!.removeEnv).toContain('ADO_PAT');
  });

  it('§7.1 continues on the same thread with continuation guidance while the issue stays active', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.runner.complete('1');
    await h.flush();
    expect(h.runner.prompts).toHaveLength(2);
    expect(h.runner.prompts[1]!.threadId).toBe(h.runner.prompts[0]!.threadId);
    expect(h.runner.prompts[1]!.prompt).toContain('turn 2 of 20');
    expect(h.runner.prompts[1]!.prompt).not.toContain('Work on');
  });

  it('§16.5 stops after max_turns and exits normally', async () => {
    const h = await started(
      harness({ workflow: { agent: { max_turns: 2 } }, issues: [makeIssue({ id: '1' })] }),
    );
    h.runner.complete('1');
    await h.flush();
    h.runner.complete('1');
    await h.flush();
    expect(h.runner.prompts).toHaveLength(2);
    expect(h.orchestrator.snapshot().running).toHaveLength(0);
    expect(h.orchestrator.snapshot().retrying[0]).toMatchObject({ issue_id: '1', attempt: 1, error: null });
  });

  it('§17.4 normal exit schedules a 1s continuation retry (attempt 1) that releases a non-active issue', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.tracker.upsert(makeIssue({ id: '1', state: 'Review' }));
    h.runner.complete('1');
    await h.flush();
    expect(h.audit.ended.at(-1)).toMatchObject({ status: 'completed' });
    expect(h.orchestrator.snapshot().retrying[0]).toMatchObject({ attempt: 1 });
    await h.advance(1000);
    expect(h.orchestrator.snapshot().retrying).toHaveLength(0);
    expect(h.executor.specs).toHaveLength(1);
    // Released: a later return to an active state dispatches again.
    h.tracker.upsert(makeIssue({ id: '1', state: 'Dev' }));
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.specs).toHaveLength(2);
  });

  it('§12.3 continuation retry re-dispatches an active issue with attempt=1 and the full prompt', async () => {
    const h = await started(
      harness({ workflow: { agent: { max_turns: 1 } }, issues: [makeIssue({ id: '1' })] }),
    );
    h.runner.complete('1');
    await h.flush();
    await h.advance(1000);
    expect(h.executor.specs).toHaveLength(2);
    expect(h.runner.prompts[1]!.prompt).toBe('Work on AB#1 attempt=1');
  });

  it('§17.4 abnormal exit retries with 10s-based exponential backoff capped by config', async () => {
    const h = await started(
      harness({ workflow: { agent: { max_retry_backoff_ms: 15000 } }, issues: [makeIssue({ id: '1' })] }),
    );
    h.runner.fail('1');
    await h.flush();
    let retry = h.orchestrator.snapshot().retrying[0]!;
    expect(retry).toMatchObject({ attempt: 1, issue_identifier: 'AB#1' });
    expect(retry.error).toMatch(/turn_failed/);
    expect(Date.parse(retry.due_at) - Date.now()).toBe(10000);
    await h.advance(10000);
    expect(h.executor.specs).toHaveLength(2);
    h.runner.fail('1');
    await h.flush();
    retry = h.orchestrator.snapshot().retrying[0]!;
    expect(retry.attempt).toBe(2);
    expect(Date.parse(retry.due_at) - Date.now()).toBe(15000);
  });

  it('§12.4 prompt render failure fails the attempt and retries', async () => {
    const h = await started(harness({ prompt: '{{ nope }}', issues: [makeIssue({ id: '1' })] }));
    expect(h.orchestrator.snapshot().retrying[0]!.error).toMatch(/template_render_error/);
    expect(h.executor.handles[0]!.killed).toBe(true);
  });

  it('§16.4 executor start failure schedules a retry', async () => {
    const h = harness({ issues: [makeIssue({ id: '1' })] });
    h.executor.failStart = new Error('quota exceeded');
    await started(h);
    expect(h.orchestrator.snapshot().retrying[0]).toMatchObject({ attempt: 1 });
    expect(h.orchestrator.snapshot().retrying[0]!.error).toMatch(/quota exceeded/);
  });

  it('§16.5 agent startup failure kills the worker and retries', async () => {
    const h = harness({ issues: [makeIssue({ id: '1' })] });
    h.runner.failStartup = new RunnerError('response_timeout', 'initialize timed out');
    await started(h);
    expect(h.executor.handles[0]!.killed).toBe(true);
    expect(h.orchestrator.snapshot().retrying[0]!.error).toMatch(/initialize timed out/);
  });

  it('§17.4 slot exhaustion requeues retries with an explicit reason', async () => {
    const h = await started(
      harness({ maxConcurrent: 1, workflow: { agent: { max_turns: 1 } }, issues: [makeIssue({ id: '1' })] }),
    );
    h.runner.complete('1');
    await h.flush();
    h.tracker.upsert(makeIssue({ id: '2', priority: 1 }));
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.specs.map((s) => s.issue.id)).toEqual(['1', '2']);
    await h.advance(1000);
    expect(h.orchestrator.snapshot().retrying[0]).toMatchObject({
      issue_id: '1',
      attempt: 2,
      error: 'no available orchestrator slots',
    });
  });

  it('§16.6 retry refresh failure requeues with the next attempt', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.runner.fail('1');
    await h.flush();
    h.tracker.failNext = new TrackerError('tracker_request', 'down');
    await h.advance(10000);
    expect(h.orchestrator.snapshot().retrying[0]).toMatchObject({
      issue_id: '1',
      issue_identifier: 'AB#1',
      attempt: 2,
      error: 'retry refresh failed',
    });
  });

  it('§16.6 retry for a vanished issue releases the claim', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.runner.fail('1');
    await h.flush();
    h.tracker.remove('1');
    await h.advance(10000);
    expect(h.orchestrator.snapshot().retrying).toHaveLength(0);
    expect(h.executor.specs).toHaveLength(1);
  });

  it('§8.4 retry that observes a terminal state cleans up and releases', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.runner.fail('1');
    await h.flush();
    h.tracker.upsert(makeIssue({ id: '1', state: 'Closed' }));
    await h.advance(10000);
    expect(h.janitor.cleaned).toEqual(['1']);
    expect(h.orchestrator.snapshot().retrying).toHaveLength(0);
  });
});

describe('worker robustness', () => {
  it('a worker that cannot be stopped is abandoned after a bounded wait and frees its slot', async () => {
    const h = harness({ issues: [makeIssue({ id: '1' })] });
    h.executor.configure = (handle) => (handle.stuck = true);
    await started(h);
    h.tracker.upsert(makeIssue({ id: '1', state: 'Closed' }));
    await h.orchestrator.tick();
    await h.flush();
    await h.advance(5 * 60_000);
    expect(h.orchestrator.snapshot().running).toHaveLength(0);
    expect(h.logs.some((l) => l.level === 'error' && /abandon/.test(l.msg))).toBe(true);
  });

  it('§16.5 waits for after_run (hook timeout) before stopping a worker that ended normally', async () => {
    const h = harness({
      workflow: { agent: { max_turns: 1 }, hooks: { timeout_ms: 60000 } },
      issues: [makeIssue({ id: '1' })],
    });
    h.executor.configure = (handle) => (handle.lingerMs = 45_000);
    await started(h);
    h.runner.complete('1');
    await h.flush();
    await h.advance(45_000);
    expect(h.executor.handles[0]!.killed).toBe(false);
    expect(h.audit.ended[0]).toMatchObject({ status: 'completed' });
  });

  it('C-3 stall detection does not count pod scheduling and image pull', async () => {
    const h = harness({
      workflow: { runner: { stall_timeout_ms: 60000 } },
      issues: [makeIssue({ id: '1' })],
    });
    let release!: () => void;
    h.executor.startGate = new Promise<void>((r) => (release = r));
    await started(h);
    await h.advance(150_000);
    release();
    await h.flush();
    expect(h.orchestrator.snapshot().running).toHaveLength(1);
    expect(h.executor.handles[0]!.killed).toBe(false);
  });

  it('C-3 reports the worker exit code and message when the worker dies', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.executor.handles[0]!.exit(70, 'cumulus: before_run hook failed (exit 1)');
    await h.flush();
    const error = h.orchestrator.snapshot().retrying[0]!.error!;
    expect(error).toContain('worker exit 70');
    expect(error).toContain('before_run hook failed');
  });

  it('C-3 allows hook time in the agent startup handshake', async () => {
    const h = await started(
      harness({
        workflow: { hooks: { timeout_ms: 60000 }, runner: { read_timeout_ms: 5000 } },
        issues: [makeIssue({ id: '1' })],
      }),
    );
    expect(h.runner.options[0]!.startupTimeoutMs).toBe(125_000);
  });
});

describe('reconciliation (§8.5)', () => {
  it('§17.4 reconciliation with no running issues makes no tracker refresh call', async () => {
    const h = await started(harness());
    const calls = h.tracker.providerCalls;
    await h.orchestrator.tick();
    await h.flush();
    expect(h.tracker.providerCalls).toBe(calls + 1); // candidate fetch only
  });

  it('§17.4 terminal state stops the agent, cleans up and does not retry', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.tracker.upsert(makeIssue({ id: '1', state: 'Closed' }));
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.handles[0]!.killed).toBe(true);
    expect(h.janitor.cleaned).toEqual(['1']);
    expect(h.orchestrator.snapshot().running).toHaveLength(0);
    expect(h.orchestrator.snapshot().retrying).toHaveLength(0);
    expect(h.audit.ended.at(-1)).toMatchObject({ status: 'canceled' });
  });

  it('§17.4 non-active state stops the agent without cleanup', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.tracker.upsert(makeIssue({ id: '1', state: 'Review' }));
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.handles[0]!.killed).toBe(true);
    expect(h.janitor.cleaned).toEqual([]);
    expect(h.orchestrator.snapshot().retrying).toHaveLength(0);
  });

  it('§7.1 a stopped issue is released and dispatched again when it becomes active', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.tracker.upsert(makeIssue({ id: '1', state: 'Review' }));
    await h.orchestrator.tick();
    await h.flush();
    h.tracker.upsert(makeIssue({ id: '1', state: 'Dev' }));
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.specs).toHaveLength(2);
  });

  it('§8.5 an active but no longer routable issue is stopped without cleanup', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.tracker.upsert(makeIssue({ id: '1', labels: [] }));
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.handles[0]!.killed).toBe(true);
    expect(h.janitor.cleaned).toEqual([]);
  });

  it('§16.3 an issue missing from the refresh is stopped without cleanup', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.tracker.remove('1');
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.handles[0]!.killed).toBe(true);
    expect(h.janitor.cleaned).toEqual([]);
  });

  it('§17.4 active-state refresh updates the running entry state', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1', state: 'Backlog' })] }));
    h.tracker.upsert(makeIssue({ id: '1', state: 'Dev' }));
    await h.orchestrator.tick();
    await h.flush();
    expect(h.orchestrator.snapshot().running[0]!.state).toBe('Dev');
  });

  it('§14.2 refresh failure keeps workers running', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.tracker.failNext = new TrackerError('tracker_request', 'down');
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.handles[0]!.killed).toBe(false);
    expect(h.orchestrator.snapshot().running).toHaveLength(1);
  });

  it('§17.4 stall detection kills stalled sessions and schedules a retry', async () => {
    const h = await started(
      harness({ workflow: { runner: { stall_timeout_ms: 60000 } }, issues: [makeIssue({ id: '1' })] }),
    );
    await h.advance(30000);
    h.runner.emit('1', { event: 'notification', message: 'still here' });
    await h.advance(30000); // tick at 60s: last event 30s ago, not stalled
    expect(h.executor.handles[0]!.killed).toBe(false);
    await h.advance(60000); // tick at 120s: 90s since last event
    expect(h.executor.handles[0]!.killed).toBe(true);
    expect(h.orchestrator.snapshot().retrying[0]!.error).toMatch(/stalled/);
  });

  it('§8.5 stall detection is disabled when stall_timeout_ms <= 0', async () => {
    const h = await started(
      harness({ workflow: { runner: { stall_timeout_ms: 0 } }, issues: [makeIssue({ id: '1' })] }),
    );
    await h.advance(600000);
    expect(h.executor.handles[0]!.killed).toBe(false);
  });
});

describe('observability (§13)', () => {
  it('§17.6 token aggregation is correct across repeated absolute updates', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.runner.emit('1', {
      event: 'notification',
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    });
    h.runner.emit('1', {
      event: 'notification',
      usage: { input_tokens: 150, output_tokens: 20, total_tokens: 170 },
    });
    h.runner.emit('1', {
      event: 'notification',
      usage: { input_tokens: 150, output_tokens: 20, total_tokens: 170 },
    });
    const snap = h.orchestrator.snapshot();
    expect(snap.running[0]!.tokens).toEqual({ input_tokens: 150, output_tokens: 20, total_tokens: 170 });
    expect(snap.codex_totals).toMatchObject({ input_tokens: 150, output_tokens: 20, total_tokens: 170 });
  });

  it('§13.3 snapshot reports running rows, retry rows, totals and rate limits', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1', url: 'https://x/1' })] }));
    h.runner.emit('1', { event: 'notification', message: 'hi', rate_limits: { remaining: 5 } });
    await h.advance(5000);
    const snap = h.orchestrator.snapshot();
    expect(snap.counts).toEqual({ running: 1, retrying: 0 });
    expect(snap.running[0]).toMatchObject({
      run_id: 'run-1',
      issue_id: '1',
      issue_identifier: 'AB#1',
      issue_url: 'https://x/1',
      session_id: 'thread-1-1',
      turn_count: 1,
      last_event: 'notification',
      last_message: 'hi',
      worker_name: 'pod-run-1',
    });
    expect(snap.codex_totals.seconds_running).toBe(5);
    expect(snap.rate_limits).toEqual({ remaining: 5 });
  });

  it('§13.1 logs carry issue_id and issue_identifier', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    const dispatched = h.logs.find((l) => /dispatch/.test(l.msg))!;
    expect(dispatched.obj).toMatchObject({ issue_id: '1', issue_identifier: 'AB#1', run_id: 'run-1' });
  });

  it('C-5 agent events are logged at info with run, issue and session ids (Loki)', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.runner.emit('1', { event: 'notification', message: 'editing main.tf' });
    const line = h.logs.find(
      (l) => l.level === 'info' && (l.obj as { event?: string }).event === 'notification',
    )!;
    expect(line.obj).toMatchObject({
      run_id: 'run-1',
      issue_id: '1',
      issue_identifier: 'AB#1',
      session_id: 'thread-1-1',
      message: 'editing main.tf',
    });
  });

  it('C-5 worker stderr lines are logged with the run id (Loki)', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.executor.handles[0]!.stderr.write('hook: cloning\nsecond line\n');
    await h.flush();
    const lines = h.logs.filter((l) => (l.obj as { stream?: string }).stream === 'stderr');
    expect(lines.map((l) => l.msg)).toEqual(['hook: cloning', 'second line']);
    expect(lines[0]!.obj).toMatchObject({ run_id: 'run-1', issue_identifier: 'AB#1' });
  });

  it('emits state and agent events to observers', async () => {
    const h = harness({ issues: [makeIssue({ id: '1' })] });
    const events: string[] = [];
    h.orchestrator.on('state', () => events.push('state'));
    h.orchestrator.on('agent_event', (e: { event: { event: string } }) => events.push(e.event.event));
    await started(h);
    expect(events).toContain('state');
    expect(events).toContain('session_started');
  });

  it('records issue details for the debug endpoint', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.runner.emit('1', { event: 'notification', message: 'step' });
    const d = h.orchestrator.issueDetails('AB#1')!;
    expect(d).toMatchObject({ issue_identifier: 'AB#1', issue_id: '1', status: 'running' });
    expect(d.recent_events.at(-1)).toMatchObject({ event: 'notification', message: 'step' });
    expect(h.orchestrator.issueDetails('AB#999')).toBeNull();
  });
});

describe('Cumulus lifecycle (C-4, C-5)', () => {
  it('C-4 startup marks stale runs, deletes orphans and sweeps before the first dispatch', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    const order = h.executor.calls.filter((c) => ['audit:markStale', 'deleteOrphans', 'start'].includes(c));
    expect(order).toEqual(['audit:markStale', 'deleteOrphans', 'start']);
    expect(h.janitor.sweeps).toBe(1);
  });

  it('C-5 writes the claimed row before creating the worker', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    const idx = (s: string) => h.executor.calls.indexOf(s);
    expect(idx('audit:claimed:1')).toBeGreaterThan(-1);
    expect(idx('audit:claimed:1')).toBeLessThan(idx('start'));
    expect(h.audit.log).toContain('transition:pod_created');
    expect(h.audit.log).toContain('transition:running');
  });

  it('C-5 persists retries and removes them when dispatched', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.runner.fail('1');
    await h.flush();
    expect(h.audit.retries.get('1')).toMatchObject({ attempt: 1, identifier: 'AB#1' });
    await h.advance(10000);
    expect(h.audit.retries.has('1')).toBe(false);
  });

  it('C-5 retry queue writes for an issue are applied in order', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    const save = h.audit.saveRetry.bind(h.audit);
    h.audit.saveRetry = async (e) => {
      await new Promise((r) => setTimeout(r, 20_000)); // slow database write
      await save(e);
    };
    h.runner.fail('1'); // schedules a retry (slow save)
    await h.flush();
    await h.advance(10_000); // retry fires and dispatches (fast delete)
    await h.advance(20_000);
    expect(h.executor.specs).toHaveLength(2);
    expect(h.audit.retries.has('1')).toBe(false);
  });

  it('C-5 restores persisted retries at startup with their remaining delay', async () => {
    const h = harness({ issues: [makeIssue({ id: '1' })] });
    await h.audit.saveRetry({
      issueId: '1',
      identifier: 'AB#1',
      attempt: 3,
      dueAt: new Date(Date.now() + 20000),
      error: 'x',
    });
    await started(h);
    expect(h.executor.specs).toHaveLength(0);
    expect(h.orchestrator.snapshot().retrying[0]).toMatchObject({ issue_id: '1', attempt: 3 });
    await h.advance(20000);
    expect(h.executor.specs).toHaveLength(1);
    expect(h.runner.prompts[0]!.prompt).toBe('Work on AB#1 attempt=3');
  });

  it('C-5 audit failures do not stop scheduling', async () => {
    const h = harness({ issues: [makeIssue({ id: '1' })] });
    h.audit.runClaimed = async () => {
      throw new Error('db down');
    };
    await started(h);
    expect(h.executor.specs).toHaveLength(1);
  });

  it('C-4 drain stops dispatch and lets running workers finish', async () => {
    const h = await started(
      harness({ workflow: { agent: { max_turns: 1 } }, issues: [makeIssue({ id: '1' })] }),
    );
    const drained = h.orchestrator.drain(60000);
    h.tracker.upsert(makeIssue({ id: '2' }));
    await h.orchestrator.tick();
    await h.flush();
    expect(h.executor.specs).toHaveLength(1);
    h.runner.complete('1');
    await h.flush();
    await drained;
    expect(h.executor.handles[0]!.killed).toBe(false);
    expect(h.orchestrator.snapshot().draining).toBe(true);
  });

  it('C-4 no dispatch when drain starts during the candidate fetch', async () => {
    const h = harness({ issues: [makeIssue({ id: '1' })] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = h.tracker.fetchIssuesByStates.bind(h.tracker);
    h.tracker.fetchIssuesByStates = async (states) => {
      await gate;
      return original(states);
    };
    await h.orchestrator.start();
    await h.flush();
    const drained = h.orchestrator.drain(1000);
    release();
    await h.flush();
    await drained;
    expect(h.executor.specs).toHaveLength(0);
  });

  it('C-4 no dispatch when drain starts during a retry refresh', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    h.runner.fail('1');
    await h.flush();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = h.tracker.fetchIssuesByIds.bind(h.tracker);
    h.tracker.fetchIssuesByIds = async (ids) => {
      await gate;
      return original(ids);
    };
    await h.advance(10000);
    const drained = h.orchestrator.drain(1000);
    release();
    await h.flush();
    await drained;
    expect(h.executor.specs).toHaveLength(1);
  });

  it('C-4 drain timeout stops remaining workers and marks them interrupted', async () => {
    const h = await started(harness({ issues: [makeIssue({ id: '1' })] }));
    const drained = h.orchestrator.drain(1000);
    await h.advance(1000);
    await drained;
    expect(h.executor.handles[0]!.killed).toBe(true);
    expect(h.audit.ended.at(-1)).toMatchObject({ status: 'interrupted' });
    expect(h.orchestrator.snapshot().retrying).toHaveLength(0);
  });
});

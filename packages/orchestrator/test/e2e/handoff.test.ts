import type { AgentEvent } from '@cumulus/shared';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/config.js';
import { LocalExecutor } from '../../src/executor/local.js';
import { buildInternalServer } from '../../src/http/internal.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { noopAudit } from '../../src/orchestrator/ports.js';
import { RunRegistryImpl } from '../../src/registry.js';
import { OpenCodeAcpRunner } from '../../src/runner/opencode-acp.js';
import { createAzureDevOpsTracker } from '../../src/tracker/azure-devops.js';
import { RecordingAudit, RecordingJanitor } from '../orchestrator/harness.js';
import { FakeAdo, adoItem } from '../tracker/ado-fake.js';

const AGENT = resolve(__dirname, 'fake-acp-agent.mjs');
let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

describe('end to end: dispatch → agent → MCP hand-off → release (C-2, C-3, C-11)', () => {
  it('runs a real ACP agent process that moves the card to Review, then stops dispatching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cumulus-e2e-'));
    const ado = new FakeAdo([adoItem(42, 'Dev', { 'System.Title': 'Rotate the cert' })]);
    const tracker = createAzureDevOpsTracker(
      {
        provider: { organization: 'adlibsoftware', project: 'AdlibCTP', team: 'DevOps', area_path: 'AdlibCTP\\DevOps', iteration_path: 'AdlibCTP\\Backlogs\\DevOps' },
        activeStates: ['Backlog', 'Dev', 'Test'],
        terminalStates: ['Closed'],
      },
      { env: {}, fetch: ado.fetch, token: async () => 't' },
    );
    const registry = new RunRegistryImpl();
    const internal = await buildInternalServer({ registry, gitTokens: null });
    const internalUrl = await internal.listen({ port: 0, host: '127.0.0.1' });
    cleanup.push(() => internal.close());

    const config = resolveConfig(
      {
        tracker: { kind: 'azure_devops', active_states: ['Backlog', 'Dev', 'Test'], terminal_states: ['Closed'], required_labels: ['cumulus'] },
        workspace: { root },
        worker: { executor: 'local' },
        runner: { kind: 'opencode', command: `node ${AGENT}` },
      },
      { workflowDir: root, env: {} },
    );
    const audit = new RecordingAudit();
    const events: AgentEvent[] = [];
    const orchestrator = new Orchestrator({
      workflow: { current: () => ({ config, promptTemplate: 'Fix {{ issue.title }} on {{ cumulus.branch }}', error: null }), refresh: async () => {} },
      trackerFor: () => tracker,
      runnerFor: () => new OpenCodeAcpRunner(),
      executorFor: () => new LocalExecutor(),
      audit,
      janitor: new RecordingJanitor(),
      registry,
      settings: { maxConcurrentAgents: (c) => c.agent.maxConcurrentAgents },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      internalUrl,
      newRunId: () => 'run-e2e',
      newToken: () => 'tok-e2e',
    });
    orchestrator.on('agent_event', (e: { event: AgentEvent }) => events.push(e.event));
    cleanup.push(async () => orchestrator.stop());

    await orchestrator.start();
    const deadline = Date.now() + 15_000;
    while (!audit.ended.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

    // The agent moved the card through the host-side tool; the orchestrator saw Review and ended normally.
    expect(ado.items.get(42)!.fields['System.BoardColumn']).toBe('Review');
    expect(audit.ended[0]).toMatchObject({ status: 'completed', tokens: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 } });
    expect(events.map((e) => e.message)).toContain('agent_message_chunk: tools=2 moved=true');
    expect(orchestrator.snapshot().codex_totals.total_tokens).toBe(1200);

    // The continuation retry finds the issue in a non-active column and releases it.
    await new Promise((r) => setTimeout(r, 1500));
    expect(orchestrator.snapshot().retrying).toHaveLength(0);
    expect(orchestrator.snapshot().running).toHaveLength(0);
  }, 30_000);
});

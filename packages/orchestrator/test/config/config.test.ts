import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, resolveConfig } from '../../src/config/config.js';

const ctx = { workflowDir: '/repo', env: {} as Record<string, string | undefined> };
const minimal = { tracker: { kind: 'memory', active_states: ['Dev'], terminal_states: ['Closed'] } };

describe('resolveConfig', () => {
  it('§17.1 applies upstream defaults when optional values are missing', () => {
    const c = resolveConfig(minimal, ctx);
    expect(c.polling.intervalMs).toBe(30000);
    expect(c.workspace.root).toBe(join(tmpdir(), 'symphony_workspaces'));
    expect(c.hooks).toEqual({
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60000,
    });
    expect(c.agent.maxTurns).toBe(20);
    expect(c.agent.maxRetryBackoffMs).toBe(300000);
    expect(c.agent.maxConcurrentAgentsByState).toEqual({});
    expect(c.tracker.provider).toEqual({});
    expect(c.tracker.requiredLabels).toEqual([]);
  });

  it('C-6 max_concurrent_agents defaults to 5', () => {
    expect(resolveConfig(minimal, ctx).agent.maxConcurrentAgents).toBe(5);
  });

  it('C-2 runner defaults to opencode with upstream timeout defaults', () => {
    const c = resolveConfig(minimal, ctx);
    expect(c.runner).toEqual({
      kind: 'opencode',
      command: 'opencode acp',
      model: null,
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000,
    });
  });

  it('C-2 claude-code runner gets its own default command', () => {
    const c = resolveConfig({ ...minimal, runner: { kind: 'claude-code' } }, ctx);
    expect(c.runner.command).toBe(
      'claude -p --input-format stream-json --output-format stream-json --verbose',
    );
  });

  it('§17.1 runner command is preserved as a shell command string', () => {
    const c = resolveConfig({ ...minimal, runner: { command: 'opencode acp --log-level $LEVEL ~/x' } }, ctx);
    expect(c.runner.command).toBe('opencode acp --log-level $LEVEL ~/x');
  });

  it('§17.1 tracker.provider preserves adapter-owned keys verbatim', () => {
    const c = resolveConfig({ tracker: { ...minimal.tracker, provider: { a: 1, nested: { b: 'x' } } } }, ctx);
    expect(c.tracker.provider).toEqual({ a: 1, nested: { b: 'x' } });
  });

  it('§17.1 ~ path expansion works for workspace.root', () => {
    const c = resolveConfig({ ...minimal, workspace: { root: '~/ws' } }, ctx);
    expect(c.workspace.root).toBe(join(homedir(), 'ws'));
  });

  it('§17.1 $VAR resolution works for path values', () => {
    const c = resolveConfig(
      { ...minimal, workspace: { root: '$WS_ROOT' } },
      { ...ctx, env: { WS_ROOT: '/var/ws' } },
    );
    expect(c.workspace.root).toBe('/var/ws');
  });

  it('§5.3.3 relative workspace.root resolves against the WORKFLOW.md directory', () => {
    const c = resolveConfig({ ...minimal, workspace: { root: 'ws' } }, ctx);
    expect(c.workspace.root).toBe('/repo/ws');
  });

  it('§17.1 per-state concurrency map normalizes keys and ignores invalid values', () => {
    const c = resolveConfig(
      {
        ...minimal,
        agent: { max_concurrent_agents_by_state: { ' Dev ': 2, Test: 0, Review: 'x', QA: 1.5 } },
      },
      ctx,
    );
    expect(c.agent.maxConcurrentAgentsByState).toEqual({ dev: 2 });
  });

  it('§5.3.4 invalid hooks.timeout_ms fails validation', () => {
    expect(() => resolveConfig({ ...minimal, hooks: { timeout_ms: -1 } }, ctx)).toThrow(ConfigError);
  });

  it('§5.3.5 invalid max_turns fails validation', () => {
    expect(() => resolveConfig({ ...minimal, agent: { max_turns: 0 } }, ctx)).toThrow(ConfigError);
  });

  it('§5.3 ignores unknown top-level keys', () => {
    expect(() => resolveConfig({ ...minimal, future_thing: { a: 1 } }, ctx)).not.toThrow();
  });

  it('C-3 worker defaults read POD_NAMESPACE and CUMULUS_WORKER_IMAGE', () => {
    const c = resolveConfig(minimal, {
      ...ctx,
      env: { POD_NAMESPACE: 'ns1', CUMULUS_WORKER_IMAGE: 'acr/agents/cumulus-worker:42' },
    });
    expect(c.worker).toMatchObject({
      executor: 'kubernetes',
      namespace: 'ns1',
      image: 'acr/agents/cumulus-worker:42',
      serviceAccount: 'cumulus-agent',
      envSecret: 'cumulus-agent-env',
      activeDeadlineSeconds: 14400,
      ttlSecondsAfterFinished: 3600,
    });
  });

  it('C-3 worker.env passes plain environment values to every worker', () => {
    const c = resolveConfig(
      { ...minimal, worker: { env: { OPENCODE_CONFIG_CONTENT: '{"model":"litellm/x"}' } } },
      ctx,
    );
    expect(c.worker.env).toEqual({ OPENCODE_CONFIG_CONTENT: '{"model":"litellm/x"}' });
    expect(resolveConfig(minimal, ctx).worker.env).toEqual({});
    expect(() => resolveConfig({ ...minimal, worker: { env: { A: 1 } } }, ctx)).toThrow(ConfigError);
  });

  it('C-3 worker namespace falls back to agents', () => {
    expect(resolveConfig(minimal, ctx).worker.namespace).toBe('agents');
  });

  it('C-4 drain timeout defaults to 300000', () => {
    expect(resolveConfig(minimal, ctx).shutdown.drainTimeoutMs).toBe(300000);
  });

  it('§13.7 server is disabled by default and binds loopback', () => {
    const c = resolveConfig(minimal, ctx);
    expect(c.server).toEqual({ port: null, host: '127.0.0.1' });
    expect(resolveConfig({ ...minimal, server: { port: 0 } }, ctx).server.port).toBe(0);
  });

  it('§5.3.1 tracker states are preserved with provider spelling', () => {
    const c = resolveConfig(minimal, ctx);
    expect(c.tracker.activeStates).toEqual(['Dev']);
    expect(c.tracker.terminalStates).toEqual(['Closed']);
  });

  it('§5.3.1 required_labels are trimmed and lowercased; blanks are kept so they match nothing', () => {
    const c = resolveConfig({ tracker: { ...minimal.tracker, required_labels: [' Cumulus ', ''] } }, ctx);
    expect(c.tracker.requiredLabels).toEqual(['cumulus', '']);
  });
});

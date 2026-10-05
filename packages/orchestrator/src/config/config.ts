import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export class ConfigError extends Error {
  readonly code = 'invalid_config';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type RunnerKind = 'opencode' | 'claude-code';
export type ExecutorKind = 'kubernetes' | 'local';

export interface ResourceRequirements {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

export interface ServiceConfig {
  tracker: {
    kind: string | null;
    provider: Record<string, unknown>;
    requiredLabels: string[];
    activeStates: string[];
    terminalStates: string[];
  };
  polling: { intervalMs: number };
  workspace: { root: string };
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxTurns: number;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Record<string, number>;
  };
  runner: {
    kind: RunnerKind;
    command: string;
    model: string | null;
    turnTimeoutMs: number;
    readTimeoutMs: number;
    stallTimeoutMs: number;
  };
  worker: {
    executor: ExecutorKind;
    namespace: string;
    image: string | null;
    serviceAccount: string;
    envSecret: string | null;
    activeDeadlineSeconds: number;
    ttlSecondsAfterFinished: number;
    resources: ResourceRequirements;
  };
  server: { port: number | null; host: string };
  shutdown: { drainTimeoutMs: number };
}

export interface ResolveContext {
  workflowDir: string;
  env: Record<string, string | undefined>;
}

export const RUNNER_COMMANDS: Record<RunnerKind, string> = {
  opencode: 'opencode acp',
  'claude-code': 'claude -p --input-format stream-json --output-format stream-json --verbose',
};

/** Built-in default for `agent.max_concurrent_agents` (C-6; upstream default is 10). */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 5;

const DEFAULT_RESOURCES: ResourceRequirements = {
  requests: { cpu: '1', memory: '2Gi' },
  limits: { cpu: '4', memory: '8Gi' },
};

type Raw = Record<string, unknown>;

function section(raw: Raw, key: string): Raw {
  const value = raw[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`${key} must be a map`);
  return value as Raw;
}

function int(obj: Raw, key: string, path: string, fallback: number, check: (n: number) => boolean): number {
  const value = obj[key];
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || !check(n)) {
    throw new ConfigError(`${path}.${key} must be a valid integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

function str(obj: Raw, key: string, path: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ConfigError(`${path}.${key} must be a string`);
  return value;
}

function stringList(obj: Raw, key: string, path: string): string[] {
  const value = obj[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ConfigError(`${path}.${key} must be a list of strings`);
  }
  return value as string[];
}

/** `$VAR` indirection for values that are exactly `$NAME` (§6.1). */
export function resolveEnvRef(value: string, env: Record<string, string | undefined>): string {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
  return match ? (env[match[1]!] ?? '') : value;
}

function resolvePath(value: string, ctx: ResolveContext): string {
  let p = resolveEnvRef(value, ctx.env);
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(ctx.workflowDir, p);
}

function enumValue<T extends string>(
  value: string | null,
  allowed: readonly T[],
  path: string,
  fallback: T,
): T {
  if (value === null) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${path} must be one of ${allowed.join(', ')}, got ${value}`);
  }
  return value as T;
}

const nonNegative = (n: number) => n >= 0;
const positive = (n: number) => n > 0;
const any = () => true;

export function resolveConfig(raw: Raw, ctx: ResolveContext): ServiceConfig {
  const tracker = section(raw, 'tracker');
  const polling = section(raw, 'polling');
  const workspace = section(raw, 'workspace');
  const hooks = section(raw, 'hooks');
  const agent = section(raw, 'agent');
  const runner = section(raw, 'runner');
  const worker = section(raw, 'worker');
  const server = section(raw, 'server');
  const shutdown = section(raw, 'shutdown');

  const byState: Record<string, number> = {};
  for (const [state, limit] of Object.entries(section(agent, 'max_concurrent_agents_by_state'))) {
    if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0) {
      byState[state.trim().toLowerCase()] = limit;
    }
  }

  const runnerKind = enumValue(
    str(runner, 'kind', 'runner'),
    ['opencode', 'claude-code'] as const,
    'runner.kind',
    'opencode',
  );
  const workspaceRoot = str(workspace, 'root', 'workspace');
  const image = str(worker, 'image', 'worker');

  const provider = tracker['provider'];
  if (
    provider !== undefined &&
    provider !== null &&
    (typeof provider !== 'object' || Array.isArray(provider))
  ) {
    throw new ConfigError('tracker.provider must be a map');
  }

  return {
    tracker: {
      kind: str(tracker, 'kind', 'tracker'),
      provider: (provider as Raw | undefined) ?? {},
      requiredLabels: stringList(tracker, 'required_labels', 'tracker').map((l) => l.trim().toLowerCase()),
      activeStates: stringList(tracker, 'active_states', 'tracker'),
      terminalStates: stringList(tracker, 'terminal_states', 'tracker'),
    },
    polling: { intervalMs: int(polling, 'interval_ms', 'polling', 30000, positive) },
    workspace: {
      root: workspaceRoot ? resolvePath(workspaceRoot, ctx) : join(tmpdir(), 'symphony_workspaces'),
    },
    hooks: {
      afterCreate: str(hooks, 'after_create', 'hooks'),
      beforeRun: str(hooks, 'before_run', 'hooks'),
      afterRun: str(hooks, 'after_run', 'hooks'),
      beforeRemove: str(hooks, 'before_remove', 'hooks'),
      timeoutMs: int(hooks, 'timeout_ms', 'hooks', 60000, positive),
    },
    agent: {
      maxConcurrentAgents: int(
        agent,
        'max_concurrent_agents',
        'agent',
        DEFAULT_MAX_CONCURRENT_AGENTS,
        nonNegative,
      ),
      maxTurns: int(agent, 'max_turns', 'agent', 20, positive),
      maxRetryBackoffMs: int(agent, 'max_retry_backoff_ms', 'agent', 300000, positive),
      maxConcurrentAgentsByState: byState,
    },
    runner: {
      kind: runnerKind,
      command: str(runner, 'command', 'runner') ?? RUNNER_COMMANDS[runnerKind],
      model: str(runner, 'model', 'runner'),
      turnTimeoutMs: int(runner, 'turn_timeout_ms', 'runner', 3600000, positive),
      readTimeoutMs: int(runner, 'read_timeout_ms', 'runner', 5000, positive),
      stallTimeoutMs: int(runner, 'stall_timeout_ms', 'runner', 300000, any),
    },
    worker: {
      executor: enumValue(
        str(worker, 'executor', 'worker'),
        ['kubernetes', 'local'] as const,
        'worker.executor',
        'kubernetes',
      ),
      namespace:
        resolveEnvRef(str(worker, 'namespace', 'worker') ?? '', ctx.env) ||
        ctx.env['POD_NAMESPACE'] ||
        'agents',
      image: (image ? resolveEnvRef(image, ctx.env) : ctx.env['CUMULUS_WORKER_IMAGE']) || null,
      serviceAccount: str(worker, 'service_account', 'worker') ?? 'cumulus-agent',
      envSecret:
        worker['env_secret'] === null ? null : (str(worker, 'env_secret', 'worker') ?? 'cumulus-agent-env'),
      activeDeadlineSeconds: int(worker, 'active_deadline_seconds', 'worker', 14400, positive),
      ttlSecondsAfterFinished: int(worker, 'ttl_seconds_after_finished', 'worker', 3600, nonNegative),
      resources: (worker['resources'] as ResourceRequirements | undefined) ?? DEFAULT_RESOURCES,
    },
    server: {
      port:
        server['port'] === undefined || server['port'] === null
          ? null
          : int(server, 'port', 'server', 0, nonNegative),
      host: str(server, 'host', 'server') ?? '127.0.0.1',
    },
    shutdown: { drainTimeoutMs: int(shutdown, 'drain_timeout_ms', 'shutdown', 300000, nonNegative) },
  };
}

import type { AgentEvent, Issue, TokenUsage } from '@cumulus/shared';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import { resolveConfig, type ServiceConfig } from '../../src/config/config.js';
import type { WorkerExecutor, WorkerExit, WorkerHandle, WorkerSpec } from '../../src/executor/types.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { AuditStore, PersistedRetry, WorkspaceJanitor } from '../../src/orchestrator/ports.js';
import {
  RunnerError,
  type AgentIo,
  type AgentRunner,
  type AgentSession,
  type SessionOptions,
  type TurnResult,
} from '../../src/runner/types.js';
import { MemoryTracker } from '../../src/tracker/memory.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeHandle implements WorkerHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly done = deferred<WorkerExit>();
  readonly exited = this.done.promise;
  killed = false;
  constructor(
    readonly name: string,
    readonly spec: WorkerSpec,
  ) {}
  async imageDigest() {
    return 'img@sha256:1';
  }
  async kill() {
    this.killed = true;
    this.done.resolve({ code: 143, reason: 'killed' });
  }
  exit(code = 0) {
    this.done.resolve({ code, reason: 'exited' });
  }
}

export class FakeExecutor implements WorkerExecutor {
  readonly kind = 'fake';
  specs: WorkerSpec[] = [];
  handles: FakeHandle[] = [];
  failStart: Error | null = null;
  orphansDeleted = 0;
  calls: string[] = [];
  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    this.calls.push('start');
    this.specs.push(spec);
    if (this.failStart) throw this.failStart;
    const h = new FakeHandle(`pod-${spec.runId}`, spec);
    this.handles.push(h);
    return h;
  }
  async deleteOrphans() {
    this.calls.push('deleteOrphans');
    this.orphansDeleted++;
    return ['old-pod'];
  }
  async listWorkers() {
    return this.handles
      .filter((h) => !h.killed)
      .map((h) => ({
        name: h.name,
        run_id: h.spec.runId,
        issue_identifier: h.spec.issue.identifier,
        phase: 'Running',
        created_at: null,
      }));
  }
}

/** Scripted agent: each turn waits for the test to call complete()/fail() for that issue. */
export class FakeRunner implements AgentRunner {
  readonly kind = 'opencode';
  prompts: { issueId: string; prompt: string; threadId: string }[] = [];
  sessions = 0;
  failStartup: Error | null = null;
  private turns = new Map<string, Deferred<TurnResult>>();
  private onEvents = new Map<string, (e: AgentEvent) => void>();
  options: SessionOptions[] = [];

  buildCommand(command: string) {
    return `${command} --built`;
  }

  async startSession(io: AgentIo, options: SessionOptions): Promise<AgentSession> {
    this.options.push(options);
    if (this.failStartup) throw this.failStartup;
    const handle = io as FakeHandle;
    const issueId = handle.spec.issue.id;
    const threadId = `thread-${++this.sessions}`;
    // Like real runners: a worker exit fails the pending turn (stream closed).
    void handle.exited.then(() => {
      const pending = this.turns.get(issueId);
      if (pending) {
        this.turns.delete(issueId);
        pending.reject(new RunnerError('port_exit', 'agent stream closed'));
      }
    });
    this.onEvents.set(issueId, options.onEvent);
    let turn = 0;
    return {
      threadId,
      runTurn: async (prompt: string) => {
        turn++;
        this.prompts.push({ issueId, prompt, threadId });
        options.onEvent({
          event: 'session_started',
          timestamp: new Date().toISOString(),
          session_id: `${threadId}-${turn}`,
        });
        const d = deferred<TurnResult>();
        this.turns.set(issueId, d);
        const result = await d.promise;
        return { ...result, turnId: `${threadId}-${turn}` };
      },
      // Like real agents: closing stdin ends the process.
      close: async () => handle.exit(0),
    };
  }

  emit(issueId: string, event: Partial<AgentEvent>) {
    this.onEvents.get(issueId)?.({ event: 'notification', timestamp: new Date().toISOString(), ...event });
  }

  hasTurn(issueId: string) {
    return this.turns.has(issueId);
  }

  complete(issueId: string, usage: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }) {
    const d = this.turns.get(issueId);
    if (!d) throw new Error(`no pending turn for ${issueId}`);
    this.turns.delete(issueId);
    this.emit(issueId, { event: 'turn_completed', usage });
    d.resolve({ turnId: '', usage });
  }

  fail(issueId: string, error: Error = new RunnerError('turn_failed', 'boom')) {
    const d = this.turns.get(issueId);
    if (!d) throw new Error(`no pending turn for ${issueId}`);
    this.turns.delete(issueId);
    d.reject(error);
  }
}

export class RecordingAudit implements AuditStore {
  log: string[] = [];
  retries = new Map<string, PersistedRetry>();
  ended: { runId: string; status: string; exitReason: string | null; tokens: TokenUsage }[] = [];
  constructor(private readonly onLog?: (entry: string) => void) {}
  private push(entry: string) {
    this.log.push(entry);
    this.onLog?.(entry);
  }
  async markStaleRunsInterrupted() {
    this.push('markStale');
  }
  async runClaimed(run: { runId: string; issue: Issue }) {
    // Simulate database latency so ordering assertions require the write to be awaited.
    for (let i = 0; i < 3; i++) await Promise.resolve();
    this.push(`claimed:${run.issue.id}`);
  }
  async runTransition(runId: string, status: string) {
    this.push(`transition:${status}`);
    void runId;
  }
  async runEnded(runId: string, status: string, detail: { exitReason: string | null; tokens: TokenUsage }) {
    this.push(`ended:${status}`);
    this.ended.push({ runId, status, ...detail });
  }
  async saveRetry(e: PersistedRetry) {
    this.retries.set(e.issueId, e);
  }
  async deleteRetry(id: string) {
    this.retries.delete(id);
  }
  async loadRetries() {
    return [...this.retries.values()];
  }
}

export class RecordingJanitor implements WorkspaceJanitor {
  cleaned: string[] = [];
  sweeps = 0;
  async cleanupIssue(issue: Issue) {
    this.cleaned.push(issue.id);
  }
  async sweep() {
    this.sweeps++;
  }
}

export interface HarnessOptions {
  issues?: Issue[];
  workflow?: Record<string, unknown>;
  prompt?: string;
  maxConcurrent?: number;
}

export function harness(opts: HarnessOptions = {}) {
  const tracker = new MemoryTracker(opts.issues ?? []);
  const executor = new FakeExecutor();
  const runner = new FakeRunner();
  const audit = new RecordingAudit((e) => executor.calls.push(`audit:${e}`));
  const janitor = new RecordingJanitor();
  const registry = {
    registered: [] as string[],
    unregistered: [] as string[],
    register(r: { runId: string }) {
      this.registered.push(r.runId);
    },
    unregister(id: string) {
      this.unregistered.push(id);
    },
  };
  const raw = {
    tracker: {
      kind: 'memory',
      active_states: ['Backlog', 'Dev', 'Test'],
      terminal_states: ['Closed'],
      required_labels: ['cumulus'],
    },
    polling: { interval_ms: 30000 },
    worker: { executor: 'local', image: 'img' },
    ...(opts.workflow ?? {}),
  };
  let config: ServiceConfig = resolveConfig(raw, { workflowDir: '/tmp', env: {} });
  let workflowError: string | null = null;
  let maxConcurrent = opts.maxConcurrent;
  let runCounter = 0;
  const logs: { level: string; msg: string; obj: object }[] = [];
  const log = (level: string) => (obj: object, msg: string) => logs.push({ level, msg, obj });

  const orchestrator = new Orchestrator({
    workflow: {
      current: () => ({
        config,
        promptTemplate: opts.prompt ?? 'Work on {{ issue.identifier }} attempt={{ attempt }}',
        error: workflowError,
      }),
      refresh: async () => {},
    },
    trackerFor: () => tracker,
    runnerFor: () => runner,
    executorFor: () => executor,
    audit,
    janitor,
    registry,
    settings: { maxConcurrentAgents: (c) => maxConcurrent ?? c.agent.maxConcurrentAgents },
    logger: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
    internalUrl: 'http://cumulus.agents.svc:8080',
    newRunId: () => `run-${++runCounter}`,
    newToken: () => `token-${runCounter}`,
  });

  return {
    orchestrator,
    tracker,
    executor,
    runner,
    audit,
    janitor,
    registry,
    logs,
    setConfig(patch: Record<string, unknown>) {
      config = resolveConfig({ ...raw, ...patch }, { workflowDir: '/tmp', env: {} });
    },
    setWorkflowError(e: string | null) {
      workflowError = e;
    },
    setMaxConcurrent(n: number) {
      maxConcurrent = n;
    },
    /** Let pending promise chains settle. */
    async flush() {
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
    },
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
    },
  };
}

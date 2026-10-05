import type {
  AgentEvent,
  Issue,
  RetryRow,
  RunningRow,
  RunStatus,
  StateSnapshot,
  TokenUsage,
} from '@cumulus/shared';
import { EventEmitter } from 'node:events';
import type { ServiceConfig } from '../config/config.js';
import type { WorkerExit, WorkerHandle } from '../executor/types.js';
import { continuationPrompt, renderPrompt } from '../prompt.js';
import { readLines } from '../runner/ndjson.js';
import type { AgentSession, McpServerSpec } from '../runner/types.js';
import type { Tracker } from '../tracker/types.js';
import { branchName, workspaceKey, workspacePath } from '../workspace.js';
import type { OrchestratorDeps, WorkflowSnapshot } from './ports.js';
import {
  CONTINUATION_DELAY_MS,
  failureBackoffMs,
  hasStateSlot,
  isActive,
  isRoutable,
  isTerminal,
  sortForDispatch,
  type StateRules,
} from './scheduling.js';

type StopReason = 'terminal' | 'inactive' | 'stalled' | 'drain';
type Outcome = { kind: 'normal' } | { kind: 'abnormal'; error: string };

interface RunningEntry {
  runId: string;
  issue: Issue;
  workspaceKey: string;
  attempt: number | null;
  startedAtMs: number;
  sessionId: string | null;
  turnCount: number;
  lastEvent: string | null;
  lastEventAtMs: number | null;
  lastMessage: string | null;
  tokens: TokenUsage;
  lastReported: TokenUsage;
  handle: WorkerHandle | null;
  stopReason: StopReason | null;
  /** Rejects when the run is stopped, so awaits on a wedged agent cannot hang the worker. */
  stopped: Promise<never>;
  abort: AbortController;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  url: string | null;
  attempt: number;
  dueAtMs: number;
  timer: NodeJS.Timeout | null;
  error: string | null;
}

interface IssueDebug {
  issueId: string;
  workspaceKey: string;
  restartCount: number;
  lastError: string | null;
  recentEvents: { at: string; event: string; message: string | null }[];
}

/** Environment names the orchestrator itself holds; never passed to agents (§15.3). */
const ORCHESTRATOR_SECRETS = [
  'CUMULUS_OIDC_CLIENT_SECRET',
  'CUMULUS_SESSION_SECRET',
  'CUMULUS_GITHUB_APP_PRIVATE_KEY',
  'CUMULUS_GITHUB_APP_ID',
];
/** Extra time beyond hooks.timeout_ms for a worker to exit after its session ends (after_run). */
const EXIT_MARGIN_MS = 30_000;
/** How long to wait for a killed worker before abandoning it. */
const KILL_WAIT_MS = 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const zero = (): TokenUsage => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });

function rules(config: ServiceConfig): StateRules {
  return config.tracker;
}

function describeError(err: unknown): string {
  const e = err as { code?: unknown; category?: unknown; message?: unknown } | null;
  if (e && typeof e === 'object' && typeof e.code === 'string') return `${e.code}: ${String(e.message)}`;
  if (e && typeof e === 'object' && typeof e.category === 'string')
    return `${e.category}: ${String(e.message)}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The single scheduling authority (§7). All state mutations happen on the event loop; every async
 * continuation re-checks claims before acting.
 */
export class Orchestrator extends EventEmitter {
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retries = new Map<string, RetryEntry>();
  private readonly completed = new Set<string>();
  private readonly details = new Map<string, IssueDebug>();
  private readonly workers = new Map<string, Promise<void>>();
  private totals = { ...zero(), endedSeconds: 0 };
  private rateLimits: unknown = null;
  private configError: string | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private tickInFlight: Promise<void> | null = null;
  private tickAgain = false;
  private refreshPending = false;
  private draining = false;
  private stopped = false;

  constructor(private readonly deps: OrchestratorDeps) {
    super();
  }

  // ---------------------------------------------------------------- lifecycle

  /** §16.1 + C-4 startup. Throws when the workflow is not dispatchable. */
  async start(): Promise<void> {
    const snap = this.deps.workflow.current();
    const invalid = this.validate(snap);
    if (invalid) {
      this.deps.logger.error({ error: invalid }, 'startup validation failed');
      throw new Error(invalid);
    }
    const { config } = snap;
    await this.safe('mark stale runs', () => this.deps.audit.markStaleRunsInterrupted());
    try {
      const orphans = await this.deps.executorFor(config).deleteOrphans();
      if (orphans.length > 0)
        this.deps.logger.info({ workers: orphans }, `deleted orphaned workers count=${orphans.length}`);
    } catch (err) {
      this.deps.logger.warn({ error: describeError(err) }, 'orphan cleanup failed');
    }
    for (const r of (await this.safe('load retries', () => this.deps.audit.loadRetries())) ?? []) {
      this.claimed.add(r.issueId);
      this.armRetry({
        issueId: r.issueId,
        identifier: r.identifier,
        url: null,
        attempt: r.attempt,
        dueAtMs: r.dueAt.getTime(),
        timer: null,
        error: r.error,
      });
    }
    void this.sweep(config);
    this.sweepTimer = setInterval(
      () => void this.sweep(this.deps.workflow.current().config),
      SWEEP_INTERVAL_MS,
    );
    this.scheduleTick(0);
  }

  private async sweep(config: ServiceConfig): Promise<void> {
    try {
      await this.deps.janitor.sweep(this.deps.trackerFor(config), config);
    } catch (err) {
      this.deps.logger.warn({ error: describeError(err) }, 'workspace sweep failed');
    }
  }

  /** C-4: stop dispatching, wait for running workers, then stop the rest. */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const r of this.retries.values()) if (r.timer) clearTimeout(r.timer);
    this.retries.clear();
    this.notify();
    this.deps.logger.info({ running: this.running.size, timeout_ms: timeoutMs }, 'drain started');
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>(
      (resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs)),
    );
    const result = await Promise.race([this.allWorkersDone(), timedOut]);
    clearTimeout(timer);
    if (result === 'timeout') {
      this.deps.logger.warn({ running: this.running.size }, 'drain timeout; stopping remaining workers');
      for (const entry of this.running.values()) this.stopRun(entry, 'drain');
      await this.allWorkersDone();
    }
    this.deps.logger.info({}, 'drain complete');
  }

  private async allWorkersDone(): Promise<'done'> {
    while (this.workers.size > 0) await Promise.allSettled([...this.workers.values()]);
    return 'done';
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const r of this.retries.values()) if (r.timer) clearTimeout(r.timer);
  }

  get isDraining(): boolean {
    return this.draining;
  }

  // ---------------------------------------------------------------- ticks

  private scheduleTick(delayMs: number): void {
    if (this.stopped || this.draining) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      void this.tick();
    }, delayMs);
  }

  /** §13.7 `POST /api/v1/refresh`. */
  requestRefresh(): { queued: boolean; coalesced: boolean } {
    if (this.refreshPending) return { queued: true, coalesced: true };
    this.refreshPending = true;
    this.scheduleTick(0);
    return { queued: true, coalesced: false };
  }

  /** One poll-and-dispatch tick (§16.2). Concurrent calls coalesce into one follow-up tick. */
  async tick(): Promise<void> {
    if (this.tickInFlight) {
      this.tickAgain = true;
      return this.tickInFlight;
    }
    this.refreshPending = false;
    this.tickInFlight = this.runTick().finally(() => {
      this.tickInFlight = null;
      if (this.tickAgain) {
        this.tickAgain = false;
        this.scheduleTick(0);
      } else {
        this.scheduleTick(this.deps.workflow.current().config.polling.intervalMs);
      }
    });
    return this.tickInFlight;
  }

  private async runTick(): Promise<void> {
    await this.deps.workflow.refresh().catch(() => {});
    const snap = this.deps.workflow.current();
    const { config } = snap;
    await this.reconcile(config);

    const invalid = this.validate(snap);
    this.configError = invalid;
    if (invalid) {
      this.deps.logger.error({ error: invalid }, 'dispatch validation failed; skipping dispatch');
      this.notify();
      return;
    }
    if (this.draining) {
      this.notify();
      return;
    }
    let issues: Issue[];
    try {
      issues = await this.deps.trackerFor(config).fetchIssuesByStates(config.tracker.activeStates);
    } catch (err) {
      this.deps.logger.warn({ error: describeError(err) }, 'candidate fetch failed; skipping tick');
      this.notify();
      return;
    }
    for (const issue of sortForDispatch(issues)) {
      if (!this.hasGlobalSlot(config)) break;
      if (this.eligible(issue, config)) this.dispatch(issue, null, snap);
    }
    this.notify();
  }

  /** §6.3 dispatch preflight. Returns an operator-visible error or null. */
  private validate(snap: WorkflowSnapshot): string | null {
    if (snap.error) return snap.error;
    const { config } = snap;
    if (!config.tracker.kind) return 'tracker.kind is required';
    try {
      this.deps.trackerFor(config);
    } catch (err) {
      return describeError(err);
    }
    if (!config.runner.command.trim()) return 'runner.command must be a non-empty shell command';
    try {
      this.deps.runnerFor(config.runner.kind);
    } catch (err) {
      return describeError(err);
    }
    if (config.worker.executor === 'kubernetes' && !config.worker.image) {
      return 'worker.image (or CUMULUS_WORKER_IMAGE) is required for the kubernetes executor';
    }
    return null;
  }

  private hasGlobalSlot(config: ServiceConfig): boolean {
    return this.running.size < this.deps.settings.maxConcurrentAgents(config);
  }

  private hasSlotFor(issue: Issue, config: ServiceConfig): boolean {
    const runningIssues = [...this.running.values()].map((e) => e.issue);
    return (
      this.hasGlobalSlot(config) &&
      hasStateSlot(
        issue.state,
        runningIssues,
        config.agent.maxConcurrentAgentsByState,
        this.deps.settings.maxConcurrentAgents(config),
      )
    );
  }

  /** §8.2 candidate eligibility. */
  private eligible(issue: Issue, config: ServiceConfig): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (!isActive(issue, rules(config)) || !isRoutable(issue, rules(config))) return false;
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) return false;
    return this.hasSlotFor(issue, config);
  }

  // ---------------------------------------------------------------- reconciliation

  /** §8.5 / §16.3 */
  private async reconcile(config: ServiceConfig): Promise<void> {
    const stallMs = config.runner.stallTimeoutMs;
    if (stallMs > 0) {
      const now = Date.now();
      for (const entry of this.running.values()) {
        // C-3: pod scheduling and image pull are bounded by the executor's start timeout, not stall.
        if (!entry.handle) continue;
        const last = entry.lastEventAtMs ?? entry.startedAtMs;
        if (now - last > stallMs) this.stopRun(entry, 'stalled');
      }
    }
    const ids = [...this.running.values()].filter((e) => !e.stopReason).map((e) => e.issue.id);
    if (ids.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.deps.trackerFor(config).fetchIssuesByIds(ids);
    } catch (err) {
      this.deps.logger.debug({ error: describeError(err) }, 'running-state refresh failed; keeping workers');
      return;
    }
    const seen = new Set<string>();
    for (const issue of refreshed) {
      seen.add(issue.id);
      const entry = this.running.get(issue.id);
      if (!entry || entry.stopReason) continue;
      if (isTerminal(issue, rules(config))) {
        entry.issue = issue;
        this.stopRun(entry, 'terminal');
        void this.cleanup(issue, entry.workspaceKey, config);
      } else if (isActive(issue, rules(config)) && isRoutable(issue, rules(config))) {
        entry.issue = issue;
      } else {
        entry.issue = issue;
        this.stopRun(entry, 'inactive');
      }
    }
    for (const id of ids) {
      const entry = this.running.get(id);
      if (!seen.has(id) && entry && !entry.stopReason) this.stopRun(entry, 'inactive');
    }
  }

  private stopRun(entry: RunningEntry, reason: StopReason): void {
    if (entry.stopReason) return;
    entry.stopReason = reason;
    entry.abort.abort();
    this.deps.logger.info(this.ctx(entry, { reason }), `stopping worker reason=${reason}`);
    entry.handle
      ?.kill()
      .catch((err: unknown) =>
        this.deps.logger.warn(this.ctx(entry, { error: describeError(err) }), 'worker kill failed'),
      );
  }

  private async cleanup(issue: Issue, key: string, config: ServiceConfig): Promise<void> {
    try {
      await this.deps.janitor.cleanupIssue(issue, key, config);
    } catch (err) {
      this.deps.logger.warn(
        { issue_id: issue.id, issue_identifier: issue.identifier, error: describeError(err) },
        'terminal cleanup failed',
      );
    }
  }

  // ---------------------------------------------------------------- dispatch + worker

  /** §16.4. Synchronously claims the issue before any await. */
  private dispatch(issue: Issue, attempt: number | null, snap: WorkflowSnapshot): void {
    if (this.draining || this.stopped) return;
    const key = workspaceKey(issue.identifier);
    const abort = new AbortController();
    const stopped = new Promise<never>((_, reject) =>
      abort.signal.addEventListener('abort', () => reject(new Error(`stopped (${entry.stopReason})`))),
    );
    stopped.catch(() => {});
    const entry: RunningEntry = {
      runId: this.deps.newRunId(),
      issue,
      workspaceKey: key,
      attempt,
      startedAtMs: Date.now(),
      sessionId: null,
      turnCount: 0,
      lastEvent: null,
      lastEventAtMs: null,
      lastMessage: null,
      tokens: zero(),
      lastReported: zero(),
      handle: null,
      stopReason: null,
      stopped,
      abort,
    };
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    this.clearRetry(issue.id);
    const debug = this.debugFor(issue, key);
    if (attempt !== null) debug.restartCount++;
    this.deps.logger.info(this.ctx(entry, { attempt }), `dispatch outcome=started attempt=${attempt ?? 0}`);
    const done = this.runWorker(entry, snap)
      .then((outcome) => this.onWorkerExit(entry, outcome, snap.config))
      .catch((err: unknown) =>
        this.deps.logger.error(this.ctx(entry, { error: describeError(err) }), 'worker bookkeeping failed'),
      )
      .finally(() => this.workers.delete(entry.runId));
    this.workers.set(entry.runId, done);
    this.notify();
  }

  /** §16.5 worker attempt. Never throws. */
  private async runWorker(entry: RunningEntry, snap: WorkflowSnapshot): Promise<Outcome> {
    const { config, promptTemplate } = snap;
    let tracker: Tracker;
    try {
      tracker = this.deps.trackerFor(config);
    } catch (err) {
      return { kind: 'abnormal', error: describeError(err) };
    }
    const runner = this.deps.runnerFor(config.runner.kind);
    const executor = this.deps.executorFor(config);
    const token = this.deps.newToken();
    const branch = branchName(entry.workspaceKey);
    const mcpServers: McpServerSpec[] = this.deps.internalUrl
      ? [
          {
            name: 'cumulus',
            url: `${this.deps.internalUrl}/mcp/runs/${entry.runId}`,
            headers: { authorization: `Bearer ${token}` },
          },
        ]
      : [];

    await this.safe('run claimed', () =>
      this.deps.audit.runClaimed({
        runId: entry.runId,
        issue: entry.issue,
        attempt: entry.attempt,
        agent: config.runner.kind,
        workspaceKey: entry.workspaceKey,
      }),
    );
    if (entry.stopReason) return { kind: 'abnormal', error: `stopped before start (${entry.stopReason})` };

    this.deps.registry.register({ runId: entry.runId, token, issue: entry.issue, tracker });
    let session: AgentSession | null = null;
    let outcome: Outcome = { kind: 'normal' };
    try {
      const path = workspacePath(config.workspace.root, entry.workspaceKey);
      const env: Record<string, string> = {
        ...config.worker.env,
        CUMULUS_RUN_ID: entry.runId,
        CUMULUS_RUN_TOKEN: token,
        CUMULUS_ISSUE_IDENTIFIER: entry.issue.identifier,
        CUMULUS_BRANCH: branch,
      };
      if (this.deps.internalUrl) env['CUMULUS_INTERNAL_URL'] = this.deps.internalUrl;
      entry.handle = await executor.start({
        runId: entry.runId,
        issue: entry.issue,
        workspaceRoot: config.workspace.root,
        workspacePath: path,
        command: runner.buildCommand(config.runner.command, { mcpServers, model: config.runner.model }),
        env,
        removeEnv: [...new Set([...tracker.secretEnvironmentNames(), ...ORCHESTRATOR_SECRETS])],
        hooks: {
          afterCreate: config.hooks.afterCreate,
          beforeRun: config.hooks.beforeRun,
          afterRun: config.hooks.afterRun,
          timeoutMs: config.hooks.timeoutMs,
        },
      });
      // Stall detection starts once the worker is attached (C-3).
      entry.lastEventAtMs = Date.now();
      readLines(entry.handle.stderr, {
        maxLineBytes: 64 * 1024,
        onLine: (line) => this.deps.logger.info(this.ctx(entry, { stream: 'stderr' }), line),
      });
      if (entry.stopReason) throw new Error(`stopped (${entry.stopReason})`);
      const digest = await entry.handle.imageDigest().catch(() => null);
      await this.safe('pod created', () =>
        this.deps.audit.runTransition(entry.runId, 'pod_created', {
          workerName: entry.handle!.name,
          imageDigest: digest,
        }),
      );

      const guard = <T>(p: Promise<T>) => Promise.race([p, entry.stopped]);
      session = await guard(
        runner.startSession(entry.handle, {
          cwd: path,
          model: config.runner.model,
          mcpServers,
          readTimeoutMs: config.runner.readTimeoutMs,
          // In-pod hooks (after_create, before_run) run before the agent can answer (C-3).
          startupTimeoutMs: config.runner.readTimeoutMs + 2 * config.hooks.timeoutMs,
          turnTimeoutMs: config.runner.turnTimeoutMs,
          onEvent: (e) => this.onAgentEvent(entry, e),
        }),
      );
      await this.safe('running', () => this.deps.audit.runTransition(entry.runId, 'running'));

      const maxTurns = config.agent.maxTurns;
      let issue = entry.issue;
      for (let turn = 1; ; turn++) {
        const prompt =
          turn === 1
            ? await renderPrompt(promptTemplate, {
                issue,
                attempt: entry.attempt,
                cumulus: { branch, workspace_key: entry.workspaceKey, run_id: entry.runId },
              })
            : continuationPrompt(issue, turn, maxTurns);
        entry.turnCount = turn;
        await guard(session.runTurn(prompt, `${issue.identifier}: ${issue.title}`));
        const refreshed = await guard(
          tracker.fetchIssuesByIds([issue.id]).catch((err: unknown) => {
            throw new Error(`issue state refresh error: ${describeError(err)}`);
          }),
        );
        if (refreshed.length === 0) break;
        issue = refreshed[0]!;
        entry.issue = issue;
        if (!isActive(issue, rules(config)) || !isRoutable(issue, rules(config))) break;
        if (turn >= maxTurns) break;
      }
    } catch (err) {
      outcome = { kind: 'abnormal', error: describeError(err) };
    } finally {
      const exit = await this.finishWorker(entry, session, outcome, config.hooks.timeoutMs);
      this.deps.registry.unregister(entry.runId);
      // C-3: a dying worker explains itself (exit 70 + log tail for setup and hook failures).
      if (
        outcome.kind === 'abnormal' &&
        exit &&
        exit.reason !== 'killed' &&
        exit.code !== null &&
        exit.code !== 0
      ) {
        outcome = {
          kind: 'abnormal',
          error: `${outcome.error}; worker exit ${exit.code}${exit.message ? `: ${exit.message}` : ''}`,
        };
      }
    }
    return outcome;
  }

  /**
   * Ends the session and waits for the worker to exit (so after_run can run). Stragglers are killed;
   * a worker that still does not exit is abandoned so its slot and claim are released.
   */
  private async finishWorker(
    entry: RunningEntry,
    session: AgentSession | null,
    outcome: Outcome,
    hookTimeoutMs: number,
  ): Promise<WorkerExit | null> {
    const handle = entry.handle;
    const kill = async () => {
      try {
        await handle?.kill();
      } catch (err) {
        this.deps.logger.warn(this.ctx(entry, { error: describeError(err) }), 'worker kill failed');
      }
    };
    const waitExit = async (ms: number): Promise<WorkerExit | null> => {
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        handle!.exited,
        new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms))),
      ]);
      clearTimeout(timer);
      return result;
    };
    await session?.close().catch(() => {});
    if (!handle) return null;
    if (outcome.kind !== 'normal' || entry.stopReason) await kill();
    let exit = await waitExit(outcome.kind === 'normal' ? hookTimeoutMs + EXIT_MARGIN_MS : KILL_WAIT_MS);
    if (exit) return exit;
    await kill();
    exit = await waitExit(KILL_WAIT_MS);
    if (!exit)
      this.deps.logger.error(this.ctx(entry, { worker: handle.name }), 'worker did not exit; abandoning it');
    return exit;
  }

  private onAgentEvent(entry: RunningEntry, e: AgentEvent): void {
    entry.lastEvent = e.event;
    entry.lastEventAtMs = Date.now();
    if (e.message !== undefined) entry.lastMessage = e.message;
    if (e.session_id) entry.sessionId = e.session_id;
    if (e.usage) {
      const delta = {
        input_tokens: Math.max(e.usage.input_tokens - entry.lastReported.input_tokens, 0),
        output_tokens: Math.max(e.usage.output_tokens - entry.lastReported.output_tokens, 0),
        total_tokens: Math.max(e.usage.total_tokens - entry.lastReported.total_tokens, 0),
      };
      this.totals.input_tokens += delta.input_tokens;
      this.totals.output_tokens += delta.output_tokens;
      this.totals.total_tokens += delta.total_tokens;
      entry.lastReported = { ...e.usage };
      entry.tokens = { ...e.usage };
    }
    if (e.rate_limits !== undefined) this.rateLimits = e.rate_limits;
    const debug = this.details.get(entry.issue.identifier);
    if (debug) {
      debug.recentEvents.push({ at: e.timestamp, event: e.event, message: e.message ?? null });
      if (debug.recentEvents.length > 50) debug.recentEvents.shift();
    }
    // Full agent event stream to stdout for Loki (C-5); one line per event, tagged with the run.
    this.deps.logger.info(
      this.ctx(entry, { session_id: entry.sessionId, event: e.event, message: e.message, usage: e.usage }),
      `agent event=${e.event}`,
    );
    this.emit('agent_event', { run_id: entry.runId, issue_identifier: entry.issue.identifier, event: e });
  }

  /** §16.6 */
  private async onWorkerExit(entry: RunningEntry, outcome: Outcome, config: ServiceConfig): Promise<void> {
    this.running.delete(entry.issue.id);
    this.totals.endedSeconds += (Date.now() - entry.startedAtMs) / 1000;
    const tokens = { ...entry.tokens };
    const debug = this.details.get(entry.issue.identifier);
    const end = (status: RunStatus, reason: string | null) =>
      this.safe('run ended', () =>
        this.deps.audit.runEnded(entry.runId, status, { exitReason: reason, tokens }),
      );

    if (entry.stopReason === 'terminal' || entry.stopReason === 'inactive' || entry.stopReason === 'drain') {
      this.claimed.delete(entry.issue.id);
      await end(entry.stopReason === 'drain' ? 'interrupted' : 'canceled', `stopped: ${entry.stopReason}`);
      this.deps.logger.info(this.ctx(entry), `worker exit outcome=stopped reason=${entry.stopReason}`);
    } else if (entry.stopReason === 'stalled' || outcome.kind === 'abnormal') {
      const error =
        entry.stopReason === 'stalled'
          ? 'stalled: no agent activity within stall_timeout_ms'
          : (outcome as { error: string }).error;
      if (debug) debug.lastError = error;
      await end('failed', error);
      const attempt = (entry.attempt ?? 0) + 1;
      this.deps.logger.warn(
        this.ctx(entry, { error }),
        `worker exit outcome=failed retry_attempt=${attempt}`,
      );
      this.scheduleRetry(
        entry.issue,
        attempt,
        `worker exited: ${error}`,
        failureBackoffMs(attempt, config.agent.maxRetryBackoffMs),
      );
    } else {
      this.completed.add(entry.issue.id);
      await end('completed', null);
      this.deps.logger.info(this.ctx(entry), 'worker exit outcome=completed');
      this.scheduleRetry(entry.issue, 1, null, CONTINUATION_DELAY_MS);
    }
    this.notify();
  }

  // ---------------------------------------------------------------- retries

  private scheduleRetry(
    issue: Pick<Issue, 'id' | 'identifier' | 'url'>,
    attempt: number,
    error: string | null,
    delayMs: number,
  ): void {
    const entry: RetryEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      attempt,
      dueAtMs: Date.now() + delayMs,
      timer: null,
      error,
    };
    void this.safe('save retry', () =>
      this.deps.audit.saveRetry({
        issueId: issue.id,
        identifier: issue.identifier,
        attempt,
        dueAt: new Date(entry.dueAtMs),
        error,
      }),
    );
    if (this.draining) return;
    this.armRetry(entry);
  }

  private armRetry(entry: RetryEntry): void {
    const existing = this.retries.get(entry.issueId);
    if (existing?.timer) clearTimeout(existing.timer);
    entry.timer = setTimeout(
      () => void this.onRetryTimer(entry.issueId),
      Math.max(entry.dueAtMs - Date.now(), 0),
    );
    this.retries.set(entry.issueId, entry);
    this.notify();
  }

  private clearRetry(issueId: string): void {
    const existing = this.retries.get(issueId);
    if (existing?.timer) clearTimeout(existing.timer);
    if (existing) this.retries.delete(issueId);
    void this.safe('delete retry', () => this.deps.audit.deleteRetry(issueId));
  }

  private release(issueId: string): void {
    this.claimed.delete(issueId);
    this.clearRetry(issueId);
    this.notify();
  }

  /** §16.6 on_retry_timer */
  private async onRetryTimer(issueId: string): Promise<void> {
    const retry = this.retries.get(issueId);
    if (!retry || this.draining || this.stopped) return;
    this.retries.delete(issueId);
    const snap = this.deps.workflow.current();
    const { config } = snap;
    let refreshed: Issue[];
    try {
      refreshed = await this.deps.trackerFor(config).fetchIssuesByIds([issueId]);
    } catch {
      this.scheduleRetry(
        { id: retry.issueId, identifier: retry.identifier, url: retry.url },
        retry.attempt + 1,
        'retry refresh failed',
        failureBackoffMs(retry.attempt + 1, config.agent.maxRetryBackoffMs),
      );
      return;
    }
    if (this.draining || this.stopped) return;
    const issue = refreshed.find((i) => i.id === issueId);
    if (!issue) return this.release(issueId);
    if (isTerminal(issue, rules(config))) {
      await this.cleanup(issue, workspaceKey(issue.identifier), config);
      return this.release(issueId);
    }
    if (!isActive(issue, rules(config)) || !isRoutable(issue, rules(config))) return this.release(issueId);
    if (this.running.has(issueId)) return;
    if (this.validate(snap) || !this.hasSlotFor(issue, config)) {
      this.scheduleRetry(
        issue,
        retry.attempt + 1,
        'no available orchestrator slots',
        failureBackoffMs(retry.attempt + 1, config.agent.maxRetryBackoffMs),
      );
      return;
    }
    this.dispatch(issue, retry.attempt, snap);
  }

  // ---------------------------------------------------------------- observability

  private ctx(entry: RunningEntry, extra: object = {}): object {
    return {
      run_id: entry.runId,
      issue_id: entry.issue.id,
      issue_identifier: entry.issue.identifier,
      ...extra,
    };
  }

  private debugFor(issue: Issue, key: string): IssueDebug {
    let d = this.details.get(issue.identifier);
    if (!d) {
      d = { issueId: issue.id, workspaceKey: key, restartCount: 0, lastError: null, recentEvents: [] };
      this.details.set(issue.identifier, d);
    }
    return d;
  }

  private async safe<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.deps.logger.warn({ error: describeError(err) }, `audit write failed: ${what}`);
      return undefined;
    }
  }

  private notify(): void {
    this.emit('state', this.snapshot());
  }

  /** §13.3 runtime snapshot. */
  snapshot(): StateSnapshot {
    const now = Date.now();
    const running: RunningRow[] = [...this.running.values()].map((e) => ({
      run_id: e.runId,
      issue_id: e.issue.id,
      issue_identifier: e.issue.identifier,
      issue_url: e.issue.url,
      state: e.issue.state,
      session_id: e.sessionId,
      turn_count: e.turnCount,
      last_event: e.lastEvent,
      last_message: e.lastMessage,
      started_at: new Date(e.startedAtMs).toISOString(),
      last_event_at: e.lastEventAtMs ? new Date(e.lastEventAtMs).toISOString() : null,
      worker_name: e.handle?.name ?? null,
      tokens: { ...e.tokens },
    }));
    const retrying: RetryRow[] = [...this.retries.values()].map((r) => ({
      issue_id: r.issueId,
      issue_identifier: r.identifier,
      issue_url: r.url,
      attempt: r.attempt,
      due_at: new Date(r.dueAtMs).toISOString(),
      error: r.error,
    }));
    const active = [...this.running.values()].reduce((s, e) => s + (now - e.startedAtMs) / 1000, 0);
    return {
      generated_at: new Date(now).toISOString(),
      counts: { running: running.length, retrying: retrying.length },
      running,
      retrying,
      codex_totals: {
        input_tokens: this.totals.input_tokens,
        output_tokens: this.totals.output_tokens,
        total_tokens: this.totals.total_tokens,
        seconds_running: Math.round((this.totals.endedSeconds + active) * 10) / 10,
      },
      rate_limits: this.rateLimits,
      draining: this.draining,
      config_error: this.configError,
    };
  }

  /** §13.7.2 `GET /api/v1/<issue_identifier>`. Null when unknown to this process. */
  issueDetails(identifier: string) {
    const d = this.details.get(identifier);
    if (!d) return null;
    const entry = this.running.get(d.issueId);
    const retry = this.retries.get(d.issueId);
    const row = this.snapshot().running.find((r) => r.issue_id === d.issueId) ?? null;
    return {
      issue_identifier: identifier,
      issue_id: d.issueId,
      status: entry ? 'running' : retry ? 'retrying' : 'idle',
      workspace: { key: d.workspaceKey, branch: branchName(d.workspaceKey) },
      attempts: {
        restart_count: d.restartCount,
        current_retry_attempt: retry?.attempt ?? entry?.attempt ?? null,
      },
      running: row,
      retry: retry
        ? { attempt: retry.attempt, due_at: new Date(retry.dueAtMs).toISOString(), error: retry.error }
        : null,
      recent_events: [...d.recentEvents],
      last_error: d.lastError,
      tracked: { claimed: this.claimed.has(d.issueId), completed: this.completed.has(d.issueId) },
    };
  }

  async listWorkers() {
    return this.deps.executorFor(this.deps.workflow.current().config).listWorkers();
  }
}

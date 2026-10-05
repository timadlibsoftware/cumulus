import type { Issue, RunStatus, TokenUsage } from '@cumulus/shared';
import type { ServiceConfig } from '../config/config.js';
import type { WorkerExecutor } from '../executor/types.js';
import type { AgentRunner } from '../runner/types.js';
import type { Tracker } from '../tracker/types.js';

/** The effective workflow as of now (§6.2). `error` is the last reload failure, if any. */
export interface WorkflowSnapshot {
  config: ServiceConfig;
  promptTemplate: string;
  error: string | null;
}

export interface WorkflowSource {
  current(): WorkflowSnapshot;
  /** Defensive re-validation before dispatch (§6.2). */
  refresh(): Promise<void>;
}

export interface PersistedRetry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAt: Date;
  error: string | null;
}

/**
 * C-5 audit trail. Implementations must fail open: they never throw and never block scheduling for
 * long. The orchestrator also guards every call.
 */
export interface AuditStore {
  markStaleRunsInterrupted(): Promise<void>;
  runClaimed(run: {
    runId: string;
    issue: Issue;
    attempt: number | null;
    agent: string;
    workspaceKey: string;
  }): Promise<void>;
  runTransition(
    runId: string,
    status: RunStatus,
    detail?: { workerName?: string; imageDigest?: string | null; message?: string },
  ): Promise<void>;
  runEnded(
    runId: string,
    status: RunStatus,
    detail: { exitReason: string | null; tokens: TokenUsage },
  ): Promise<void>;
  saveRetry(entry: PersistedRetry): Promise<void>;
  deleteRetry(issueId: string): Promise<void>;
  loadRetries(): Promise<PersistedRetry[]>;
}

/** C-9: replaces upstream workspace cleanup (branch deletion, local workspace removal). */
export interface WorkspaceJanitor {
  cleanupIssue(issue: Issue, workspaceKey: string, config: ServiceConfig): Promise<void>;
  /** Startup and daily sweep (§8.6 / C-9). */
  sweep(tracker: Tracker, config: ServiceConfig): Promise<void>;
}

/** C-11 per-run credentials and tool context served by the HTTP layer. */
export interface RunRegistry {
  register(run: { runId: string; token: string; issue: Issue; tracker: Tracker }): void;
  unregister(runId: string): void;
}

export interface SettingsProvider {
  /** C-6 precedence: UI override, then WORKFLOW.md, then built-in default. */
  maxConcurrentAgents(config: ServiceConfig, workflowRaw: unknown): number;
}

export interface OrchestratorDeps {
  workflow: WorkflowSource;
  trackerFor(config: ServiceConfig): Tracker;
  runnerFor(kind: string): AgentRunner;
  executorFor(config: ServiceConfig): WorkerExecutor;
  audit: AuditStore;
  janitor: WorkspaceJanitor;
  registry: RunRegistry;
  settings: { maxConcurrentAgents(config: ServiceConfig): number };
  logger: Logger;
  /** Base URL agent pods use to reach the orchestrator (MCP tools, git credentials). */
  internalUrl: string | null;
  newRunId(): string;
  newToken(): string;
}

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

export const noopAudit: AuditStore = {
  markStaleRunsInterrupted: async () => {},
  runClaimed: async () => {},
  runTransition: async () => {},
  runEnded: async () => {},
  saveRetry: async () => {},
  deleteRetry: async () => {},
  loadRetries: async () => [],
};

export const noopRegistry: RunRegistry = { register: () => {}, unregister: () => {} };

import type { Issue, WorkerRow } from '@cumulus/shared';
import type { AgentIo } from '../runner/types.js';

export interface WorkerHooks {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  timeoutMs: number;
}

export interface WorkerSpec {
  runId: string;
  issue: Issue;
  workspaceRoot: string;
  workspacePath: string;
  /** Full shell command, launched as `bash -lc <command>` in the workspace (§10.1). */
  command: string;
  env: Record<string, string>;
  /** Environment names that must not reach the agent (§15.3). */
  removeEnv: string[];
  hooks: WorkerHooks;
}

export interface WorkerExit {
  code: number | null;
  reason: 'exited' | 'killed' | 'failed';
  message?: string;
}

export interface WorkerHandle extends AgentIo {
  readonly name: string;
  readonly exited: Promise<WorkerExit>;
  imageDigest(): Promise<string | null>;
  kill(): Promise<void>;
}

/** C-3: where agent processes run. */
export interface WorkerExecutor {
  readonly kind: string;
  start(spec: WorkerSpec): Promise<WorkerHandle>;
  /** C-4: delete workers left behind by a previous orchestrator instance. Returns their names. */
  deleteOrphans(): Promise<string[]>;
  listWorkers(): Promise<WorkerRow[]>;
}

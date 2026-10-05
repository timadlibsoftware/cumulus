import type { Issue } from '@cumulus/shared';
import { timingSafeEqual } from 'node:crypto';
import type { RunRegistry } from './orchestrator/ports.js';
import type { Tracker } from './tracker/types.js';

export interface RegisteredRun {
  runId: string;
  token: string;
  issue: Issue;
  tracker: Tracker;
}

/** C-11: live runs and their per-run bearer secrets, used by the internal MCP and git-token endpoints. */
export class RunRegistryImpl implements RunRegistry {
  private readonly runs = new Map<string, RegisteredRun>();

  register(run: RegisteredRun): void {
    this.runs.set(run.runId, run);
  }

  unregister(runId: string): void {
    this.runs.delete(runId);
  }

  authenticate(runId: string, authorization: string | undefined): RegisteredRun | null {
    const run = this.runs.get(runId);
    const presented = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
    if (!run || !presented) return null;
    const a = Buffer.from(presented);
    const b = Buffer.from(run.token);
    return a.length === b.length && timingSafeEqual(a, b) ? run : null;
  }
}

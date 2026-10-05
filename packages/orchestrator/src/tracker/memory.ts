import type { Issue } from '@cumulus/shared';
import { unsupportedTool, type ToolResult, type ToolSpec, type Tracker } from './types.js';

/** In-memory tracker for tests and local development (`tracker.kind: memory`). */
export class MemoryTracker implements Tracker {
  readonly kind = 'memory';
  readonly issues = new Map<string, Issue>();
  providerCalls = 0;
  failNext: Error | null = null;

  constructor(issues: Issue[] = []) {
    for (const issue of issues) this.issues.set(issue.id, issue);
  }

  upsert(issue: Issue): void {
    this.issues.set(issue.id, issue);
  }

  remove(id: string): void {
    this.issues.delete(id);
  }

  private call(): void {
    this.providerCalls++;
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    this.call();
    const wanted = new Set(stateNames.map((s) => s.trim().toLowerCase()));
    return [...this.issues.values()].filter((i) => wanted.has(i.state.trim().toLowerCase()));
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    this.call();
    return [...new Set(issueIds)].flatMap((id) => {
      const issue = this.issues.get(id);
      return issue ? [issue] : [];
    });
  }

  secretEnvironmentNames(): string[] {
    return [];
  }

  agentToolSpecs(): ToolSpec[] {
    return [];
  }

  async executeAgentTool(name: string, _args: unknown, _context: { issue: Issue }): Promise<ToolResult> {
    return unsupportedTool(name);
  }
}

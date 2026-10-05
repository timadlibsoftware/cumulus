import type { Issue } from '@cumulus/shared';

/** §8.4 */
export const CONTINUATION_DELAY_MS = 1000;

export interface StateRules {
  requiredLabels: string[];
  activeStates: string[];
  terminalStates: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

export function isTerminal(issue: Issue, rules: StateRules): boolean {
  return rules.terminalStates.map(norm).includes(norm(issue.state));
}

/** §8.2: in active_states and not in terminal_states. */
export function isActive(issue: Issue, rules: StateRules): boolean {
  return rules.activeStates.map(norm).includes(norm(issue.state)) && !isTerminal(issue, rules);
}

/** §8.2 `issue_routable`: adapter dispatchable and all required labels (blank labels match nothing). */
export function isRoutable(issue: Issue, rules: StateRules): boolean {
  if (!issue.dispatchable) return false;
  const labels = new Set(issue.labels.map(norm));
  return rules.requiredLabels.every((l) => norm(l) !== '' && labels.has(norm(l)));
}

function priorityBucket(p: number | null): number {
  return p !== null && p >= 1 && p <= 4 ? p : 5;
}

/** §8.2 dispatch order. */
export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = priorityBucket(a.priority);
    const pb = priorityBucket(b.priority);
    if (pa !== pb) return pa - pb;
    const ca = a.created_at ? Date.parse(a.created_at) : Infinity;
    const cb = b.created_at ? Date.parse(b.created_at) : Infinity;
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
}

/** §8.4 failure-driven retry delay. */
export function failureBackoffMs(attempt: number, maxBackoffMs: number): number {
  return Math.min(10000 * 2 ** Math.max(attempt - 1, 0), maxBackoffMs);
}

/** §8.3 per-state concurrency using the current tracked state of running issues. */
export function hasStateSlot(
  state: string,
  running: Issue[],
  byState: Record<string, number>,
  globalLimit: number,
): boolean {
  const limit = byState[norm(state)] ?? globalLimit;
  return running.filter((i) => norm(i.state) === norm(state)).length < limit;
}

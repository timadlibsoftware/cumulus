import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_DELAY_MS,
  failureBackoffMs,
  hasStateSlot,
  isActive,
  isRoutable,
  isTerminal,
  sortForDispatch,
} from '../../src/orchestrator/scheduling.js';
import { makeIssue } from '../fixtures/issues.js';

const tracker = { requiredLabels: ['cumulus'], activeStates: ['Backlog', 'Dev'], terminalStates: ['Closed'] };

describe('scheduling rules', () => {
  it('§8.2 sorts priority 1..4 first, then oldest created_at, then identifier', () => {
    const issues = [
      makeIssue({ id: 'a', identifier: 'B', priority: null, created_at: '2026-01-01T00:00:00Z' }),
      makeIssue({ id: 'b', identifier: 'A', priority: 7, created_at: '2025-01-01T00:00:00Z' }),
      makeIssue({ id: 'c', identifier: 'C', priority: 2, created_at: '2026-03-01T00:00:00Z' }),
      makeIssue({ id: 'd', identifier: 'D', priority: 2, created_at: '2026-02-01T00:00:00Z' }),
      makeIssue({ id: 'e', identifier: 'A', priority: 1, created_at: null }),
      makeIssue({ id: 'f', identifier: 'Z', priority: null, created_at: null }),
      makeIssue({ id: 'g', identifier: 'Y', priority: null, created_at: null }),
    ];
    expect(sortForDispatch(issues).map((i) => i.id)).toEqual(['e', 'd', 'c', 'b', 'a', 'g', 'f']);
  });

  it('§4.2 compares states trimmed and case-insensitively', () => {
    expect(isActive(makeIssue({ state: ' dev ' }), tracker)).toBe(true);
    expect(isTerminal(makeIssue({ state: 'CLOSED' }), tracker)).toBe(true);
    expect(isActive(makeIssue({ state: 'Review' }), tracker)).toBe(false);
  });

  it('§8.2 a state listed as both active and terminal is not active', () => {
    expect(isActive(makeIssue({ state: 'Closed' }), { ...tracker, activeStates: ['Closed'] })).toBe(false);
  });

  it('§17.4 routable requires dispatchable and every required label, case-insensitively', () => {
    expect(isRoutable(makeIssue({ labels: ['cumulus'] }), tracker)).toBe(true);
    expect(isRoutable(makeIssue({ labels: ['cumulus'], dispatchable: false }), tracker)).toBe(false);
    expect(isRoutable(makeIssue({ labels: ['other'] }), tracker)).toBe(false);
    expect(isRoutable(makeIssue({ labels: ['cumulus'] }), { ...tracker, requiredLabels: [''] })).toBe(false);
  });

  it('§17.4 failure backoff is 10s-based exponential with the configured cap', () => {
    expect(failureBackoffMs(1, 300000)).toBe(10000);
    expect(failureBackoffMs(2, 300000)).toBe(20000);
    expect(failureBackoffMs(3, 300000)).toBe(40000);
    expect(failureBackoffMs(10, 300000)).toBe(300000);
    expect(failureBackoffMs(2, 15000)).toBe(15000);
    expect(CONTINUATION_DELAY_MS).toBe(1000);
  });

  it('§8.3 per-state limit falls back to the global limit', () => {
    const running = [makeIssue({ state: 'Dev' }), makeIssue({ state: 'dev' })];
    expect(hasStateSlot('Dev', running, { dev: 2 }, 10)).toBe(false);
    expect(hasStateSlot('Backlog', running, { dev: 2 }, 10)).toBe(true);
    expect(hasStateSlot('Dev', running, {}, 2)).toBe(false);
  });
});

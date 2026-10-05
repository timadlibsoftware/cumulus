import { describe, expect, it } from 'vitest';
import { RunRegistryImpl } from '../src/registry.js';
import { MemoryTracker } from '../src/tracker/memory.js';
import { makeIssue } from './fixtures/issues.js';

describe('RunRegistryImpl (C-11)', () => {
  it('authenticates a run by its bearer token', () => {
    const r = new RunRegistryImpl();
    r.register({ runId: 'r1', token: 'secret-token', issue: makeIssue(), tracker: new MemoryTracker() });
    expect(r.authenticate('r1', 'Bearer secret-token')?.issue.id).toBe('1');
    expect(r.authenticate('r1', 'Bearer wrong')).toBeNull();
    expect(r.authenticate('r1', 'secret-token')).toBeNull();
    expect(r.authenticate('r2', 'Bearer secret-token')).toBeNull();
    expect(r.authenticate('r1', undefined)).toBeNull();
  });

  it('forgets runs on unregister', () => {
    const r = new RunRegistryImpl();
    r.register({ runId: 'r1', token: 't', issue: makeIssue(), tracker: new MemoryTracker() });
    r.unregister('r1');
    expect(r.authenticate('r1', 'Bearer t')).toBeNull();
  });
});

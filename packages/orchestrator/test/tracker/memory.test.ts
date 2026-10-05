import { MemoryTracker } from '../../src/tracker/memory.js';
import { trackerContract } from '../contracts/tracker.contract.js';
import { makeIssue } from '../fixtures/issues.js';

trackerContract(
  'memory',
  async (issues) => {
    const tracker = new MemoryTracker(issues);
    return { tracker, providerCalls: () => tracker.providerCalls };
  },
  (id, state) => makeIssue({ id, state }),
);

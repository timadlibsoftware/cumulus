import type { ServiceConfig } from '../config/config.js';
import { createAzureDevOpsTracker, type AzureDevOpsDeps } from './azure-devops.js';
import { MemoryTracker } from './memory.js';
import { TrackerError, type Tracker } from './types.js';

export const SUPPORTED_TRACKERS = ['azure_devops', 'memory'] as const;

/** Builds the adapter selected by `tracker.kind` (§11.2). Throws TrackerError for invalid config. */
export function createTracker(config: ServiceConfig['tracker'], deps: AzureDevOpsDeps): Tracker {
  switch (config.kind) {
    case 'azure_devops':
      return createAzureDevOpsTracker(config, deps);
    case 'memory':
      return new MemoryTracker();
    default:
      throw new TrackerError(
        'unsupported_tracker_kind',
        `tracker.kind ${JSON.stringify(config.kind)} is not supported (${SUPPORTED_TRACKERS.join(', ')})`,
      );
  }
}

/** Reuses one adapter instance while the tracker config is unchanged (§10.5 session binding). */
export function cachedTrackerFactory(deps: AzureDevOpsDeps): (config: ServiceConfig) => Tracker {
  let key = '';
  let tracker: Tracker | null = null;
  return (config) => {
    const next = JSON.stringify(config.tracker);
    if (!tracker || next !== key) {
      tracker = createTracker(config.tracker, deps);
      key = next;
    }
    return tracker;
  };
}

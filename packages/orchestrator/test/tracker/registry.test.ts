import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/config.js';
import { AzureDevOpsTracker } from '../../src/tracker/azure-devops.js';
import { cachedTrackerFactory, createTracker } from '../../src/tracker/registry.js';

const cfg = (tracker: Record<string, unknown>) => resolveConfig({ tracker }, { workflowDir: '/', env: {} });

describe('tracker registry', () => {
  it('§17.1 tracker.kind must name a supported adapter', () => {
    expect(() => createTracker(cfg({ kind: 'jira' }).tracker, { env: {} })).toThrow(
      expect.objectContaining({ category: 'unsupported_tracker_kind' }),
    );
    expect(() => createTracker(cfg({}).tracker, { env: {} })).toThrow(
      expect.objectContaining({ category: 'unsupported_tracker_kind' }),
    );
  });

  it('§17.1 tracker.provider is validated by the selected adapter', () => {
    expect(() => createTracker(cfg({ kind: 'azure_devops', provider: {} }).tracker, { env: {} })).toThrow(
      expect.objectContaining({ category: 'invalid_tracker_config' }),
    );
    const t = createTracker(
      cfg({
        kind: 'azure_devops',
        provider: { organization: 'o', project: 'p', team: 't', area_path: 'p\\a' },
      }).tracker,
      { env: {} },
    );
    expect(t).toBeInstanceOf(AzureDevOpsTracker);
  });

  it('§10.5 reuses the adapter until the tracker config changes', () => {
    const f = cachedTrackerFactory({ env: {} });
    const a = f(cfg({ kind: 'memory' }));
    expect(f(cfg({ kind: 'memory' }))).toBe(a);
    expect(f(cfg({ kind: 'memory', required_labels: ['x'] }))).not.toBe(a);
  });
});

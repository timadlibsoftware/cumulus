import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/config.js';
import { MemorySettingsBackend, SettingsError, SettingsStore } from '../../src/config/settings.js';

const ctx = { workflowDir: '/', env: {} };
const configFor = (raw: Record<string, unknown>) => resolveConfig(raw, ctx);

describe('SettingsStore (C-6)', () => {
  it('C-6 shows the built-in default when neither WORKFLOW.md nor the UI sets a value', async () => {
    const s = new SettingsStore(new MemorySettingsBackend());
    await s.refresh();
    const [view] = s.list({});
    expect(view).toMatchObject({
      key: 'agent.max_concurrent_agents',
      label: 'Max simultaneous runs',
      type: 'integer',
      default_value: 5,
      workflow_value: null,
      override_value: null,
      effective_value: 5,
    });
    expect(s.maxConcurrentAgents(configFor({}))).toBe(5);
  });

  it('C-6 WORKFLOW.md beats the default', async () => {
    const s = new SettingsStore(new MemorySettingsBackend());
    await s.refresh();
    const raw = { agent: { max_concurrent_agents: 3 } };
    expect(s.list(raw)[0]).toMatchObject({ workflow_value: 3, effective_value: 3 });
    expect(s.maxConcurrentAgents(configFor(raw))).toBe(3);
  });

  it('C-6 a UI override beats WORKFLOW.md and records who and when', async () => {
    const s = new SettingsStore(new MemorySettingsBackend(), () => new Date('2026-10-05T00:00:00Z'));
    await s.refresh();
    await s.set('agent.max_concurrent_agents', 8, 'tim@adlibsoftware.com');
    const raw = { agent: { max_concurrent_agents: 3 } };
    expect(s.list(raw)[0]).toMatchObject({
      override_value: 8,
      effective_value: 8,
      updated_by: 'tim@adlibsoftware.com',
      updated_at: '2026-10-05T00:00:00.000Z',
    });
    expect(s.maxConcurrentAgents(configFor(raw))).toBe(8);
  });

  it('C-6 reset clears the override', async () => {
    const s = new SettingsStore(new MemorySettingsBackend());
    await s.refresh();
    await s.set('agent.max_concurrent_agents', 8, 'a');
    await s.reset('agent.max_concurrent_agents', 'a');
    expect(s.list({})[0]).toMatchObject({ override_value: null, effective_value: 5, updated_by: null });
  });

  it('C-6 rejects unknown keys and invalid values', async () => {
    const s = new SettingsStore(new MemorySettingsBackend());
    await expect(s.set('nope', 1, 'a')).rejects.toMatchObject({ code: 'unknown_setting' });
    await expect(s.set('agent.max_concurrent_agents', 1.5, 'a')).rejects.toMatchObject({
      code: 'invalid_value',
    });
    await expect(s.set('agent.max_concurrent_agents', -1, 'a')).rejects.toMatchObject({
      code: 'invalid_value',
    });
    await expect(s.set('agent.max_concurrent_agents', 101, 'a')).rejects.toBeInstanceOf(SettingsError);
  });

  it('C-6 keeps the last known values when the backend is unavailable', async () => {
    const backend = new MemorySettingsBackend();
    const s = new SettingsStore(backend);
    await s.set('agent.max_concurrent_agents', 2, 'a');
    backend.fail = true;
    await s.refresh();
    expect(s.maxConcurrentAgents(configFor({}))).toBe(2);
    await expect(s.set('agent.max_concurrent_agents', 3, 'a')).rejects.toMatchObject({
      code: 'settings_unavailable',
    });
  });

  it('C-6 refresh picks up overrides written by another instance', async () => {
    const backend = new MemorySettingsBackend();
    const s = new SettingsStore(backend);
    await backend.set('agent.max_concurrent_agents', 4, 'b', new Date());
    await s.refresh();
    expect(s.maxConcurrentAgents(configFor({}))).toBe(4);
  });
});

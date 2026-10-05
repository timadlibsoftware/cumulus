import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkflowStore } from '../../src/config/store.js';

const valid = (interval: number, prompt = 'Hello') =>
  `---\ntracker:\n  kind: memory\n  active_states: [Dev]\npolling:\n  interval_ms: ${interval}\n---\n${prompt}\n`;

async function setup(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'cumulus-store-'));
  const path = join(dir, 'WORKFLOW.md');
  await writeFile(path, content);
  return { path, store: new WorkflowStore(path, {}) };
}

describe('WorkflowStore', () => {
  it('§17.1 loads the workflow and exposes typed config, prompt and raw front matter', async () => {
    const { store } = await setup(valid(5000));
    await store.load();
    const snap = store.current();
    expect(snap.config.polling.intervalMs).toBe(5000);
    expect(snap.promptTemplate).toBe('Hello');
    expect(snap.error).toBeNull();
    expect(store.raw()).toMatchObject({ polling: { interval_ms: 5000 } });
  });

  it('§17.1 startup load failure surfaces a typed error', async () => {
    const store = new WorkflowStore('/nope/WORKFLOW.md', {});
    await expect(store.load()).rejects.toMatchObject({ code: 'missing_workflow_file' });
  });

  it('§17.1 detects changes and re-applies config and prompt without restart', async () => {
    const { path, store } = await setup(valid(5000));
    await store.load();
    await writeFile(path, valid(7000, 'Changed'));
    await store.refresh();
    expect(store.current().config.polling.intervalMs).toBe(7000);
    expect(store.current().promptTemplate).toBe('Changed');
  });

  it('§17.1 invalid reload keeps the last known good config and reports an error', async () => {
    const { path, store } = await setup(valid(5000));
    await store.load();
    await writeFile(path, '---\npolling: [broken\n---\nx');
    await store.refresh();
    expect(store.current().config.polling.intervalMs).toBe(5000);
    expect(store.current().error).toMatch(/workflow_parse_error/);
    await writeFile(path, valid(9000));
    await store.refresh();
    expect(store.current().error).toBeNull();
    expect(store.current().config.polling.intervalMs).toBe(9000);
  });

  it('§6.2 config validation errors on reload also keep the last good config', async () => {
    const { path, store } = await setup(valid(5000));
    await store.load();
    await writeFile(path, '---\nagent:\n  max_turns: 0\n---\nx');
    await store.refresh();
    expect(store.current().error).toMatch(/max_turns/);
    expect(store.current().config.agent.maxTurns).toBe(20);
  });

  it('§6.2 watch() picks up file changes', async () => {
    const { path, store } = await setup(valid(5000));
    await store.load();
    const reloaded = new Promise<void>((resolve) => store.once('reload', () => resolve()));
    const stop = store.watch(20);
    await writeFile(path, valid(6000));
    await reloaded;
    stop();
    expect(store.current().config.polling.intervalMs).toBe(6000);
  });
});

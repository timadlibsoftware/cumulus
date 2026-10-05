import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config/config.js';
import { CompositeJanitor, GitHubBranchJanitor, LocalWorkspaceJanitor } from '../src/janitor.js';
import { MemoryTracker } from '../src/tracker/memory.js';
import { makeIssue } from './fixtures/issues.js';

class FakeBranches {
  repos: Record<string, string[]> = {
    'aks-gitops': ['cumulus/AB_1-a', 'cumulus/AB_12-b', 'cumulus/AB_3-c'],
    'tf-org': ['cumulus/AB_1-a'],
    other: [],
  };
  deleted: string[] = [];
  async listRepos() {
    return Object.keys(this.repos);
  }
  async branches(repo: string, prefix: string) {
    return (this.repos[repo] ?? []).filter((b) => b.startsWith(prefix));
  }
  async deleteBranch(repo: string, branch: string) {
    this.deleted.push(`${repo}:${branch}`);
    this.repos[repo] = (this.repos[repo] ?? []).filter((b) => b !== branch);
  }
}

const config = (raw: Record<string, unknown> = {}) =>
  resolveConfig(
    { tracker: { kind: 'memory', active_states: ['Dev'], terminal_states: ['Closed'] }, ...raw },
    { workflowDir: '/', env: {} },
  );

describe('GitHubBranchJanitor (C-9)', () => {
  it('deletes the issue branch in every repository that has it, matching exactly', async () => {
    const gh = new FakeBranches();
    const j = new GitHubBranchJanitor(gh, async () => new Map());
    await j.cleanupIssue(makeIssue({ id: '1' }), 'AB_1-a', config());
    expect(gh.deleted.sort()).toEqual(['aks-gitops:cumulus/AB_1-a', 'tf-org:cumulus/AB_1-a']);
  });

  it('sweep deletes branches of terminal issues and keeps active and unknown ones', async () => {
    const gh = new FakeBranches();
    const keys = new Map([
      ['AB_1-a', '1'],
      ['AB_12-b', '12'],
    ]);
    const tracker = new MemoryTracker([
      makeIssue({ id: '1', state: 'Closed' }),
      makeIssue({ id: '12', state: 'Dev' }),
    ]);
    const j = new GitHubBranchJanitor(gh, async () => keys);
    await j.sweep(tracker, config());
    expect(gh.deleted.sort()).toEqual(['aks-gitops:cumulus/AB_1-a', 'tf-org:cumulus/AB_1-a']);
  });
});

describe('LocalWorkspaceJanitor', () => {
  it('§17.2 runs before_remove (ignoring failure) and removes the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cumulus-jan-'));
    await mkdir(join(root, 'AB_1-a'));
    const j = new LocalWorkspaceJanitor(async () => new Map());
    await j.cleanupIssue(
      makeIssue(),
      'AB_1-a',
      config({ workspace: { root }, hooks: { before_remove: 'echo removed > ../before.log; exit 1' } }),
    );
    expect((await readFile(join(root, 'before.log'), 'utf8')).trim()).toBe('removed');
    await expect(stat(join(root, 'AB_1-a'))).rejects.toThrow();
  });

  it('§8.6 sweep removes workspaces of terminal issues', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cumulus-jan-'));
    await mkdir(join(root, 'AB_1-a'));
    await mkdir(join(root, 'AB_2-b'));
    const tracker = new MemoryTracker([
      makeIssue({ id: '1', state: 'Closed' }),
      makeIssue({ id: '2', state: 'Dev' }),
    ]);
    const j = new LocalWorkspaceJanitor(
      async () =>
        new Map([
          ['AB_1-a', '1'],
          ['AB_2-b', '2'],
        ]),
    );
    await j.sweep(tracker, config({ workspace: { root } }));
    await expect(stat(join(root, 'AB_1-a'))).rejects.toThrow();
    expect((await stat(join(root, 'AB_2-b'))).isDirectory()).toBe(true);
  });

  it('never removes paths outside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cumulus-jan-'));
    const j = new LocalWorkspaceJanitor(async () => new Map());
    await expect(j.cleanupIssue(makeIssue(), '../escape', config({ workspace: { root } }))).rejects.toThrow(
      /outside/,
    );
  });
});

describe('CompositeJanitor', () => {
  it('runs every janitor and reports the first failure after all ran', async () => {
    const calls: string[] = [];
    const ok = {
      cleanupIssue: async () => void calls.push('ok'),
      sweep: async () => void calls.push('ok-sweep'),
    };
    const bad = {
      cleanupIssue: async () => {
        calls.push('bad');
        throw new Error('nope');
      },
      sweep: async () => void calls.push('bad-sweep'),
    };
    const j = new CompositeJanitor([bad, ok]);
    await expect(j.cleanupIssue(makeIssue(), 'k', config())).rejects.toThrow('nope');
    expect(calls).toEqual(['bad', 'ok']);
  });
});

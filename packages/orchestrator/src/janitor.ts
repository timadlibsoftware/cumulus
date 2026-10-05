import type { Issue } from '@cumulus/shared';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServiceConfig } from './config/config.js';
import { runHook } from './executor/local.js';
import { isTerminal } from './orchestrator/scheduling.js';
import type { WorkspaceJanitor } from './orchestrator/ports.js';
import type { Tracker } from './tracker/types.js';
import { assertInsideRoot, branchName } from './workspace.js';

/** Workspace key → issue id, from the audit trail (C-5). */
export type KeyIndex = () => Promise<Map<string, string>>;

export interface BranchHost {
  listRepos(): Promise<string[]>;
  branches(repo: string, prefix: string): Promise<string[]>;
  deleteBranch(repo: string, branch: string): Promise<void>;
}

/** Issues among `keys` that the tracker reports in a terminal state. Unknown or invisible issues are kept. */
async function terminalKeys(
  keys: string[],
  index: KeyIndex,
  tracker: Tracker,
  config: ServiceConfig,
): Promise<Set<string>> {
  const map = await index();
  const ids = [...new Set(keys.map((k) => map.get(k)).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Set();
  const terminal = new Set(
    (await tracker.fetchIssuesByIds(ids)).filter((i) => isTerminal(i, config.tracker)).map((i) => i.id),
  );
  return new Set(keys.filter((k) => terminal.has(map.get(k) ?? '')));
}

/** C-9: deletes `cumulus/<key>` branches across the GitHub org. */
export class GitHubBranchJanitor implements WorkspaceJanitor {
  constructor(
    private readonly github: BranchHost,
    private readonly index: KeyIndex,
  ) {}

  async cleanupIssue(_issue: Issue, key: string): Promise<void> {
    const branch = branchName(key);
    for (const repo of await this.github.listRepos()) {
      if ((await this.github.branches(repo, branch)).includes(branch))
        await this.github.deleteBranch(repo, branch);
    }
  }

  async sweep(tracker: Tracker, config: ServiceConfig): Promise<void> {
    const found: { repo: string; key: string }[] = [];
    for (const repo of await this.github.listRepos()) {
      for (const b of await this.github.branches(repo, 'cumulus/'))
        found.push({ repo, key: b.slice('cumulus/'.length) });
    }
    const terminal = await terminalKeys([...new Set(found.map((f) => f.key))], this.index, tracker, config);
    for (const f of found) if (terminal.has(f.key)) await this.github.deleteBranch(f.repo, branchName(f.key));
  }
}

/** `worker.executor: local`: upstream §9 workspace removal with the before_remove hook. */
export class LocalWorkspaceJanitor implements WorkspaceJanitor {
  constructor(private readonly index: KeyIndex) {}

  async cleanupIssue(_issue: Issue, key: string, config: ServiceConfig): Promise<void> {
    const path = join(config.workspace.root, key);
    assertInsideRoot(config.workspace.root, path);
    const exists = await stat(path).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!exists) return;
    if (config.hooks.beforeRemove) {
      await runHook(
        'before_remove',
        config.hooks.beforeRemove,
        path,
        config.hooks.timeoutMs,
        process.env,
      ).catch(() => {});
    }
    await rm(path, { recursive: true, force: true });
  }

  async sweep(tracker: Tracker, config: ServiceConfig): Promise<void> {
    const entries = await readdir(config.workspace.root, { withFileTypes: true }).catch(() => []);
    const keys = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const terminal = await terminalKeys(keys, this.index, tracker, config);
    for (const key of terminal) await this.cleanupIssue({} as Issue, key, config);
  }
}

export class CompositeJanitor implements WorkspaceJanitor {
  constructor(private readonly janitors: WorkspaceJanitor[]) {}

  private async all(fn: (j: WorkspaceJanitor) => Promise<void>): Promise<void> {
    const results = await Promise.allSettled(this.janitors.map(fn));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  cleanupIssue(issue: Issue, key: string, config: ServiceConfig): Promise<void> {
    return this.all((j) => j.cleanupIssue(issue, key, config));
  }

  sweep(tracker: Tracker, config: ServiceConfig): Promise<void> {
    return this.all((j) => j.sweep(tracker, config));
  }
}

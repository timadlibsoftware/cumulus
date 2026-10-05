import type { WorkerRow } from '@cumulus/shared';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { assertInsideRoot } from '../workspace.js';
import type { WorkerExecutor, WorkerExit, WorkerHandle, WorkerSpec } from './types.js';

/** Runs a shell script in `cwd` with a timeout. Rejects on non-zero exit or timeout. */
export function runHook(
  name: string,
  script: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', script], {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new Error(`${name} hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${name} hook failed to start: ${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${name} hook exited with ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

/**
 * C-3 `worker.executor: local`: runs the agent as a child process on the orchestrator host with upstream
 * §9 workspace semantics (reuse, after_create on creation). For development and tests.
 */
export class LocalExecutor implements WorkerExecutor {
  readonly kind = 'local';
  private readonly running = new Map<
    string,
    { child: ChildProcessWithoutNullStreams; spec: WorkerSpec; startedAt: string }
  >();

  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    assertInsideRoot(spec.workspaceRoot, spec.workspacePath);
    let createdNow = false;
    try {
      const s = await stat(spec.workspacePath);
      if (!s.isDirectory())
        throw new Error(`workspace path ${spec.workspacePath} exists and is not a directory`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await mkdir(spec.workspacePath, { recursive: true });
      createdNow = true;
    }

    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
    for (const name of spec.removeEnv) delete env[name];

    if (createdNow && spec.hooks.afterCreate) {
      await runHook('after_create', spec.hooks.afterCreate, spec.workspacePath, spec.hooks.timeoutMs, env);
    }
    if (spec.hooks.beforeRun) {
      await runHook('before_run', spec.hooks.beforeRun, spec.workspacePath, spec.hooks.timeoutMs, env);
    }

    const child = spawn('bash', ['-lc', spec.command], {
      cwd: spec.workspacePath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const name = `local-${spec.runId}`;
    this.running.set(name, { child, spec, startedAt: new Date().toISOString() });
    let killed = false;

    const exited = new Promise<WorkerExit>((resolve) => {
      child.on('error', (err) => resolve({ code: null, reason: 'failed', message: err.message }));
      child.on('exit', (code) => resolve({ code, reason: killed ? 'killed' : 'exited' }));
    }).then(async (exit) => {
      this.running.delete(name);
      if (spec.hooks.afterRun) {
        await runHook('after_run', spec.hooks.afterRun, spec.workspacePath, spec.hooks.timeoutMs, env).catch(
          () => {},
        );
      }
      return exit;
    });

    return {
      name,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      imageDigest: async () => null,
      kill: async () => {
        killed = true;
        try {
          process.kill(-child.pid!, 'SIGTERM');
        } catch {
          /* already gone */
        }
      },
    };
  }

  async deleteOrphans(): Promise<string[]> {
    return [];
  }

  async listWorkers(): Promise<WorkerRow[]> {
    return [...this.running.entries()].map(([name, w]) => ({
      name,
      run_id: w.spec.runId,
      issue_identifier: w.spec.issue.identifier,
      phase: 'Running',
      created_at: w.startedAt,
    }));
  }
}

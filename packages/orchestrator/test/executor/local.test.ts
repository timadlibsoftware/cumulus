import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalExecutor } from '../../src/executor/local.js';
import type { WorkerSpec } from '../../src/executor/types.js';
import { makeIssue } from '../fixtures/issues.js';

async function root() {
  return mkdtemp(join(tmpdir(), 'cumulus-exec-'));
}

function spec(r: string, overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    runId: 'run1',
    issue: makeIssue(),
    workspaceRoot: r,
    workspacePath: join(r, 'AB_1'),
    command: 'cat',
    env: { CUMULUS_RUN_ID: 'run1' },
    secretEnv: {},
    removeEnv: [],
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, timeoutMs: 2000 },
    ...overrides,
  };
}

async function output(handle: { stdout: NodeJS.ReadableStream; exited: Promise<unknown> }) {
  let out = '';
  handle.stdout.on('data', (d: Buffer) => (out += d.toString()));
  const exit = await handle.exited;
  return { out, exit };
}

const exec = new LocalExecutor();

describe('LocalExecutor', () => {
  it('§17.2 creates a missing workspace and launches the agent with it as cwd', async () => {
    const r = await root();
    const h = await exec.start(spec(r, { command: 'pwd' }));
    const { out, exit } = await output(h);
    expect(out.trim()).toBe(join(r, 'AB_1'));
    expect(exit).toEqual({ code: 0, reason: 'exited' });
  });

  it('§10.1 launches via bash -lc and wires stdin/stdout', async () => {
    const r = await root();
    const h = await exec.start(spec(r, { command: 'read line; echo "got:$line"' }));
    h.stdin.write('hello\n');
    expect((await output(h)).out).toBe('got:hello\n');
  });

  it('§17.2 after_create runs only when the workspace is new', async () => {
    const r = await root();
    const hooks = {
      afterCreate: 'echo x >> ../created.log',
      beforeRun: null,
      afterRun: null,
      timeoutMs: 2000,
    };
    await output(await exec.start(spec(r, { command: 'true', hooks })));
    await output(await exec.start(spec(r, { command: 'true', hooks })));
    expect((await readFile(join(r, 'created.log'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('§17.2 before_run runs before each attempt; failure aborts the attempt', async () => {
    const r = await root();
    const hooks = { afterCreate: null, beforeRun: 'exit 3', afterRun: null, timeoutMs: 2000 };
    await expect(exec.start(spec(r, { command: 'touch launched', hooks }))).rejects.toThrow(/before_run/);
    await expect(stat(join(r, 'AB_1', 'launched'))).rejects.toThrow();
  });

  it('§17.2 hook timeouts abort the attempt', async () => {
    const r = await root();
    const hooks = { afterCreate: null, beforeRun: 'sleep 5', afterRun: null, timeoutMs: 100 };
    await expect(exec.start(spec(r, { hooks }))).rejects.toThrow(/timed out/);
  });

  it('§17.2 after_run runs after the attempt and its failure is ignored', async () => {
    const r = await root();
    const hooks = {
      afterCreate: null,
      beforeRun: null,
      afterRun: 'echo ran > ../after.log; exit 1',
      timeoutMs: 2000,
    };
    const { exit } = await output(await exec.start(spec(r, { command: 'exit 4', hooks })));
    expect(exit).toEqual({ code: 4, reason: 'exited' });
    expect((await readFile(join(r, 'after.log'), 'utf8')).trim()).toBe('ran');
  });

  it('§17.2 an existing non-directory at the workspace path fails safely', async () => {
    const r = await root();
    await writeFile(join(r, 'AB_1'), 'file');
    await expect(exec.start(spec(r))).rejects.toThrow(/not a directory/);
  });

  it('§17.5 rejects workspace paths outside the root', async () => {
    const r = await root();
    await mkdir(join(r, 'x'));
    await expect(exec.start(spec(r, { workspacePath: join(r, '..', 'escape') }))).rejects.toThrow(/outside/);
  });

  it('§15.3 removes declared secret env names and passes run env', async () => {
    const r = await root();
    process.env['CUMULUS_TEST_SECRET'] = 'leak';
    try {
      const h = await exec.start(
        spec(r, {
          command: 'echo "${CUMULUS_TEST_SECRET:-none} $CUMULUS_RUN_ID"',
          removeEnv: ['CUMULUS_TEST_SECRET'],
        }),
      );
      expect((await output(h)).out.trim()).toBe('none run1');
    } finally {
      delete process.env['CUMULUS_TEST_SECRET'];
    }
  });

  it('§15.3 passes secret env to the local agent', async () => {
    const r = await root();
    const h = await exec.start(
      spec(r, { command: 'echo "$CUMULUS_RUN_TOKEN"', secretEnv: { CUMULUS_RUN_TOKEN: 's3cret' } }),
    );
    expect((await output(h)).out.trim()).toBe('s3cret');
  });

  it('kill terminates the agent', async () => {
    const r = await root();
    const h = await exec.start(spec(r, { command: 'sleep 30' }));
    await h.kill();
    const exit = await h.exited;
    expect(exit).toMatchObject({ reason: 'killed' });
  });

  it('escalates to SIGKILL when the agent ignores SIGTERM', async () => {
    const r = await root();
    const ex = new LocalExecutor({ killGraceMs: 200 });
    const h = await ex.start(spec(r, { command: "trap '' TERM; sleep 30" }));
    await new Promise((res) => setTimeout(res, 100));
    await h.kill();
    const started = Date.now();
    expect(await h.exited).toMatchObject({ reason: 'killed' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('survives writes to an agent that already exited (EPIPE)', async () => {
    const r = await root();
    const h = await exec.start(spec(r, { command: 'exit 0' }));
    await h.exited;
    h.stdin.write('late\n');
    await new Promise((res) => setTimeout(res, 50));
  });

  it('reports no image digest for local processes', async () => {
    const r = await root();
    const h = await exec.start(spec(r, { command: 'true' }));
    expect(await h.imageDigest()).toBeNull();
    await h.exited;
  });
});

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/main.js';

const CLI = resolve(__dirname, '../src/cli.ts');
const TSX = import.meta.resolve('tsx');

function run(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; onStdout?: (s: string, kill: () => void) => void } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, CUMULUS_AUTH_DISABLED: '1', ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      opts.onStdout?.(stdout, () => child.kill('SIGTERM'));
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => done({ code, stdout, stderr }));
  });
}

const workflow = (port = 0) => `---
tracker:
  kind: memory
  active_states: [Dev]
  terminal_states: [Closed]
worker:
  executor: local
server:
  port: ${port}
shutdown:
  drain_timeout_ms: 1000
---
Work on {{ issue.identifier }}
`;

describe('CLI (§17.7)', () => {
  it('parses a positional workflow path and server flags', () => {
    expect(parseArgs([])).toEqual({
      workflowPath: undefined,
      port: undefined,
      host: undefined,
      internalPort: undefined,
    });
    expect(parseArgs(['wf/W.md', '--port', '8080', '--host', '0.0.0.0', '--internal-port', '8081'])).toEqual({
      workflowPath: 'wf/W.md',
      port: 8080,
      host: '0.0.0.0',
      internalPort: 8081,
    });
    expect(() => parseArgs(['--port', 'x'])).toThrow(/--port/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
  });

  it('§17.7 errors on a nonexistent explicit workflow path with a nonzero exit', async () => {
    const r = await run(['/nonexistent/WORKFLOW.md']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/missing_workflow_file/);
  }, 30_000);

  it('§17.7 uses ./WORKFLOW.md by default and fails cleanly when it is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cumulus-cli-'));
    const r = await run([], { cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(join(cwd, 'WORKFLOW.md'));
  }, 30_000);

  it('§17.7 surfaces invalid configuration as a startup failure', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cumulus-cli-'));
    await writeFile(join(cwd, 'WORKFLOW.md'), '---\ntracker:\n  kind: nope\n---\nx');
    const r = await run([], { cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unsupported_tracker_kind/);
  }, 30_000);

  it('§17.7 starts, serves HTTP and exits 0 on SIGTERM after draining', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cumulus-cli-'));
    await writeFile(join(cwd, 'WORKFLOW.md'), workflow());
    let health: unknown = null;
    let probing = false;
    const r = await run(['--internal-port', '0'], {
      cwd,
      onStdout: (out, kill) => {
        const m = /"url":"([^"]+)","msg":"http listening"/.exec(out);
        if (m && !probing) {
          probing = true;
          void fetch(`${m[1]}/healthz`)
            .then((res) => res.json())
            .then((j) => {
              health = j;
              kill();
            });
        }
      },
    });
    expect(health).toEqual({ ok: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/drain complete/);
  }, 30_000);
});

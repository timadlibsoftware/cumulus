import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@cumulus/shared';
import { describe, expect, it } from 'vitest';
import { OpenCodeAcpRunner } from '../../src/runner/opencode-acp.js';

/** §17.8: real `opencode acp` handshake (no prompt, no model spend). Enable with CUMULUS_LIVE_AGENTS=1. */
describe.skipIf(process.env['CUMULUS_LIVE_AGENTS'] !== '1')('opencode acp live handshake', () => {
  it('initializes and creates a session in the workspace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cumulus-live-'));
    const child = spawn('bash', ['-lc', 'opencode acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const events: AgentEvent[] = [];
    try {
      const session = await new OpenCodeAcpRunner().startSession(
        { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr },
        {
          cwd,
          model: null,
          mcpServers: [],
          readTimeoutMs: 30_000,
          turnTimeoutMs: 60_000,
          onEvent: (e) => events.push(e),
        },
      );
      expect(session.threadId).not.toBe('');
      await session.close();
    } finally {
      child.kill('SIGTERM');
    }
  }, 60_000);
});

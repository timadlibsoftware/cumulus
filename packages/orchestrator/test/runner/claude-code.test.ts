import type { AgentEvent } from '@cumulus/shared';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../../src/runner/claude-code.js';
import type { SessionOptions } from '../../src/runner/types.js';
import { FakeAgent } from './fake-agent.js';

type Msg = { type?: string; message?: { content?: { text?: string }[] } };

function result(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    num_turns: 1,
    result: 'done',
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      output_tokens: 50,
    },
    ...extra,
  };
}

/** Emulates `claude -p --input-format stream-json --output-format stream-json` (shapes from a real 2.1.x run). */
function claudeAgent(onUser?: (msg: Msg, a: FakeAgent, n: number) => void) {
  let n = 0;
  return new FakeAgent((raw, a) => {
    const msg = raw as Msg;
    if (msg.type !== 'user') return;
    n++;
    if (onUser) return onUser(msg, a, n);
    a.send({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      cwd: '/w',
      model: 'claude',
      permissionMode: 'bypassPermissions',
    });
    a.send({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `reply ${n}` }] },
      session_id: 'sess-1',
    });
    a.send({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    a.send(result('sess-1'));
  });
}

function options(events: AgentEvent[], overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    cwd: '/w',
    model: null,
    mcpServers: [],
    readTimeoutMs: 500,
    turnTimeoutMs: 500,
    onEvent: (e) => events.push(e),
    ...overrides,
  };
}

const runner = new ClaudeCodeRunner();

describe('Claude Code stream-json runner (C-2)', () => {
  it('§15.3 leaves ${VAR} header placeholders for Claude Code to expand, so secrets stay out of argv', () => {
    const cmd = runner.buildCommand('claude -p', {
      mcpServers: [
        {
          name: 'cumulus',
          url: 'http://o/mcp/runs/r1',
          headers: { authorization: 'Bearer ${CUMULUS_RUN_TOKEN}' },
        },
      ],
      model: null,
    });
    expect(cmd).toContain('"authorization":"Bearer ${CUMULUS_RUN_TOKEN}"');
  });

  it('C-11 appends the MCP config, model and permission mode to the launch command', () => {
    const cmd = runner.buildCommand(
      'claude -p --input-format stream-json --output-format stream-json --verbose',
      {
        mcpServers: [
          { name: 'cumulus', url: "http://o/mcp/runs/r'1", headers: { authorization: 'Bearer t' } },
        ],
        model: 'sonnet',
      },
    );
    expect(cmd).toBe(
      `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions --mcp-config '{"mcpServers":{"cumulus":{"type":"http","url":"http://o/mcp/runs/r'\\''1","headers":{"authorization":"Bearer t"}}}}' --model 'sonnet'`,
    );
  });

  it('§17.5 sends the prompt as a stream-json user message and completes on result', async () => {
    const agent = claudeAgent();
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    const r = await session.runTurn('hello', 't');
    expect(agent.received[0]).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(session.threadId).toBe('sess-1');
    expect(r.turnId).toBe('sess-1-1');
    expect(events.find((e) => e.event === 'session_started')?.session_id).toBe('sess-1-1');
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(['session_started', 'notification', 'turn_completed']),
    );
  });

  it('§13.5 accumulates per-turn usage (including cache tokens) into absolute session totals', async () => {
    const agent = claudeAgent();
    const session = await runner.startSession(agent.io, options([]));
    await session.runTurn('a', 't');
    const r = await session.runTurn('b', 't');
    expect(r.turnId).toBe('sess-1-2');
    expect(r.usage).toEqual({ input_tokens: 2220, output_tokens: 100, total_tokens: 2320 });
  });

  it('§13.5 captures rate limit telemetry', async () => {
    const agent = claudeAgent();
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    await session.runTurn('a', 't');
    expect(events.find((e) => e.rate_limits)?.rate_limits).toEqual({ status: 'allowed' });
  });

  it('§17.5 an error result fails the turn', async () => {
    const agent = claudeAgent((_m, a) =>
      a.send(result('s', { subtype: 'error_during_execution', is_error: true, result: 'boom' })),
    );
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    await expect(session.runTurn('a', 't')).rejects.toMatchObject({ code: 'turn_failed' });
    expect(events.map((e) => e.event)).toContain('turn_failed');
  });

  it('§17.5 enforces the turn silence timeout', async () => {
    const agent = claudeAgent(() => {});
    const session = await runner.startSession(agent.io, options([], { turnTimeoutMs: 40 }));
    await expect(session.runTurn('a', 't')).rejects.toMatchObject({ code: 'turn_timeout' });
  });

  it('§17.5 process exit during a turn fails with port_exit', async () => {
    const agent = claudeAgent((_m, a) => a.exit());
    const session = await runner.startSession(agent.io, options([]));
    await expect(session.runTurn('a', 't')).rejects.toMatchObject({ code: 'port_exit' });
  });

  it('§17.5 malformed lines are reported and the turn continues', async () => {
    const agent = claudeAgent((_m, a) => {
      a.raw('{oops');
      a.send(result('s'));
    });
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    await session.runTurn('a', 't');
    expect(events.map((e) => e.event)).toContain('malformed');
  });
});

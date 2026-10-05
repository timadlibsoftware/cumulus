import type { AgentEvent } from '@cumulus/shared';
import { describe, expect, it } from 'vitest';
import { OpenCodeAcpRunner } from '../../src/runner/opencode-acp.js';
import type { SessionOptions } from '../../src/runner/types.js';
import { FakeAgent } from './fake-agent.js';

type Msg = Record<string, unknown> & { id?: number; method?: string; params?: Record<string, unknown> };

/** Default well-behaved ACP agent; `onPrompt` customizes the turn. */
function acpAgent(onPrompt?: (msg: Msg, a: FakeAgent) => void) {
  return new FakeAgent((raw, a) => {
    const msg = raw as Msg;
    if (msg.method === 'initialize')
      a.send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } },
      });
    if (msg.method === 'session/new') a.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'ses_1' } });
    if (msg.method === 'session/prompt') {
      if (onPrompt) onPrompt(msg, a);
      else {
        a.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } },
          },
        });
        a.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
        });
      }
    }
  });
}

function options(events: AgentEvent[], overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    cwd: '/workspace/AB_1-x',
    model: null,
    mcpServers: [{ name: 'cumulus', url: 'http://orch/mcp/runs/r1', headers: { authorization: 'Bearer t' } }],
    readTimeoutMs: 500,
    turnTimeoutMs: 500,
    onEvent: (e) => events.push(e),
    ...overrides,
  };
}

const runner = new OpenCodeAcpRunner();

describe('OpenCode ACP runner (C-2)', () => {
  it('§17.5 initializes with client identity and creates a session in the workspace cwd', async () => {
    const agent = acpAgent();
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    const init = agent.received.find((m) => m['method'] === 'initialize') as Msg;
    expect(init.params).toMatchObject({
      protocolVersion: 1,
      clientInfo: { name: 'cumulus' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const created = agent.received.find((m) => m['method'] === 'session/new') as Msg;
    expect(created.params).toEqual({
      cwd: '/workspace/AB_1-x',
      mcpServers: [
        {
          type: 'http',
          name: 'cumulus',
          url: 'http://orch/mcp/runs/r1',
          headers: [{ name: 'authorization', value: 'Bearer t' }],
        },
      ],
    });
    expect(session.threadId).toBe('ses_1');
  });

  it('§17.5 completes a turn, emits session_started and turn_completed with absolute usage', async () => {
    const agent = acpAgent();
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    const r1 = await session.runTurn('do it', 'AB#1: t');
    const r2 = await session.runTurn('continue', 'AB#1: t');
    expect(r1.turnId).toBe('ses_1-1');
    expect(r2.turnId).toBe('ses_1-2');
    expect(r2.usage).toEqual({ input_tokens: 200, output_tokens: 40, total_tokens: 240 });
    const names = events.map((e) => e.event);
    expect(names.filter((n) => n === 'session_started')).toHaveLength(2);
    expect(names).toContain('notification');
    expect(events.filter((e) => e.event === 'turn_completed').at(-1)?.usage).toEqual({
      input_tokens: 200,
      output_tokens: 40,
      total_tokens: 240,
    });
    expect(events.find((e) => e.event === 'session_started')?.session_id).toBe('ses_1-1');
  });

  it('§10.2 sends the prompt as a text content block on the same session', async () => {
    const agent = acpAgent();
    const session = await runner.startSession(agent.io, options([]));
    await session.runTurn('hello', 't');
    const prompt = agent.received.find((m) => m['method'] === 'session/prompt') as Msg;
    expect(prompt.params).toEqual({ sessionId: 'ses_1', prompt: [{ type: 'text', text: 'hello' }] });
  });

  it('C-2 passes the configured model via session/set_model when set', async () => {
    const agent = new FakeAgent((raw, a) => {
      const msg = raw as Msg;
      if (msg.method === 'initialize') a.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      if (msg.method === 'session/new') a.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
      if (msg.method === 'session/set_model') a.send({ jsonrpc: '2.0', id: msg.id, result: {} });
    });
    await runner.startSession(agent.io, options([], { model: 'litellm/claude-sonnet' }));
    expect(agent.received.find((m) => m['method'] === 'session/set_model')).toMatchObject({
      params: { sessionId: 's', modelId: 'litellm/claude-sonnet' },
    });
  });

  it('§17.5 auto-approves permission requests per the documented policy', async () => {
    const agent = acpAgent((msg, a) => {
      a.send({
        jsonrpc: '2.0',
        id: 77,
        method: 'session/request_permission',
        params: {
          sessionId: 'ses_1',
          toolCall: { toolCallId: 'c1', title: 'bash' },
          options: [
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            { optionId: 'always', name: 'Always', kind: 'allow_always' },
            { optionId: 'once', name: 'Once', kind: 'allow_once' },
          ],
        },
      });
      setTimeout(() => a.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }), 10);
    });
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    await session.runTurn('x', 't');
    expect(agent.received).toContainEqual({
      jsonrpc: '2.0',
      id: 77,
      result: { outcome: { outcome: 'selected', optionId: 'always' } },
    });
    expect(events.map((e) => e.event)).toContain('approval_auto_approved');
  });

  it('§17.5 rejects unsupported client methods without stalling', async () => {
    const agent = acpAgent((msg, a) => {
      a.send({ jsonrpc: '2.0', id: 5, method: 'fs/read_text_file', params: { path: '/etc/passwd' } });
      setTimeout(() => a.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }), 10);
    });
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    await session.runTurn('x', 't');
    const reply = agent.received.find((m) => m['id'] === 5 && 'error' in m) as { error: { code: number } };
    expect(reply.error.code).toBe(-32601);
    expect(events.map((e) => e.event)).toContain('unsupported_tool_call');
  });

  it('§17.5 cancelled stop reason fails the turn as turn_cancelled', async () => {
    const agent = acpAgent((msg, a) =>
      a.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'cancelled' } }),
    );
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    await expect(session.runTurn('x', 't')).rejects.toMatchObject({ code: 'turn_cancelled' });
    expect(events.map((e) => e.event)).toContain('turn_cancelled');
  });

  it('§17.5 refusal fails the turn as turn_failed', async () => {
    const agent = acpAgent((msg, a) =>
      a.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } }),
    );
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    await expect(session.runTurn('x', 't')).rejects.toMatchObject({ code: 'turn_failed' });
    expect(events.map((e) => e.event)).toContain('turn_failed');
  });

  it('§17.5 a prompt error response ends the turn with error', async () => {
    const agent = acpAgent((msg, a) =>
      a.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'model unavailable' } }),
    );
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    await expect(session.runTurn('x', 't')).rejects.toMatchObject({ code: 'response_error' });
    expect(events.map((e) => e.event)).toContain('turn_ended_with_error');
  });

  it('§17.5 enforces the turn silence timeout and cancels the session', async () => {
    const agent = acpAgent(() => {});
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events, { turnTimeoutMs: 50 }));
    await expect(session.runTurn('x', 't')).rejects.toMatchObject({ code: 'turn_timeout' });
    await new Promise((r) => setTimeout(r, 5));
    expect(agent.methods()).toContain('session/cancel');
  });

  it('§10.6 turn timeout resets on agent output', async () => {
    const agent = acpAgent((msg, a) => {
      let n = 0;
      const t = setInterval(() => {
        a.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } },
          },
        });
        if (++n === 4) {
          clearInterval(t);
          a.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      }, 30);
    });
    const session = await runner.startSession(agent.io, options([], { turnTimeoutMs: 60 }));
    await expect(session.runTurn('x', 't')).resolves.toMatchObject({ turnId: 'ses_1-1' });
  });

  it('C-3 the initialize handshake waits for the startup timeout (in-pod hooks run first)', async () => {
    const agent = new FakeAgent((raw, a) => {
      const msg = raw as Msg;
      if (msg.method === 'initialize')
        setTimeout(() => a.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }), 80);
      if (msg.method === 'session/new') a.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
    });
    const session = await runner.startSession(
      agent.io,
      options([], { readTimeoutMs: 30, startupTimeoutMs: 500 }),
    );
    expect(session.threadId).toBe('s');
  });

  it('§17.5 enforces the read timeout during startup and emits startup_failed', async () => {
    const agent = new FakeAgent(() => {});
    const events: AgentEvent[] = [];
    await expect(runner.startSession(agent.io, options(events, { readTimeoutMs: 30 }))).rejects.toMatchObject(
      { code: 'response_timeout' },
    );
    expect(events.map((e) => e.event)).toContain('startup_failed');
  });

  it('§17.5 subprocess exit during a turn fails with port_exit', async () => {
    const agent = acpAgent((_msg, a) => a.exit());
    const session = await runner.startSession(agent.io, options([]));
    await expect(session.runTurn('x', 't')).rejects.toMatchObject({ code: 'port_exit' });
  });

  it('§17.5 malformed protocol lines are reported and do not end the turn', async () => {
    const agent = acpAgent((msg, a) => {
      a.raw('not json');
      a.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    });
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    await session.runTurn('x', 't');
    expect(events.map((e) => e.event)).toContain('malformed');
  });

  it('§17.5 keeps stderr separate from the protocol stream', async () => {
    const agent = acpAgent();
    const events: AgentEvent[] = [];
    const session = await runner.startSession(agent.io, options(events));
    agent.stderr.write('{"jsonrpc":"2.0","id":1,"result":{"stopReason":"cancelled"}}\n');
    await expect(session.runTurn('x', 't')).resolves.toBeTruthy();
  });

  it('§17.5 usage_update context telemetry does not count as token totals', async () => {
    const agent = acpAgent((msg, a) => {
      a.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'ses_1', update: { sessionUpdate: 'usage_update', used: 5000, size: 200000 } },
      });
      a.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    });
    const session = await runner.startSession(agent.io, options([]));
    const r = await session.runTurn('x', 't');
    expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });
});

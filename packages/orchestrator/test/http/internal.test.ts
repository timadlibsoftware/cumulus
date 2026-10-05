import { afterEach, describe, expect, it } from 'vitest';
import { buildInternalServer } from '../../src/http/internal.js';
import { RunRegistryImpl } from '../../src/registry.js';
import { MemoryTracker } from '../../src/tracker/memory.js';
import type { ToolResult } from '../../src/tracker/types.js';
import { makeIssue } from '../fixtures/issues.js';

class ToolTracker extends MemoryTracker {
  calls: { name: string; args: unknown; issueId: string }[] = [];
  agentToolSpecs() {
    return [
      {
        name: 'azure_devops_move_card',
        description: 'Move',
        inputSchema: { type: 'object', properties: { column: { type: 'string' } } },
      },
    ];
  }
  async executeAgentTool(name: string, args: unknown, ctx: { issue: { id: string } }): Promise<ToolResult> {
    this.calls.push({ name, args, issueId: ctx.issue.id });
    return name === 'azure_devops_move_card'
      ? { ok: true, output: { column: 'Review' } }
      : { ok: false, output: { error: { code: 'unsupported_tool' } } };
  }
}

let closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

async function setup(
  git: { token(): Promise<{ token: string; expiresAt: string }> } | null = {
    token: async () => ({ token: 'ghs_x', expiresAt: '2026-10-05T01:00:00Z' }),
  },
) {
  const registry = new RunRegistryImpl();
  const tracker = new ToolTracker();
  registry.register({ runId: 'r1', token: 'secret', issue: makeIssue({ id: '7' }), tracker });
  const app = await buildInternalServer({ registry, gitTokens: git });
  closers.push(() => app.close());
  const rpc = (body: unknown, token = 'secret') =>
    app.inject({
      method: 'POST',
      url: '/mcp/runs/r1',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: body as object,
    });
  return { app, tracker, rpc };
}

describe('internal server (C-11)', () => {
  it('rejects MCP calls without the run token', async () => {
    const { rpc, app } = await setup();
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/mcp/runs/unknown', payload: {} })).statusCode).toBe(
      401,
    );
  });

  it('answers initialize with tool capabilities, echoing the protocol version', async () => {
    const { rpc } = await setup();
    const res = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'opencode' } },
    });
    expect(res.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cumulus', version: '0.1.0' },
      },
    });
  });

  it('accepts notifications with 202 and no body', async () => {
    const { rpc } = await setup();
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  it('§17.5 advertises only the selected adapter tools', async () => {
    const { rpc } = await setup();
    expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result).toEqual({
      tools: [
        {
          name: 'azure_devops_move_card',
          description: 'Move',
          inputSchema: { type: 'object', properties: { column: { type: 'string' } } },
        },
      ],
    });
  });

  it('§17.5 executes tools host-side with the run issue as context', async () => {
    const { rpc, tracker } = await setup();
    const res = (
      await rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'azure_devops_move_card', arguments: { column: 'Review' } },
      })
    ).json();
    expect(res.result).toEqual({
      content: [{ type: 'text', text: '{"column":"Review"}' }],
      structuredContent: { column: 'Review' },
      isError: false,
    });
    expect(tracker.calls).toEqual([
      { name: 'azure_devops_move_card', args: { column: 'Review' }, issueId: '7' },
    ]);
  });

  it('§17.5 tool failures are structured results, not protocol errors', async () => {
    const { rpc } = await setup();
    const res = (
      await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } })
    ).json();
    expect(res.result).toMatchObject({ isError: true });
  });

  it('answers ping and rejects unknown methods with -32601', async () => {
    const { rpc } = await setup();
    expect((await rpc({ jsonrpc: '2.0', id: 5, method: 'ping' })).json()).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: {},
    });
    expect((await rpc({ jsonrpc: '2.0', id: 6, method: 'resources/list' })).json().error.code).toBe(-32601);
  });

  it('returns 405 for GET (no server-initiated stream)', async () => {
    const { app } = await setup();
    expect(
      (await app.inject({ method: 'GET', url: '/mcp/runs/r1', headers: { authorization: 'Bearer secret' } }))
        .statusCode,
    ).toBe(405);
  });

  it('C-10 serves a git token to the run', async () => {
    const { app } = await setup();
    const res = await app.inject({
      url: '/internal/runs/r1/git-token',
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.json()).toEqual({ token: 'ghs_x', expires_at: '2026-10-05T01:00:00Z' });
    expect((await app.inject({ url: '/internal/runs/r1/git-token' })).statusCode).toBe(401);
  });

  it('C-10 reports when GitHub is not configured', async () => {
    const { app } = await setup(null);
    expect(
      (await app.inject({ url: '/internal/runs/r1/git-token', headers: { authorization: 'Bearer secret' } }))
        .statusCode,
    ).toBe(503);
  });
});

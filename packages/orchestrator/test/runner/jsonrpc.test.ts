import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonRpcPeer, JsonRpcError } from '../../src/runner/jsonrpc.js';

function pair() {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const sent: unknown[] = [];
  toAgent.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n').filter(Boolean)) sent.push(JSON.parse(line));
  });
  return { toAgent, fromAgent, sent };
}

describe('JsonRpcPeer', () => {
  it('correlates responses to requests by id', async () => {
    const { toAgent, fromAgent, sent } = pair();
    const peer = new JsonRpcPeer(toAgent, fromAgent, {});
    const p = peer.request('initialize', { a: 1 }, 1000);
    await new Promise((r) => setImmediate(r));
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } });
    fromAgent.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n');
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects with the JSON-RPC error payload', async () => {
    const { toAgent, fromAgent } = pair();
    const peer = new JsonRpcPeer(toAgent, fromAgent, {});
    const p = peer.request('x', {}, 1000);
    fromAgent.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } }) + '\n',
    );
    await expect(p).rejects.toBeInstanceOf(JsonRpcError);
  });

  it('§10.6 enforces the read timeout', async () => {
    const { toAgent, fromAgent } = pair();
    const peer = new JsonRpcPeer(toAgent, fromAgent, {});
    await expect(peer.request('slow', {}, 20)).rejects.toMatchObject({ code: 'response_timeout' });
  });

  it('dispatches notifications and answers incoming requests', async () => {
    const { toAgent, fromAgent, sent } = pair();
    const notes: unknown[] = [];
    new JsonRpcPeer(toAgent, fromAgent, {
      onNotification: (m, p) => notes.push([m, p]),
      onRequest: async (m) =>
        m === 'ping' ? { pong: true } : Promise.reject(new JsonRpcError(-32601, 'unknown')),
    });
    fromAgent.write(JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { n: 1 } }) + '\n');
    fromAgent.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping', params: {} }) + '\n');
    fromAgent.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'other', params: {} }) + '\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(notes).toEqual([['note', { n: 1 }]]);
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 9, result: { pong: true } });
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 10, error: { code: -32601, message: 'unknown' } });
  });

  it('reports malformed lines without stopping', async () => {
    const { toAgent, fromAgent } = pair();
    const bad: string[] = [];
    const peer = new JsonRpcPeer(toAgent, fromAgent, { onMalformed: (l) => bad.push(l) });
    const p = peer.request('x', {}, 1000);
    fromAgent.write('garbage\n');
    fromAgent.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 }) + '\n');
    await expect(p).resolves.toBe(1);
    expect(bad).toEqual(['garbage']);
  });

  it('§10.3 fails pending requests when the stream ends', async () => {
    const { toAgent, fromAgent } = pair();
    const peer = new JsonRpcPeer(toAgent, fromAgent, {});
    const p = peer.request('x', {}, 1000);
    fromAgent.end();
    await expect(p).rejects.toMatchObject({ code: 'port_exit' });
    expect(peer.closed).toBe(true);
  });
});

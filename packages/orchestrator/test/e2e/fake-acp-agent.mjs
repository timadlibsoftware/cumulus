// Scripted ACP agent for the end-to-end test: on each prompt it calls the cumulus MCP tool that moves
// the work item to Review (the C-11 hand-off), then ends the turn.
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
let mcp = null;

for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === 'session/new') {
    mcp = msg.params.mcpServers[0];
    process.stderr.write(`cwd=${msg.params.cwd} pwd=${process.cwd()}\n`);
    send({ id: msg.id, result: { sessionId: 'e2e-session' } });
  } else if (msg.method === 'session/prompt') {
    const headers = Object.fromEntries(mcp.headers.map((h) => [h.name, h.value]));
    const call = async (id, method, params) =>
      (await fetch(mcp.url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json();
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake' } });
    const tools = await call(2, 'tools/list', {});
    const result = await call(3, 'tools/call', { name: 'azure_devops_move_card', arguments: { column: 'Review' } });
    send({ method: 'session/update', params: { sessionId: 'e2e-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `tools=${tools.result.tools.length} moved=${!result.result.isError}` } } } });
    send({ id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } } });
  }
}

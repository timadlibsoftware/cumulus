import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { RegisteredRun, RunRegistryImpl } from '../registry.js';

export interface GitTokenSource {
  token(): Promise<{ token: string; expiresAt: string }>;
}

export interface InternalServerDeps {
  registry: RunRegistryImpl;
  gitTokens: GitTokenSource | null;
  logger?: boolean | object;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Cluster-internal endpoints for agent pods (separate port, never behind the public ingress).
 * - C-11: `POST /mcp/runs/:runId` — minimal MCP Streamable HTTP server (JSON responses) exposing the
 *   run's tracker tools, executed host-side.
 * - C-10: `GET /internal/runs/:runId/git-token` — GitHub App installation token for git/gh.
 */
export async function buildInternalServer(deps: InternalServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 10 * 1024 * 1024 });

  const authorize = (runId: string, auth: string | undefined, reply: FastifyReply): RegisteredRun | null => {
    const run = deps.registry.authenticate(runId, auth);
    if (!run) void reply.code(401).send({ error: { code: 'unauthenticated', message: 'invalid run token' } });
    return run;
  };

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/mcp/runs/:runId', async (req, reply) => {
    const run = authorize((req.params as { runId: string }).runId, req.headers.authorization, reply);
    if (!run) return reply;
    const msg = req.body as RpcRequest;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
      return reply
        .code(400)
        .send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    }
    if (msg.id === undefined) return reply.code(202).send();
    const result = (value: unknown) => ({ jsonrpc: '2.0', id: msg.id, result: value });
    switch (msg.method) {
      case 'initialize':
        return result({
          protocolVersion:
            typeof msg.params?.['protocolVersion'] === 'string'
              ? msg.params['protocolVersion']
              : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'cumulus', version: '0.1.0' },
        });
      case 'ping':
        return result({});
      case 'tools/list':
        return result({
          tools: run.tracker
            .agentToolSpecs()
            .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
      case 'tools/call': {
        const name = String(msg.params?.['name'] ?? '');
        const out = await run.tracker.executeAgentTool(name, msg.params?.['arguments'] ?? {}, {
          issue: run.issue,
        });
        return result({
          content: [{ type: 'text', text: JSON.stringify(out.output) }],
          structuredContent: out.output,
          isError: !out.ok,
        });
      }
      default:
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        };
    }
  });

  app.get('/mcp/runs/:runId', async (_req, reply) => reply.code(405).header('allow', 'POST').send());
  app.delete('/mcp/runs/:runId', async (_req, reply) => reply.code(405).header('allow', 'POST').send());

  app.get('/internal/runs/:runId/git-token', async (req, reply) => {
    const run = authorize((req.params as { runId: string }).runId, req.headers.authorization, reply);
    if (!run) return reply;
    if (!deps.gitTokens)
      return reply
        .code(503)
        .send({ error: { code: 'github_not_configured', message: 'GitHub App is not configured' } });
    const t = await deps.gitTokens.token();
    return { token: t.token, expires_at: t.expiresAt };
  });

  return app;
}

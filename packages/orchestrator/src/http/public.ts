import type { RunRecord, StateSnapshot, WorkerRow } from '@cumulus/shared';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { SettingsError, type SettingsStore } from '../config/settings.js';

export interface User {
  id: string;
  name: string;
  email: string | null;
}

/** OIDC operations used by the login flow (real implementation wraps openid-client). */
export interface OidcClient {
  authorizationUrl(p: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): URL | Promise<URL>;
  exchange(
    currentUrl: URL,
    checks: { codeVerifier: string; state: string; nonce: string; redirectUri: string },
  ): Promise<User>;
}

export type AuthConfig = { mode: 'disabled' } | { mode: 'oidc'; client: OidcClient; publicUrl: string };

export interface OrchestratorView extends Pick<EventEmitter, 'on' | 'off'> {
  snapshot(): StateSnapshot;
  issueDetails(identifier: string): unknown;
  requestRefresh(): { queued: boolean; coalesced: boolean };
  listWorkers(): Promise<WorkerRow[]>;
}

export interface PublicServerDeps {
  orchestrator: OrchestratorView;
  runs: {
    listRuns(q: {
      limit: number;
      offset: number;
      status?: string;
    }): Promise<{ items: RunRecord[]; total: number }>;
  } | null;
  settings: SettingsStore;
  workflowRaw(): Record<string, unknown>;
  ready(): Promise<{ ok: boolean; checks: Record<string, string> }>;
  auth: AuthConfig;
  sessionSecret: string;
  staticDir: string | null;
  logger?: boolean | object;
}

const SESSION_COOKIE = 'cumulus_session';
const FLOW_COOKIE = 'cumulus_oidc';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FLOW_TTL_MS = 10 * 60 * 1000;
const LOCAL_USER: User = { id: 'local', name: 'local', email: null };
const RUN_STATUSES = new Set([
  'claimed',
  'pod_created',
  'running',
  'retrying',
  'completed',
  'failed',
  'interrupted',
  'canceled',
]);
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

const sendError = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

/** HMAC-signed cookie values: base64url(json).base64url(hmac). */
function sign(secret: string, value: object): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function unsign<T extends { exp: number }>(secret: string, raw: string | undefined): T | null {
  if (!raw) return null;
  const [body, mac] = raw.split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
    return value.exp > Date.now() ? value : null;
  } catch {
    return null;
  }
}

/** Same-origin relative path only; rejects anything a browser could normalize to another origin. */
function safeReturnTo(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point (open redirect)
  if (typeof value !== 'string' || !value.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(value))
    return '/';
  try {
    const base = new URL('https://cumulus.invalid');
    const url = new URL(value, base);
    return url.origin === base.origin ? `${url.pathname}${url.search}` : '/';
  } catch {
    return '/';
  }
}

const cookieOptions = (maxAgeMs: number) => ({
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: Math.floor(maxAgeMs / 1000),
});

/** §13.7 + C-8: dashboard, REST API, SSE and Entra sign-in. */
export async function buildPublicServer(deps: PublicServerDeps): Promise<FastifyInstance> {
  // forceCloseConnections: open SSE streams must not block shutdown (C-4).
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true, forceCloseConnections: true });
  await app.register(fastifyCookie);
  app.decorateRequest('user', null);

  /** Registers `handlers` and answers every other method on the path with 405 (§13.7.2). */
  const route = (
    url: string,
    handlers: Partial<
      Record<(typeof METHODS)[number], (req: FastifyRequest, reply: FastifyReply) => unknown>
    >,
  ) => {
    for (const method of METHODS) {
      const handler = handlers[method];
      app.route({
        method,
        url,
        handler:
          handler ??
          ((_req, reply) =>
            sendError(reply, 405, 'method_not_allowed', `${method} is not allowed on ${url}`)),
      });
    }
  };

  // ------------------------------------------------------------ auth

  app.addHook('onRequest', async (req, reply) => {
    if (deps.auth.mode === 'disabled') {
      req.user = LOCAL_USER;
      return;
    }
    const session = unsign<{ u: User; exp: number }>(deps.sessionSecret, req.cookies[SESSION_COOKIE]);
    req.user = session?.u ?? null;
    // Decide on the routed (decoded) path, not the raw URL, so encodings like /%61pi cannot bypass auth.
    let decoded = req.url;
    try {
      decoded = decodeURIComponent(req.url.split('?')[0] ?? '');
    } catch {
      /* keep raw */
    }
    const routed = req.routeOptions.url ?? '';
    if (!req.user && (routed.startsWith('/api/') || decoded.startsWith('/api/'))) {
      return sendError(reply, 401, 'unauthenticated', 'sign in required');
    }
  });

  app.get('/auth/me', async (req, reply) =>
    req.user
      ? { name: req.user.name, email: req.user.email }
      : sendError(reply, 401, 'unauthenticated', 'sign in required'),
  );

  app.get('/auth/logout', async (_req, reply) =>
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).redirect('/'),
  );

  if (deps.auth.mode === 'oidc') {
    const { client, publicUrl } = deps.auth;
    const redirectUri = `${publicUrl.replace(/\/$/, '')}/auth/callback`;
    const { calculatePKCECodeChallenge, randomPKCECodeVerifier } = await import('openid-client');

    app.get('/auth/login', async (req, reply) => {
      const flow = {
        verifier: randomPKCECodeVerifier(),
        state: randomBytes(16).toString('base64url'),
        nonce: randomBytes(16).toString('base64url'),
        returnTo: safeReturnTo((req.query as Record<string, unknown>)['returnTo']),
        exp: Date.now() + FLOW_TTL_MS,
      };
      const url = await client.authorizationUrl({
        redirectUri,
        state: flow.state,
        nonce: flow.nonce,
        codeChallenge: await calculatePKCECodeChallenge(flow.verifier),
      });
      return reply
        .setCookie(FLOW_COOKIE, sign(deps.sessionSecret, flow), cookieOptions(FLOW_TTL_MS))
        .redirect(url.toString());
    });

    app.get('/auth/callback', async (req, reply) => {
      const flow = unsign<{ verifier: string; state: string; nonce: string; returnTo: string; exp: number }>(
        deps.sessionSecret,
        req.cookies[FLOW_COOKIE],
      );
      if (!flow) return sendError(reply, 401, 'login_expired', 'login flow expired; try again');
      let user: User;
      try {
        const current = new URL(req.url, publicUrl);
        user = await client.exchange(current, {
          codeVerifier: flow.verifier,
          state: flow.state,
          nonce: flow.nonce,
          redirectUri,
        });
      } catch (err) {
        req.log.warn({ error: (err as Error).message }, 'oidc callback failed');
        return sendError(reply, 401, 'login_failed', 'sign-in failed');
      }
      return reply
        .clearCookie(FLOW_COOKIE, { path: '/' })
        .setCookie(
          SESSION_COOKIE,
          sign(deps.sessionSecret, { u: user, exp: Date.now() + SESSION_TTL_MS }),
          cookieOptions(SESSION_TTL_MS),
        )
        .redirect(safeReturnTo(flow.returnTo));
    });
  } else {
    app.get('/auth/login', async (req, reply) =>
      reply.redirect(safeReturnTo((req.query as Record<string, unknown>)['returnTo'])),
    );
  }

  // ------------------------------------------------------------ probes

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    const result = await deps.ready();
    return reply.code(result.ok ? 200 : 503).send(result);
  });

  // ------------------------------------------------------------ API (§13.7.2 + C-8)

  const userLabel = (req: FastifyRequest) => req.user?.email ?? req.user?.name ?? 'unknown';
  const settingView = (key: string) => deps.settings.list(deps.workflowRaw()).find((s) => s.key === key);

  route('/api/v1/state', { GET: () => deps.orchestrator.snapshot() });

  route('/api/v1/refresh', {
    POST: (_req, reply) => {
      const result = deps.orchestrator.requestRefresh();
      return reply
        .code(202)
        .send({ ...result, requested_at: new Date().toISOString(), operations: ['poll', 'reconcile'] });
    },
  });

  route('/api/v1/runs', {
    GET: async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const limit = q['limit'] === undefined ? 50 : Number(q['limit']);
      const offset = q['offset'] === undefined ? 0 : Number(q['offset']);
      const status = q['status'] || undefined;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
        return sendError(reply, 400, 'invalid_query', 'limit must be 1..200 and offset >= 0');
      }
      if (status && !RUN_STATUSES.has(status))
        return sendError(reply, 400, 'invalid_query', `unknown status ${status}`);
      if (!deps.runs)
        return sendError(reply, 503, 'persistence_unavailable', 'run history requires Postgres');
      try {
        return await deps.runs.listRuns({ limit, offset, ...(status ? { status } : {}) });
      } catch (err) {
        return sendError(reply, 503, 'persistence_unavailable', (err as Error).message);
      }
    },
  });

  route('/api/v1/queue', { GET: () => ({ retrying: deps.orchestrator.snapshot().retrying }) });

  route('/api/v1/workers', {
    GET: async (_req, reply) => {
      try {
        return { items: await deps.orchestrator.listWorkers() };
      } catch (err) {
        return sendError(reply, 503, 'workers_unavailable', (err as Error).message);
      }
    },
  });

  route('/api/v1/settings', { GET: () => ({ items: deps.settings.list(deps.workflowRaw()) }) });

  const settingsError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SettingsError) {
      const status = err.code === 'unknown_setting' ? 404 : err.code === 'invalid_value' ? 400 : 503;
      return sendError(reply, status, err.code, err.message);
    }
    throw err;
  };

  route('/api/v1/settings/:key', {
    GET: (req, reply) => {
      const view = settingView((req.params as { key: string }).key);
      return view ?? sendError(reply, 404, 'unknown_setting', 'unknown setting');
    },
    PUT: async (req, reply) => {
      const { key } = req.params as { key: string };
      try {
        await deps.settings.set(key, (req.body as { value?: unknown } | undefined)?.value, userLabel(req));
        return settingView(key);
      } catch (err) {
        return settingsError(reply, err);
      }
    },
    DELETE: async (req, reply) => {
      const { key } = req.params as { key: string };
      try {
        await deps.settings.reset(key, userLabel(req));
        return settingView(key);
      } catch (err) {
        return settingsError(reply, err);
      }
    },
  });

  route('/api/v1/events', {
    GET: (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('state', deps.orchestrator.snapshot());
      let pending: NodeJS.Timeout | null = null;
      const onState = () => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          send('state', deps.orchestrator.snapshot());
        }, 250);
      };
      const onAgent = (e: unknown) => send('agent_event', e);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      deps.orchestrator.on('state', onState);
      deps.orchestrator.on('agent_event', onAgent);
      req.raw.on('close', () => {
        clearInterval(heartbeat);
        if (pending) clearTimeout(pending);
        deps.orchestrator.off('state', onState);
        deps.orchestrator.off('agent_event', onAgent);
      });
    },
  });

  // Registered last: fixed routes above take precedence over the identifier parameter.
  route('/api/v1/:identifier', {
    GET: (req, reply) => {
      const { identifier } = req.params as { identifier: string };
      return (
        deps.orchestrator.issueDetails(identifier) ??
        sendError(reply, 404, 'issue_not_found', `issue ${identifier} is not known to this instance`)
      );
    },
  });

  // ------------------------------------------------------------ UI (§13.7.1)

  if (deps.staticDir) await app.register(fastifyStatic, { root: deps.staticDir, prefix: '/' });

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (deps.staticDir && req.method === 'GET' && !/^\/(api|auth|mcp|internal)(\/|$)/.test(path)) {
      return reply.sendFile('index.html');
    }
    return sendError(reply, 404, 'not_found', `no route for ${req.method} ${path}`);
  });

  app.setErrorHandler((err: { statusCode?: number; message: string }, req, reply) => {
    req.log.error({ error: err.message }, 'request failed');
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return sendError(
      reply,
      status,
      status === 500 ? 'internal_error' : 'bad_request',
      status === 500 ? 'internal error' : err.message,
    );
  });

  return app;
}

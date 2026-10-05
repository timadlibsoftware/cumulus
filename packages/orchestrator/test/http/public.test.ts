import type { StateSnapshot } from '@cumulus/shared';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySettingsBackend, SettingsStore } from '../../src/config/settings.js';
import { buildPublicServer, type OidcClient, type PublicServerDeps } from '../../src/http/public.js';

const snapshot: StateSnapshot = {
  generated_at: '2026-10-05T00:00:00.000Z',
  counts: { running: 0, retrying: 0 },
  running: [],
  retrying: [
    {
      issue_id: '1',
      issue_identifier: 'AB#1',
      issue_url: null,
      attempt: 2,
      due_at: '2026-10-05T00:00:10.000Z',
      error: 'x',
    },
  ],
  codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
  rate_limits: null,
  draining: false,
  config_error: null,
};

class FakeOrchestrator extends EventEmitter {
  refreshes = 0;
  snapshot() {
    return snapshot;
  }
  issueDetails(id: string) {
    return id === 'AB#1' ? { issue_identifier: 'AB#1', issue_id: '1', status: 'retrying' } : null;
  }
  requestRefresh() {
    this.refreshes++;
    return { queued: true, coalesced: this.refreshes > 1 };
  }
  async listWorkers() {
    return [{ name: 'pod-1', run_id: 'r1', issue_identifier: 'AB_1', phase: 'Running', created_at: null }];
  }
}

const fakeOidc: OidcClient = {
  authorizationUrl: ({ state, nonce, redirectUri }) =>
    new URL(
      `https://login.example/authorize?state=${state}&nonce=${nonce}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    ),
  exchange: async (url, checks) => {
    if (url.searchParams.get('state') !== checks.state) throw new Error('state mismatch');
    return { id: 'oid-1', name: 'Tim', email: 'tim@adlibsoftware.com' };
  },
};

let apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function build(overrides: Partial<PublicServerDeps> = {}) {
  const orchestrator = new FakeOrchestrator();
  const backend = new MemorySettingsBackend();
  const settings = new SettingsStore(backend, () => new Date('2026-10-05T00:00:00Z'));
  const app = await buildPublicServer({
    orchestrator,
    runs: {
      listRuns: async (q) => ({ items: [], total: q.status === 'failed' ? 3 : 0 }),
    },
    settings,
    workflowRaw: () => ({ agent: { max_concurrent_agents: 3 } }),
    ready: async () => ({ ok: true, checks: { workflow: 'ok' } }),
    auth: { mode: 'disabled' },
    sessionSecret: 'x'.repeat(32),
    staticDir: null,
    ...overrides,
  });
  apps.push(app);
  return { app, orchestrator, backend };
}

describe('public HTTP server (§13.7, C-8)', () => {
  it('serves health and readiness probes without auth', async () => {
    const { app } = await build({
      auth: { mode: 'oidc', client: fakeOidc, publicUrl: 'https://cumulus.example' },
    });
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    expect((await app.inject('/readyz')).json()).toEqual({ ok: true, checks: { workflow: 'ok' } });
  });

  it('readyz returns 503 when not ready', async () => {
    const { app } = await build({ ready: async () => ({ ok: false, checks: { tracker: 'unreachable' } }) });
    expect((await app.inject('/readyz')).statusCode).toBe(503);
  });

  it('§13.7.2 GET /api/v1/state returns the runtime snapshot', async () => {
    const { app } = await build();
    const res = await app.inject('/api/v1/state');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(snapshot);
  });

  it('§13.7.2 GET /api/v1/<identifier> returns issue details or a 404 envelope', async () => {
    const { app } = await build();
    expect((await app.inject('/api/v1/AB%231')).json()).toMatchObject({ issue_id: '1' });
    const missing = await app.inject('/api/v1/AB%23999');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: 'issue_not_found', message: 'issue AB#999 is not known to this instance' },
    });
  });

  it('§13.7.2 POST /api/v1/refresh returns 202 and coalesces', async () => {
    const { app } = await build();
    const first = await app.inject({ method: 'POST', url: '/api/v1/refresh' });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ queued: true, coalesced: false, operations: ['poll', 'reconcile'] });
    expect((await app.inject({ method: 'POST', url: '/api/v1/refresh', payload: {} })).json()).toMatchObject({
      coalesced: true,
    });
  });

  it('§13.7.2 unsupported methods on defined routes return 405 with an envelope', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/refresh' });
    expect(res.statusCode).toBe(405);
    expect(res.json()).toMatchObject({ error: { code: 'method_not_allowed' } });
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/state' })).statusCode).toBe(405);
  });

  it('C-8 lists runs with paging and status filter', async () => {
    const { app } = await build();
    expect((await app.inject('/api/v1/runs?limit=10&offset=0&status=failed')).json()).toEqual({
      items: [],
      total: 3,
    });
    expect((await app.inject('/api/v1/runs?limit=1000')).statusCode).toBe(400);
  });

  it('C-8 runs endpoint reports unavailable persistence', async () => {
    const { app } = await build({ runs: null });
    const res = await app.inject('/api/v1/runs');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'persistence_unavailable' } });
  });

  it('C-8 queue and workers', async () => {
    const { app } = await build();
    expect((await app.inject('/api/v1/queue')).json()).toEqual({ retrying: snapshot.retrying });
    expect((await app.inject('/api/v1/workers')).json()).toMatchObject({ items: [{ name: 'pod-1' }] });
  });

  it('C-6 settings: list, override with user, validation, reset', async () => {
    const { app } = await build();
    expect((await app.inject('/api/v1/settings')).json().items[0]).toMatchObject({
      workflow_value: 3,
      effective_value: 3,
    });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/agent.max_concurrent_agents',
      payload: { value: 7 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ override_value: 7, updated_by: 'local' });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/settings/agent.max_concurrent_agents',
          payload: { value: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/settings/nope', payload: { value: 1 } })).statusCode,
    ).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/settings/agent.max_concurrent_agents' });
    expect(del.json()).toMatchObject({ override_value: null, effective_value: 3 });
  });

  it('C-6 settings writes fail with 503 when storage is unavailable', async () => {
    const { app, backend } = await build();
    backend.fail = true;
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/agent.max_concurrent_agents',
      payload: { value: 2 },
    });
    expect(res.statusCode).toBe(503);
  });

  describe('Entra OIDC (C-8)', () => {
    const oidc = { auth: { mode: 'oidc' as const, client: fakeOidc, publicUrl: 'https://cumulus.example' } };

    it('rejects API calls without a session', async () => {
      const { app } = await build(oidc);
      const res = await app.inject('/api/v1/state');
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
      expect((await app.inject('/auth/me')).statusCode).toBe(401);
    });

    it('completes the login flow and records the signed-in user on settings changes', async () => {
      const { app } = await build(oidc);
      const login = await app.inject('/auth/login?returnTo=/settings');
      expect(login.statusCode).toBe(302);
      const location = new URL(login.headers.location as string);
      expect(location.origin).toBe('https://login.example');
      expect(location.searchParams.get('redirect_uri')).toBe('https://cumulus.example/auth/callback');
      const flowCookie = login.cookies.find((c) => c.name === 'cumulus_oidc')!;
      expect(flowCookie.httpOnly).toBe(true);

      const callback = await app.inject({
        url: `/auth/callback?code=abc&state=${location.searchParams.get('state')}`,
        cookies: { cumulus_oidc: flowCookie.value },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('/settings');
      const session = callback.cookies.find((c) => c.name === 'cumulus_session')!;
      expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });

      const cookies = { cumulus_session: session.value };
      expect((await app.inject({ url: '/auth/me', cookies })).json()).toEqual({
        name: 'Tim',
        email: 'tim@adlibsoftware.com',
      });
      expect((await app.inject({ url: '/api/v1/state', cookies })).statusCode).toBe(200);
      const put = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/agent.max_concurrent_agents',
        payload: { value: 4 },
        cookies,
      });
      expect(put.json()).toMatchObject({ updated_by: 'tim@adlibsoftware.com' });
    });

    it('rejects a callback whose state does not match', async () => {
      const { app } = await build(oidc);
      const login = await app.inject('/auth/login');
      const flowCookie = login.cookies.find((c) => c.name === 'cumulus_oidc')!;
      const res = await app.inject({
        url: '/auth/callback?code=abc&state=forged',
        cookies: { cumulus_oidc: flowCookie.value },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects tampered session cookies', async () => {
      const { app } = await build(oidc);
      const forged = Buffer.from(
        JSON.stringify({ u: { id: 'x', name: 'x', email: 'x' }, exp: Date.now() + 1e6 }),
      ).toString('base64url');
      expect(
        (await app.inject({ url: '/api/v1/state', cookies: { cumulus_session: `${forged}.bad` } }))
          .statusCode,
      ).toBe(401);
    });

    it('does not redirect to other origins after login', async () => {
      const { app } = await build(oidc);
      const login = await app.inject('/auth/login?returnTo=//evil.example/x');
      const location = new URL(login.headers.location as string);
      const flowCookie = login.cookies.find((c) => c.name === 'cumulus_oidc')!;
      const callback = await app.inject({
        url: `/auth/callback?code=a&state=${location.searchParams.get('state')}`,
        cookies: { cumulus_oidc: flowCookie.value },
      });
      expect(callback.headers.location).toBe('/');
    });

    it('rejects returnTo values that browsers normalize to another origin', async () => {
      const { app } = await build(oidc);
      for (const evil of [
        '%2F%09%2Fevil.com',
        '%2F%0A%2Fevil.com',
        '%2F%5Cevil.com',
        'https%3A%2F%2Fevil.com',
      ]) {
        const login = await app.inject(`/auth/login?returnTo=${evil}`);
        const location = new URL(login.headers.location as string);
        const flowCookie = login.cookies.find((c) => c.name === 'cumulus_oidc')!;
        const cb = await app.inject({
          url: `/auth/callback?code=a&state=${location.searchParams.get('state')}`,
          cookies: { cumulus_oidc: flowCookie.value },
        });
        expect(cb.statusCode).toBe(302);
        expect(cb.headers.location).toBe('/');
      }
    });

    it('enforces auth on percent-encoded API paths', async () => {
      const { app } = await build(oidc);
      expect((await app.inject('/%61pi/v1/state')).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/%61pi/v1/refresh' })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/%61pi/v1/settings/agent.max_concurrent_agents',
            payload: { value: 1 },
          })
        ).statusCode,
      ).toBe(401);
    });

    it('logout clears the session', async () => {
      const { app } = await build(oidc);
      const res = await app.inject('/auth/logout');
      expect(res.statusCode).toBe(302);
      expect(res.cookies.find((c) => c.name === 'cumulus_session')?.value).toBe('');
    });
  });

  it('C-8 streams state and agent events over SSE', async () => {
    const { app, orchestrator } = await build();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const res = await fetch(`${address}/api/v1/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let text = '';
    const read = async () => {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    };
    await read();
    expect(text).toContain('event: state\ndata: {');
    orchestrator.emit('agent_event', {
      run_id: 'r1',
      issue_identifier: 'AB#1',
      event: { event: 'notification', timestamp: 't' },
    });
    while (!text.includes('event: agent_event')) await read();
    expect(text).toContain('"run_id":"r1"');
    controller.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(orchestrator.listenerCount('agent_event')).toBe(0);
  });

  it('C-4 closing the server does not wait for open SSE streams', async () => {
    const { app } = await build();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/v1/events`);
    await res.body!.getReader().read();
    const closed = await Promise.race([
      app.close().then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('timeout'), 2000)),
    ]);
    expect(closed).toBe('closed');
    apps = apps.filter((a) => a !== app);
  });

  it('§13.7.1 serves the UI at / with SPA fallback but not for unknown API paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cumulus-ui-'));
    await writeFile(join(dir, 'index.html'), '<html>cumulus</html>');
    const { app } = await build({ staticDir: dir });
    expect((await app.inject('/')).body).toContain('cumulus');
    expect((await app.inject('/runs')).body).toContain('cumulus');
    const api = await app.inject('/api/v2/nothing');
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

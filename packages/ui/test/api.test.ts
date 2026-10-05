import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, loginUrl, navigation } from '@/api';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('api client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  const lastCall = () => fetchMock.mock.calls.at(-1) as [string, RequestInit];

  it('C-8 GET /api/v1/state returns the snapshot', async () => {
    fetchMock.mockResolvedValue(json({ counts: { running: 1, retrying: 0 } }));
    const snap = await api.state();
    expect(lastCall()[0]).toBe('/api/v1/state');
    expect(lastCall()[1].method ?? 'GET').toBe('GET');
    expect(snap.counts.running).toBe(1);
  });

  it('C-8 GET /api/v1/runs passes limit, offset and status', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ items: [], total: 0 })));
    await api.runs({ limit: 25, offset: 50, status: 'failed' });
    expect(lastCall()[0]).toBe('/api/v1/runs?limit=25&offset=50&status=failed');
    await api.runs({ limit: 10, offset: 0 });
    expect(lastCall()[0]).toBe('/api/v1/runs?limit=10&offset=0');
  });

  it('C-8 GET /api/v1/queue, /workers, /settings', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ items: [], retrying: [] })));
    await api.queue();
    expect(lastCall()[0]).toBe('/api/v1/queue');
    await api.workers();
    expect(lastCall()[0]).toBe('/api/v1/workers');
    await api.settings();
    expect(lastCall()[0]).toBe('/api/v1/settings');
  });

  it('C-6 PUT /api/v1/settings/:key sends { value }', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await api.putSetting('agent.max_concurrent_agents', 3);
    const [url, init] = lastCall();
    expect(url).toBe('/api/v1/settings/agent.max_concurrent_agents');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ value: 3 });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('C-6 DELETE /api/v1/settings/:key resets and encodes the key', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await api.deleteSetting('a/b');
    const [url, init] = lastCall();
    expect(url).toBe('/api/v1/settings/a%2Fb');
    expect(init.method).toBe('DELETE');
  });

  it('GET /auth/me returns the signed-in user', async () => {
    fetchMock.mockResolvedValue(json({ name: 'Tim', email: 't@example.com' }));
    expect(await api.me()).toEqual({ name: 'Tim', email: 't@example.com' });
    expect(lastCall()[0]).toBe('/auth/me');
  });

  it('C-8 a 401 redirects to /auth/login with the current path as returnTo', async () => {
    window.history.replaceState(null, '', '/runs?page=2');
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(api.state()).rejects.toBeInstanceOf(ApiError);
    expect(assign).toHaveBeenCalledWith('/auth/login?returnTo=%2Fruns%3Fpage%3D2');
  });

  it('turns an error body into an ApiError with code and message', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'invalid_value', message: 'must be >= 1' } }, 400));
    const err = await api.putSetting('k', 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_value', message: 'must be >= 1' });
  });

  it('handles a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 502 }));
    const err = await api.workers().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'http_502' });
  });

  it('loginUrl encodes returnTo', () => {
    expect(loginUrl('/a b?x=1')).toBe('/auth/login?returnTo=%2Fa%20b%3Fx%3D1');
  });
});

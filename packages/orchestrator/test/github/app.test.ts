import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubApp, createAppJwt } from '../../src/github/app.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function fakeGitHub(now: () => number) {
  const calls: { method: string; path: string; auth: string | null }[] = [];
  let tokenN = 0;
  const refs: Record<string, string[]> = {
    'aks-gitops': ['refs/heads/cumulus/AB_1-x', 'refs/heads/cumulus/AB_2-y'],
    'tf-org': [],
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ method, path: url.pathname + url.search, auth });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/orgs/Adlibsoftware/installation') return json({ id: 77 });
    if (url.pathname === '/app/installations/77/access_tokens') {
      return json({ token: `ghs_${++tokenN}`, expires_at: new Date(now() + 3600_000).toISOString() }, 201);
    }
    if (url.pathname === '/installation/repositories') {
      const page = url.searchParams.get('page') ?? '1';
      const all = Object.keys(refs).map((name) => ({ name, archived: false }));
      if (page === '1') {
        return new Response(JSON.stringify({ total_count: 2, repositories: all.slice(0, 1) }), {
          status: 200,
          headers: {
            link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
          },
        });
      }
      return json({ total_count: 2, repositories: all.slice(1) });
    }
    const m = /^\/repos\/Adlibsoftware\/([^/]+)\/git\/matching-refs\/heads\/(.*)$/.exec(url.pathname);
    if (m)
      return json(
        (refs[m[1]!] ?? [])
          .filter((r) => r.startsWith(`refs/heads/${decodeURIComponent(m[2]!)}`))
          .map((ref) => ({ ref })),
      );
    const d = /^\/repos\/Adlibsoftware\/([^/]+)\/git\/refs\/heads\/(.*)$/.exec(url.pathname);
    if (d && method === 'DELETE') {
      const ref = `refs/heads/${decodeURIComponent(d[2]!)}`;
      refs[d[1]!] = (refs[d[1]!] ?? []).filter((r) => r !== ref);
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls, refs };
}

describe('GitHub App client (C-10)', () => {
  it('signs an RS256 app JWT with clock-skew backdating', () => {
    const jwt = createAppJwt('123', pem, 1_000_000_000_000);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
      iat: 999_999_940,
      exp: 1_000_000_540,
      iss: '123',
    });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${h}.${p}`),
        createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })),
        Buffer.from(s!, 'base64url'),
      ),
    ).toBe(true);
  });

  it('mints and caches an org installation token until shortly before expiry', async () => {
    let t = Date.parse('2026-10-05T00:00:00Z');
    const gh = fakeGitHub(() => t);
    const app = new GitHubApp({
      appId: '1',
      privateKey: pem,
      org: 'Adlibsoftware',
      fetch: gh.fetch,
      now: () => t,
    });
    const a = await app.installationToken();
    const b = await app.installationToken();
    expect(a.token).toBe('ghs_1');
    expect(b.token).toBe('ghs_1');
    t += 56 * 60_000;
    expect((await app.installationToken()).token).toBe('ghs_2');
    expect(gh.calls.filter((c) => c.path === '/orgs/Adlibsoftware/installation')).toHaveLength(1);
    expect(gh.calls.find((c) => c.path.includes('access_tokens'))!.auth).toMatch(/^Bearer ey/);
  });

  it('lists installation repositories across pages', async () => {
    const gh = fakeGitHub(() => Date.now());
    const app = new GitHubApp({ appId: '1', privateKey: pem, org: 'Adlibsoftware', fetch: gh.fetch });
    expect(await app.listRepos()).toEqual(['aks-gitops', 'tf-org']);
  });

  it('finds and deletes cumulus branches', async () => {
    const gh = fakeGitHub(() => Date.now());
    const app = new GitHubApp({ appId: '1', privateKey: pem, org: 'Adlibsoftware', fetch: gh.fetch });
    expect(await app.branches('aks-gitops', 'cumulus/')).toEqual(['cumulus/AB_1-x', 'cumulus/AB_2-y']);
    await app.deleteBranch('aks-gitops', 'cumulus/AB_1-x');
    expect(gh.refs['aks-gitops']).toEqual(['refs/heads/cumulus/AB_2-y']);
    await expect(app.deleteBranch('aks-gitops', 'cumulus/gone')).resolves.toBeUndefined();
  });

  it('surfaces GitHub API errors', async () => {
    const app = new GitHubApp({
      appId: '1',
      privateKey: pem,
      org: 'Adlibsoftware',
      fetch: async () => new Response('{"message":"Bad credentials"}', { status: 401 }),
    });
    await expect(app.installationToken()).rejects.toThrow(/401.*Bad credentials/);
  });
});

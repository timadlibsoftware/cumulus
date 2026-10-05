import { createSign } from 'node:crypto';

const API = 'https://api.github.com';
const REFRESH_BEFORE_MS = 5 * 60_000;

/** GitHub App JWT (RS256), backdated 60 s for clock skew, valid 10 min. */
export function createAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signature = createSign('RSA-SHA256').update(body).sign(privateKeyPem).toString('base64url');
  return `${body}.${signature}`;
}

export interface GitHubAppOptions {
  appId: string;
  privateKey: string;
  org: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/** C-10: the `cumulus` GitHub App. Mints org installation tokens for agents and manages branches (C-9). */
export class GitHubApp {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private installationId: number | null = null;
  private cached: InstallationToken | null = null;

  constructor(private readonly options: GitHubAppOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get org(): string {
    return this.options.org;
  }

  private async call<T>(
    method: string,
    path: string,
    auth: string,
    okEmpty = false,
  ): Promise<{ body: T; res: Response }> {
    const res = await this.fetchFn(path.startsWith('http') ? path : `${API}${path}`, {
      method,
      headers: {
        authorization: auth,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'cumulus',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`GitHub ${method} ${path} returned ${res.status}: ${text}`);
    }
    if (okEmpty || res.status === 204) return { body: undefined as T, res };
    return { body: (await res.json()) as T, res };
  }

  private appAuth(): string {
    return `Bearer ${createAppJwt(this.options.appId, this.options.privateKey, this.now())}`;
  }

  async installationToken(): Promise<InstallationToken> {
    if (this.cached && Date.parse(this.cached.expiresAt) - this.now() > REFRESH_BEFORE_MS) return this.cached;
    if (this.installationId === null) {
      const { body } = await this.call<{ id: number }>(
        'GET',
        `/orgs/${encodeURIComponent(this.options.org)}/installation`,
        this.appAuth(),
      );
      this.installationId = body.id;
    }
    const { body } = await this.call<{ token: string; expires_at: string }>(
      'POST',
      `/app/installations/${this.installationId}/access_tokens`,
      this.appAuth(),
    );
    this.cached = { token: body.token, expiresAt: body.expires_at };
    return this.cached;
  }

  private async tokenAuth(): Promise<string> {
    return `Bearer ${(await this.installationToken()).token}`;
  }

  async listRepos(): Promise<string[]> {
    const names: string[] = [];
    let next: string | null = '/installation/repositories?per_page=100';
    while (next) {
      const { body, res }: { body: { repositories: { name: string; archived?: boolean }[] }; res: Response } =
        await this.call('GET', next, await this.tokenAuth());
      names.push(...body.repositories.filter((r) => !r.archived).map((r) => r.name));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
    }
    return names;
  }

  /** Branch names in `repo` starting with `prefix`. */
  async branches(repo: string, prefix: string): Promise<string[]> {
    const { body } = await this.call<{ ref: string }[]>(
      'GET',
      `/repos/${encodeURIComponent(this.options.org)}/${encodeURIComponent(repo)}/git/matching-refs/heads/${prefix}`,
      await this.tokenAuth(),
    );
    return body.map((r) => r.ref.replace(/^refs\/heads\//, ''));
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    try {
      await this.call(
        'DELETE',
        `/repos/${encodeURIComponent(this.options.org)}/${encodeURIComponent(repo)}/git/refs/heads/${branch}`,
        await this.tokenAuth(),
        true,
      );
    } catch (err) {
      if (/returned (404|422)/.test((err as Error).message)) return;
      throw err;
    }
  }
}

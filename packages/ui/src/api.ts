import type {
  ApiError as ApiErrorBody,
  RetryRow,
  RunRecord,
  RunStatus,
  SettingView,
  StateSnapshot,
  WorkerRow,
} from '@cumulus/shared';

export interface Page<T> {
  items: T[];
  total: number;
}

export interface Me {
  name: string;
  email: string;
}

export interface RunsQuery {
  limit: number;
  offset: number;
  status?: RunStatus;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Indirection so tests can observe navigation without leaving the page. */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

export function loginUrl(returnTo: string): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

async function toError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | undefined;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    body = undefined;
  }
  const code = body?.error?.code ?? `http_${res.status}`;
  const message = body?.error?.message ?? `${res.status} ${res.statusText}`.trim();
  return new ApiError(res.status, code, message);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (res.status === 401) {
    navigation.assign(loginUrl(window.location.pathname + window.location.search));
    throw new ApiError(401, 'unauthenticated', 'Sign-in required');
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const settingPath = (key: string) => `/api/v1/settings/${encodeURIComponent(key)}`;

export const api = {
  state: () => request<StateSnapshot>('/api/v1/state'),
  runs: ({ limit, offset, status }: RunsQuery) => {
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (status) q.set('status', status);
    return request<Page<RunRecord>>(`/api/v1/runs?${q}`);
  },
  queue: () => request<{ retrying: RetryRow[] }>('/api/v1/queue'),
  workers: () => request<{ items: WorkerRow[] }>('/api/v1/workers'),
  settings: () => request<{ items: SettingView[] }>('/api/v1/settings'),
  putSetting: async (key: string, value: number): Promise<void> => {
    await request(settingPath(key), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  },
  deleteSetting: async (key: string): Promise<void> => {
    await request(settingPath(key), { method: 'DELETE' });
  },
  me: () => request<Me>('/auth/me'),
};

/** Minimal fake of the Azure DevOps REST endpoints the adapter uses. Shapes follow real responses. */

export interface FakeWorkItem {
  id: number;
  fields: Record<string, unknown>;
  relations?: { rel: string; url: string; attributes?: Record<string, unknown> }[];
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

const COLUMN_FIELD = 'WEF_ABC_Kanban.Column';

export function adoItem(
  id: number,
  column: string,
  extra: Record<string, unknown> = {},
  relations: FakeWorkItem['relations'] = [],
): FakeWorkItem {
  return {
    id,
    fields: {
      'System.Id': id,
      'System.Title': `Item ${id}`,
      'System.State': 'Active',
      'System.BoardColumn': column,
      [COLUMN_FIELD]: column,
      'System.AreaPath': 'AdlibCTP\\DevOps',
      'System.IterationPath': 'AdlibCTP\\Backlogs\\DevOps',
      'System.TeamProject': 'AdlibCTP',
      'System.WorkItemType': 'User Story',
      'System.Tags': 'cumulus',
      'System.CreatedDate': '2026-09-25T15:59:09.08Z',
      'System.ChangedDate': '2026-10-02T20:16:52.24Z',
      ...extra,
    },
    relations,
  };
}

export function predecessor(id: number) {
  return {
    rel: 'System.LinkTypes.Dependency-Reverse',
    url: `https://dev.azure.com/adlibsoftware/_apis/wit/workItems/${id}`,
    attributes: { name: 'Predecessor' },
  };
}

export class FakeAdo {
  items = new Map<number, FakeWorkItem>();
  requests: RecordedRequest[] = [];
  /** Queue of forced responses for the next requests (status/body or a thrown error). */
  forced: ({ status: number; body: string; headers?: Record<string, string> } | Error)[] = [];
  wiqlTop: number | null = null;

  constructor(items: FakeWorkItem[] = []) {
    for (const item of items) this.items.set(item.id, item);
  }

  get providerCalls(): number {
    return this.requests.length;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, url, headers, body });

    const forced = this.forced.shift();
    if (forced instanceof Error) throw forced;
    if (forced) return new Response(forced.body, { status: forced.status, headers: forced.headers });

    const path = url.pathname;
    if (path.endsWith('/_apis/wit/wiql')) return this.wiql(url, body as { query: string });
    if (path.endsWith('/_apis/wit/workitemsbatch')) return this.batch(body as { ids: number[] });
    if (/\/_apis\/work\/boards\/[^/]+$/.test(path)) return json(this.board());
    const patch = /\/_apis\/wit\/workitems\/(\d+)$/.exec(path);
    if (patch && method === 'PATCH')
      return this.patch(Number(patch[1]), body as { op: string; path: string; value: unknown }[]);
    const comment = /\/_apis\/wit\/workItems\/(\d+)\/comments$/.exec(path);
    if (comment && method === 'POST')
      return json({ id: 1, workItemId: Number(comment[1]), text: (body as { text: string }).text });
    return new Response('not found', { status: 404 });
  };

  private wiql(url: URL, body: { query: string }): Response {
    const query = body.query;
    const columns = [...query.matchAll(/'([^']*(?:''[^']*)*)'/g)].map((m) => m[1]!.replaceAll("''", "'"));
    const inClause = /\[System\.BoardColumn\] IN \(([^)]*)\)/.exec(query);
    const wanted = inClause
      ? new Set([...inClause[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!.toLowerCase()))
      : null;
    void columns;
    let ids = [...this.items.values()]
      .filter((i) => String(i.fields['System.AreaPath']).startsWith('AdlibCTP\\DevOps'))
      .filter((i) => !wanted || wanted.has(String(i.fields['System.BoardColumn'] ?? '').toLowerCase()))
      .map((i) => i.id)
      .sort((a, b) => a - b);
    const top = Number(url.searchParams.get('$top') ?? 20000);
    ids = ids.slice(0, this.wiqlTop ?? top);
    return json({ queryType: 'flat', workItems: ids.map((id) => ({ id, url: `https://x/${id}` })) });
  }

  private batch(body: { ids: number[] }): Response {
    if (body.ids.length > 200) return new Response('too many ids', { status: 400 });
    const value = body.ids.map((id) => this.items.get(id)).filter((i) => i !== undefined);
    return json({
      count: value.length,
      value: value.map((i) => ({ ...i, rev: 3, url: `https://x/${i.id}` })),
    });
  }

  private board() {
    return {
      columns: [
        { name: 'Backlog', columnType: 'incoming', stateMappings: { 'User Story': 'Active', Bug: 'Active' } },
        { name: 'Dev', columnType: 'inProgress', stateMappings: { 'User Story': 'Active', Bug: 'Active' } },
        {
          name: 'Test',
          columnType: 'inProgress',
          stateMappings: { 'User Story': 'Resolved', Bug: 'Active' },
        },
        {
          name: 'Review',
          columnType: 'inProgress',
          stateMappings: { 'User Story': 'Active', Bug: 'Active' },
        },
        { name: 'Closed', columnType: 'outgoing', stateMappings: { 'User Story': 'Closed', Bug: 'Closed' } },
      ],
      fields: { columnField: { referenceName: COLUMN_FIELD } },
    };
  }

  private patch(id: number, ops: { op: string; path: string; value: unknown }[]): Response {
    const item = this.items.get(id);
    if (!item) return new Response('missing', { status: 404 });
    for (const op of ops) {
      const field = op.path.replace('/fields/', '');
      item.fields[field] = op.value;
      if (field === COLUMN_FIELD) item.fields['System.BoardColumn'] = op.value;
    }
    return json({ id, fields: item.fields });
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

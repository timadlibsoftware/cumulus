import type { BlockerRef, Issue } from '@cumulus/shared';
import { resolveEnvRef } from '../config/config.js';
import { TrackerError, unsupportedTool, type ToolResult, type ToolSpec, type Tracker } from './types.js';

/**
 * Azure DevOps adapter (`tracker.kind: azure_devops`). Profile: docs/adapters/azure-devops.md (C-1).
 */

const ADO_RESOURCE_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';
const BATCH_SIZE = 200;
const BLOCKER_REL = 'System.LinkTypes.Dependency-Reverse';

export interface AzureDevOpsProvider {
  baseUrl: string;
  organization: string;
  project: string;
  team: string;
  board: string;
  areaPath: string;
  iterationPath: string | null;
  workItemTypes: string[];
  agentColumns: string[];
  blockerDoneStates: string[];
  maxResults: number;
  pat: string | null;
  patEnvName: string | null;
}

export interface AzureDevOpsDeps {
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Returns an Entra access token for Azure DevOps. Defaults to workload identity. */
  token?: () => Promise<string>;
  logger?: { warn(obj: object, msg: string): void };
}

interface TrackerSettings {
  provider: Record<string, unknown>;
  activeStates: string[];
  terminalStates: string[];
}

interface RawWorkItem {
  id: number;
  rev?: number;
  fields: Record<string, unknown>;
  relations?: { rel: string; url: string }[] | null;
}

interface Board {
  columnField: string;
  columns: { name: string; stateMappings: Record<string, string> }[];
}

function requiredString(p: Record<string, unknown>, key: string): string {
  const value = p[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TrackerError('invalid_tracker_config', `tracker.provider.${key} is required`);
  }
  return value;
}

function optionalStringList(p: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = p[key];
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new TrackerError('invalid_tracker_config', `tracker.provider.${key} must be a list of strings`);
  }
  return value as string[];
}

export function parseProvider(
  p: Record<string, unknown>,
  env: Record<string, string | undefined>,
): AzureDevOpsProvider {
  let pat: string | null = null;
  let patEnvName: string | null = null;
  if (p['pat'] !== undefined && p['pat'] !== null) {
    const raw = String(p['pat']);
    patEnvName = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw.trim())?.[1] ?? null;
    pat = resolveEnvRef(raw, env);
    if (pat === '')
      throw new TrackerError('missing_tracker_secret', 'tracker.provider.pat resolved to an empty value');
  }
  const maxResults = p['max_results'] ?? 20000;
  if (
    typeof maxResults !== 'number' ||
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > 20000
  ) {
    throw new TrackerError(
      'invalid_tracker_config',
      'tracker.provider.max_results must be an integer 1..20000',
    );
  }
  return {
    baseUrl: typeof p['base_url'] === 'string' ? p['base_url'].replace(/\/$/, '') : 'https://dev.azure.com',
    organization: requiredString(p, 'organization'),
    project: requiredString(p, 'project'),
    team: requiredString(p, 'team'),
    board: typeof p['board'] === 'string' ? p['board'] : 'Stories',
    areaPath: requiredString(p, 'area_path'),
    iterationPath: typeof p['iteration_path'] === 'string' ? p['iteration_path'] : null,
    workItemTypes: optionalStringList(p, 'work_item_types', ['User Story', 'Bug']),
    agentColumns: optionalStringList(p, 'agent_columns', ['Dev', 'Test', 'Review']),
    blockerDoneStates: optionalStringList(p, 'blocker_done_states', ['Closed', 'Removed', 'Done']),
    maxResults,
    pat,
    patEnvName,
  };
}

export function createAzureDevOpsTracker(
  settings: TrackerSettings,
  deps: AzureDevOpsDeps,
): AzureDevOpsTracker {
  return new AzureDevOpsTracker(parseProvider(settings.provider, deps.env), deps);
}

const wiqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;
const lower = (s: string) => s.trim().toLowerCase();

function under(path: unknown, root: string): boolean {
  if (typeof path !== 'string') return false;
  const p = path.toLowerCase();
  const r = root.toLowerCase();
  return p === r || p.startsWith(`${r}\\`);
}

function htmlToText(html: unknown): string | null {
  if (typeof html !== 'string' || html.trim() === '') return null;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? null : text;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function relationId(url: string): string | null {
  const m = /\/workItems\/(\d+)$/i.exec(url);
  return m ? m[1]! : null;
}

export class AzureDevOpsTracker implements Tracker {
  readonly kind = 'azure_devops';
  private readonly fetchFn: typeof fetch;
  private board: Board | null = null;

  constructor(
    readonly provider: AzureDevOpsProvider,
    private readonly deps: AzureDevOpsDeps,
  ) {
    this.fetchFn = deps.fetch ?? fetch;
  }

  private get projectUrl(): string {
    const p = this.provider;
    return `${p.baseUrl}/${encodeURIComponent(p.organization)}/${encodeURIComponent(p.project)}`;
  }

  private async authHeader(): Promise<string> {
    if (this.provider.pat) return `Basic ${Buffer.from(`:${this.provider.pat}`).toString('base64')}`;
    if (this.deps.token) return `Bearer ${await this.deps.token()}`;
    const { DefaultAzureCredential } = await import('@azure/identity');
    const token = await new DefaultAzureCredential().getToken(ADO_RESOURCE_SCOPE);
    if (!token)
      throw new TrackerError('missing_tracker_secret', 'no Azure DevOps token from workload identity');
    return `Bearer ${token.token}`;
  }

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          authorization: await this.authHeader(),
          'content-type': contentType,
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw new TrackerError('tracker_request', `Azure DevOps request failed: ${(err as Error).message}`);
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new TrackerError(
        'tracker_rate_limited',
        'Azure DevOps rate limit exceeded',
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new TrackerError('tracker_status', `Azure DevOps returned ${res.status}: ${text}`);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new TrackerError('tracker_response', 'Azure DevOps returned a non-JSON response');
    }
  }

  private async fetchBatch(ids: number[]): Promise<RawWorkItem[]> {
    const out: RawWorkItem[] = [];
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      const data = await this.request<{ value?: (RawWorkItem | null)[] }>(
        'POST',
        `${this.projectUrl}/_apis/wit/workitemsbatch?api-version=7.1`,
        { ids: chunk, $expand: 'Relations', errorPolicy: 'Omit' },
      );
      if (!Array.isArray(data.value))
        throw new TrackerError('tracker_response', 'workitemsbatch response has no value list');
      const byId = new Map(
        data.value.filter((w): w is RawWorkItem => !!w && typeof w.id === 'number').map((w) => [w.id, w]),
      );
      for (const id of chunk) {
        const item = byId.get(id);
        if (item) out.push(item);
      }
    }
    return out;
  }

  private inScope(item: RawWorkItem): boolean {
    const f = item.fields;
    const p = this.provider;
    if (!under(f['System.AreaPath'], p.areaPath)) return false;
    if (p.iterationPath && !under(f['System.IterationPath'], p.iterationPath)) return false;
    return p.workItemTypes.map(lower).includes(lower(String(f['System.WorkItemType'] ?? '')));
  }

  private async blockerStates(items: RawWorkItem[]): Promise<Map<string, string | null>> {
    const known = new Map<string, string | null>(
      items.map((i) => [String(i.id), nonEmptyString(i.fields['System.State'])]),
    );
    const missing = new Set<number>();
    for (const item of items) {
      for (const rel of item.relations ?? []) {
        if (rel.rel !== BLOCKER_REL) continue;
        const id = relationId(rel.url);
        if (id && !known.has(id)) missing.add(Number(id));
      }
    }
    if (missing.size > 0) {
      for (const item of await this.fetchBatch([...missing])) {
        known.set(String(item.id), nonEmptyString(item.fields['System.State']));
      }
    }
    return known;
  }

  /** Returns null when the record cannot produce the required fields (§11.1 malformed). */
  private normalize(item: RawWorkItem, states: Map<string, string | null>): Issue | null {
    const f = item.fields;
    const title = nonEmptyString(f['System.Title']);
    const state = nonEmptyString(f['System.BoardColumn']) ?? nonEmptyString(f['System.State']);
    if (typeof item.id !== 'number' || !title || !state) return null;

    const blockedBy: BlockerRef[] = (item.relations ?? [])
      .filter((r) => r.rel === BLOCKER_REL)
      .flatMap((r) => {
        const id = relationId(r.url);
        return id ? [{ id, identifier: `AB#${id}`, state: states.get(id) ?? null }] : [];
      });
    const done = this.provider.blockerDoneStates.map(lower);
    const blocked = blockedBy.some((b) => b.state !== null && !done.includes(lower(b.state)));

    const description = htmlToText(f['System.Description']);
    const acceptance = htmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria']);
    const assignee = f['System.AssignedTo'] as { uniqueName?: string; id?: string } | string | undefined;
    const priority = f['Microsoft.VSTS.Common.Priority'];
    const labels = [
      ...new Set(
        String(f['System.Tags'] ?? '')
          .split(';')
          .map(lower)
          .filter((l) => l !== ''),
      ),
    ];

    return {
      id: String(item.id),
      native_ref: {
        work_item_id: item.id,
        rev: item.rev ?? null,
        work_item_type: nonEmptyString(f['System.WorkItemType']),
        area_path: nonEmptyString(f['System.AreaPath']),
        project: nonEmptyString(f['System.TeamProject']),
      },
      identifier: `AB#${item.id}`,
      title,
      description: acceptance
        ? `${description ?? ''}\n\nAcceptance criteria:\n${acceptance}`.trim()
        : description,
      priority: typeof priority === 'number' && Number.isInteger(priority) ? priority : null,
      state,
      branch_name: null,
      url: `${this.projectUrl}/_workitems/edit/${item.id}`,
      assignee_id:
        typeof assignee === 'string'
          ? assignee
          : (nonEmptyString(assignee?.uniqueName) ?? nonEmptyString(assignee?.id)),
      labels,
      blocked_by: blockedBy,
      dispatchable: this.inScope(item) && !blocked,
      created_at: timestamp(f['System.CreatedDate']),
      updated_at: timestamp(f['System.ChangedDate']),
    };
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    const p = this.provider;
    const clauses = [
      `[System.TeamProject] = ${wiqlString(p.project)}`,
      `[System.AreaPath] UNDER ${wiqlString(p.areaPath)}`,
      ...(p.iterationPath ? [`[System.IterationPath] UNDER ${wiqlString(p.iterationPath)}`] : []),
      `[System.WorkItemType] IN (${p.workItemTypes.map(wiqlString).join(', ')})`,
      `[System.BoardColumn] IN (${stateNames.map(wiqlString).join(', ')})`,
    ];
    const query = `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.Id]`;
    const data = await this.request<{ workItems?: { id: number }[] }>(
      'POST',
      `${this.projectUrl}/_apis/wit/wiql?$top=${p.maxResults}&api-version=7.1`,
      { query },
    );
    if (!Array.isArray(data.workItems))
      throw new TrackerError('tracker_response', 'WIQL response has no workItems list');
    if (data.workItems.length >= p.maxResults) {
      throw new TrackerError(
        'tracker_pagination',
        `WIQL result reached the ${p.maxResults} item cap; results may be truncated`,
      );
    }
    const items = await this.fetchBatch(data.workItems.map((w) => w.id));
    const states = await this.blockerStates(items);
    return items.flatMap((item) => {
      const issue = this.normalize(item, states);
      if (!issue) {
        this.deps.logger?.warn({ work_item_id: item.id }, 'omitting malformed work item from candidate list');
        return [];
      }
      return [issue];
    });
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    const ids = [...new Set(issueIds)].map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const items = (await this.fetchBatch(ids)).filter((item) => this.inScope(item));
    const states = await this.blockerStates(items);
    return items.map((item) => {
      const issue = this.normalize(item, states);
      if (!issue)
        throw new TrackerError('tracker_response', `work item ${item.id} is missing required fields`);
      return issue;
    });
  }

  secretEnvironmentNames(): string[] {
    return [
      ...new Set([
        ...(this.provider.patEnvName ? [this.provider.patEnvName] : []),
        'ADO_PAT',
        'AZURE_DEVOPS_EXT_PAT',
        'SYSTEM_ACCESSTOKEN',
      ]),
    ];
  }

  agentToolSpecs(): ToolSpec[] {
    return [
      {
        name: 'azure_devops_move_card',
        description: `Move the current work item to another column on the ${this.provider.team} ${this.provider.board} board. Allowed columns: ${this.provider.agentColumns.join(', ')}. Move it to Review once your pull requests are open.`,
        inputSchema: {
          type: 'object',
          properties: { column: { type: 'string', enum: this.provider.agentColumns } },
          required: ['column'],
          additionalProperties: false,
        },
      },
      {
        name: 'azure_devops_add_comment',
        description:
          'Add a Markdown comment to the current work item (for example links to the pull requests you opened).',
        inputSchema: {
          type: 'object',
          properties: { markdown: { type: 'string', minLength: 1, maxLength: 100000 } },
          required: ['markdown'],
          additionalProperties: false,
        },
      },
    ];
  }

  private async loadBoard(): Promise<Board> {
    if (this.board) return this.board;
    const p = this.provider;
    const data = await this.request<{
      columns?: { name: string; stateMappings?: Record<string, string> }[];
      fields?: { columnField?: { referenceName?: string } };
    }>(
      'GET',
      `${this.projectUrl}/${encodeURIComponent(p.team)}/_apis/work/boards/${encodeURIComponent(p.board)}?api-version=7.1`,
    );
    const columnField = data.fields?.columnField?.referenceName;
    if (!columnField || !Array.isArray(data.columns))
      throw new TrackerError('tracker_response', 'board response is missing columns');
    this.board = {
      columnField,
      columns: data.columns.map((c) => ({ name: c.name, stateMappings: c.stateMappings ?? {} })),
    };
    return this.board;
  }

  async executeAgentTool(name: string, args: unknown, context: { issue: Issue }): Promise<ToolResult> {
    const a = (args ?? {}) as Record<string, unknown>;
    const invalid = (message: string): ToolResult => ({
      ok: false,
      output: { error: { code: 'invalid_arguments', message } },
    });
    try {
      if (name === 'azure_devops_move_card') {
        const column = this.provider.agentColumns.find(
          (c) => typeof a['column'] === 'string' && lower(c) === lower(a['column']),
        );
        if (!column) return invalid(`column must be one of ${this.provider.agentColumns.join(', ')}`);
        const board = await this.loadBoard();
        const mapping = board.columns.find((c) => lower(c.name) === lower(column));
        const type = String(context.issue.native_ref?.['work_item_type'] ?? '');
        const state = mapping?.stateMappings[type];
        const ops = [
          ...(state ? [{ op: 'add', path: '/fields/System.State', value: state }] : []),
          { op: 'add', path: `/fields/${board.columnField}`, value: mapping?.name ?? column },
        ];
        await this.request(
          'PATCH',
          `${this.projectUrl}/_apis/wit/workitems/${encodeURIComponent(context.issue.id)}?api-version=7.1`,
          ops,
          'application/json-patch+json',
        );
        return { ok: true, output: { work_item: context.issue.identifier, column: mapping?.name ?? column } };
      }
      if (name === 'azure_devops_add_comment') {
        if (typeof a['markdown'] !== 'string' || a['markdown'].trim() === '')
          return invalid('markdown must be a non-empty string');
        const res = await this.request<{ id?: number }>(
          'POST',
          `${this.projectUrl}/_apis/wit/workItems/${encodeURIComponent(context.issue.id)}/comments?format=markdown&api-version=7.1-preview.4`,
          { text: a['markdown'] },
        );
        return { ok: true, output: { work_item: context.issue.identifier, comment_id: res.id ?? null } };
      }
      return unsupportedTool(name);
    } catch (err) {
      const code = err instanceof TrackerError ? err.category : 'tool_error';
      return { ok: false, output: { error: { code, message: (err as Error).message } } };
    }
  }
}

import type { Issue } from '@cumulus/shared';

/** §11.4 recommended adapter error categories. */
export type TrackerErrorCategory =
  | 'unsupported_tracker_kind'
  | 'invalid_tracker_config'
  | 'missing_tracker_secret'
  | 'tracker_request'
  | 'tracker_status'
  | 'tracker_response'
  | 'tracker_pagination'
  | 'tracker_rate_limited';

export class TrackerError extends Error {
  constructor(
    readonly category: TrackerErrorCategory,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TrackerError';
  }
}

/** JSON-schema tool spec advertised to agent sessions (§10.5 provider-native tools). */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: Record<string, unknown>;
}

/** §11.1 required operations plus the optional §10.5 tool hooks. */
export interface Tracker {
  readonly kind: string;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssuesByIds(issueIds: string[]): Promise<Issue[]>;
  secretEnvironmentNames(): string[];
  agentToolSpecs(): ToolSpec[];
  executeAgentTool(name: string, args: unknown, context: { issue: Issue }): Promise<ToolResult>;
}

export const unsupportedTool = (name: string): ToolResult => ({
  ok: false,
  output: { error: { code: 'unsupported_tool', message: `tool ${name} is not supported` } },
});

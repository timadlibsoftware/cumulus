// Type-only package. No runtime code: consumers import with `import type`.

/** Normalized issue (upstream §4.1.1). */
export interface Issue {
  id: string;
  native_ref: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  assignee_id: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  dispatchable: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/** Runtime event names (upstream §10.4). */
export type AgentEventName =
  | 'session_started'
  | 'startup_failed'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_ended_with_error'
  | 'turn_input_required'
  | 'approval_auto_approved'
  | 'unsupported_tool_call'
  | 'notification'
  | 'other_message'
  | 'malformed';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface AgentEvent {
  event: AgentEventName;
  timestamp: string;
  /** Absolute session totals when the agent reports them. */
  usage?: TokenUsage;
  message?: string;
  session_id?: string;
  rate_limits?: unknown;
}

export type RunStatus =
  'claimed' | 'pod_created' | 'running' | 'retrying' | 'completed' | 'failed' | 'interrupted' | 'canceled';

export interface RunningRow {
  run_id: string;
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  state: string;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  worker_name: string | null;
  tokens: TokenUsage;
}

export interface RetryRow {
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface CodexTotals extends TokenUsage {
  seconds_running: number;
}

/** `GET /api/v1/state` (upstream §13.7.2). */
export interface StateSnapshot {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: RunningRow[];
  retrying: RetryRow[];
  codex_totals: CodexTotals;
  rate_limits: unknown;
  draining: boolean;
  config_error: string | null;
}

export interface RunRecord {
  id: string;
  issue_id: string;
  issue_identifier: string;
  attempt: number | null;
  agent: string;
  worker_name: string | null;
  image_digest: string | null;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  exit_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface WorkerRow {
  name: string;
  run_id: string | null;
  issue_identifier: string | null;
  phase: string;
  created_at: string | null;
}

export interface SettingView {
  key: string;
  label: string;
  type: 'integer';
  default_value: number;
  workflow_value: number | null;
  override_value: number | null;
  effective_value: number;
  updated_by: string | null;
  updated_at: string | null;
}

export type ServerEvent =
  | { type: 'state'; data: StateSnapshot }
  | { type: 'agent_event'; data: { run_id: string; issue_identifier: string; event: AgentEvent } };

export interface ApiError {
  error: { code: string; message: string };
}

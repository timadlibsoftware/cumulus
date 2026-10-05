import type { AgentEvent, TokenUsage } from '@cumulus/shared';
import type { Readable, Writable } from 'node:stream';

/** §10.6 recommended error categories. */
export type RunnerErrorCode =
  | 'codex_not_found'
  | 'invalid_workspace_cwd'
  | 'response_timeout'
  | 'turn_timeout'
  | 'port_exit'
  | 'response_error'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_input_required';

export class RunnerError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

export interface AgentIo {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

/** An MCP server advertised to the agent session (C-11). */
export interface McpServerSpec {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface SessionOptions {
  cwd: string;
  model: string | null;
  mcpServers: McpServerSpec[];
  readTimeoutMs: number;
  turnTimeoutMs: number;
  onEvent(event: AgentEvent): void;
}

export interface TurnResult {
  turnId: string;
  /** Absolute session totals after this turn. */
  usage: TokenUsage;
}

export interface AgentSession {
  readonly threadId: string;
  runTurn(prompt: string, title: string): Promise<TurnResult>;
  close(): Promise<void>;
}

/** C-2: protocol adapter that drives one agent over a stdio byte stream. */
export interface AgentRunner {
  readonly kind: string;
  /** Adjusts `runner.command` before launch (e.g. CLI flags for MCP servers). */
  buildCommand(command: string, ctx: { mcpServers: McpServerSpec[]; model: string | null }): string;
  startSession(io: AgentIo, options: SessionOptions): Promise<AgentSession>;
}

/** POSIX single-quote shell escaping. */
export const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export const now = (): string => new Date().toISOString();

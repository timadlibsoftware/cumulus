import type { AgentEvent, AgentEventName, TokenUsage } from '@cumulus/shared';
import { JsonRpcError, JsonRpcPeer } from './jsonrpc.js';
import {
  RunnerError,
  now,
  type AgentIo,
  type AgentRunner,
  type AgentSession,
  type SessionOptions,
  type TurnResult,
} from './types.js';

/**
 * C-2 OpenCode runner over the Agent Client Protocol (`opencode acp`): JSON-RPC 2.0, NDJSON on stdio.
 *
 * Policy (§10.5): permission requests are auto-approved (prefer allow_always), client-side fs/terminal
 * methods are not offered and any other agent→client request fails with -32601 so the session continues.
 */
export class OpenCodeAcpRunner implements AgentRunner {
  readonly kind = 'opencode';

  /** ACP receives MCP servers and the model over the protocol, so the command is used as-is. */
  buildCommand(command: string): string {
    return command;
  }

  async startSession(io: AgentIo, options: SessionOptions): Promise<AgentSession> {
    const session = new AcpSession(io, options);
    try {
      await session.start();
    } catch (err) {
      options.onEvent({ event: 'startup_failed', timestamp: now(), message: (err as Error).message });
      io.stdin.end();
      throw err instanceof RunnerError ? err : new RunnerError('response_error', (err as Error).message);
    }
    return session;
  }
}

interface PromptResult {
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

class AcpSession implements AgentSession {
  threadId = '';
  private readonly peer: JsonRpcPeer;
  private turn = 0;
  private totals: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  private activity: (() => void) | null = null;

  constructor(
    private readonly io: AgentIo,
    private readonly options: SessionOptions,
  ) {
    this.peer = new JsonRpcPeer(io.stdin, io.stdout, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onMalformed: (line) => this.emit('malformed', { message: line.slice(0, 500) }),
    });
    // stderr is diagnostic only (§10.3); drain it so the pipe never blocks.
    io.stderr.resume();
  }

  private emit(event: AgentEventName, extra: Partial<AgentEvent> = {}): void {
    this.activity?.();
    this.options.onEvent({ event, timestamp: now(), ...extra });
  }

  async start(): Promise<void> {
    const timeout = this.options.readTimeoutMs;
    await this.peer.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'cumulus', version: '0.1.0' },
      },
      this.options.startupTimeoutMs ?? timeout,
    );
    const created = (await this.peer.request(
      'session/new',
      {
        cwd: this.options.cwd,
        mcpServers: this.options.mcpServers.map((s) => ({
          type: 'http',
          name: s.name,
          url: s.url,
          headers: Object.entries(s.headers).map(([name, value]) => ({ name, value })),
        })),
      },
      timeout,
    )) as { sessionId?: string };
    if (!created?.sessionId) throw new RunnerError('response_error', 'session/new returned no sessionId');
    this.threadId = created.sessionId;
    if (this.options.model) {
      try {
        await this.peer.request(
          'session/set_model',
          { sessionId: this.threadId, modelId: this.options.model },
          timeout,
        );
      } catch (err) {
        this.emit('other_message', { message: `session/set_model failed: ${(err as Error).message}` });
      }
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      this.emit('other_message', { message: method });
      return;
    }
    const update = (
      params as { update?: { sessionUpdate?: string; content?: { text?: string }; title?: string } }
    )?.update;
    const kind = update?.sessionUpdate ?? 'unknown';
    const text = update?.content?.text ?? update?.title;
    this.emit('notification', { message: text ? `${kind}: ${text.slice(0, 500)}` : kind });
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/request_permission') {
      const opts = ((params as { options?: { optionId: string; kind: string }[] })?.options ?? []).slice();
      const choice = opts.find((o) => o.kind === 'allow_always') ?? opts.find((o) => o.kind === 'allow_once');
      if (!choice) {
        this.emit('other_message', { message: 'permission request had no allow option; rejecting' });
        return { outcome: { outcome: 'cancelled' } };
      }
      this.emit('approval_auto_approved', { message: choice.optionId });
      return { outcome: { outcome: 'selected', optionId: choice.optionId } };
    }
    this.emit('unsupported_tool_call', { message: method });
    throw new JsonRpcError(-32601, `method not supported by cumulus: ${method}`);
  }

  async runTurn(prompt: string, _title: string): Promise<TurnResult> {
    this.turn++;
    const turnId = `${this.threadId}-${this.turn}`;
    this.emit('session_started', { session_id: turnId });

    const request = this.peer.request(
      'session/prompt',
      { sessionId: this.threadId, prompt: [{ type: 'text', text: prompt }] },
      null,
    ) as Promise<PromptResult>;

    let timer: NodeJS.Timeout | undefined;
    const silence = new Promise<never>((_, reject) => {
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            reject(new RunnerError('turn_timeout', `no agent output for ${this.options.turnTimeoutMs}ms`)),
          this.options.turnTimeoutMs,
        );
      };
      this.activity = arm;
      arm();
    });

    let result: PromptResult;
    try {
      result = await Promise.race([request, silence]);
    } catch (err) {
      if (err instanceof RunnerError && err.code === 'turn_timeout') {
        this.peer.notify('session/cancel', { sessionId: this.threadId });
        this.emit('turn_failed', { session_id: turnId, message: err.message });
        throw err;
      }
      if (err instanceof JsonRpcError) {
        this.emit('turn_ended_with_error', { session_id: turnId, message: err.message });
        throw new RunnerError('response_error', err.message);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.activity = null;
      request.catch(() => {});
    }

    const u = result?.usage;
    if (u) {
      const input = u.inputTokens ?? 0;
      const output = u.outputTokens ?? 0;
      this.totals = {
        input_tokens: this.totals.input_tokens + input,
        output_tokens: this.totals.output_tokens + output,
        total_tokens: this.totals.total_tokens + (u.totalTokens ?? input + output),
      };
    }
    const usage = { ...this.totals };
    switch (result?.stopReason) {
      case 'end_turn':
      case 'max_tokens':
      case 'max_turn_requests':
        this.emit('turn_completed', { session_id: turnId, usage, message: result.stopReason });
        return { turnId, usage };
      case 'cancelled':
        this.emit('turn_cancelled', { session_id: turnId, usage });
        throw new RunnerError('turn_cancelled', 'agent cancelled the turn');
      default:
        this.emit('turn_failed', { session_id: turnId, usage, message: `stopReason=${result?.stopReason}` });
        throw new RunnerError('turn_failed', `turn ended with stopReason=${result?.stopReason}`);
    }
  }

  async close(): Promise<void> {
    this.io.stdin.end();
  }
}

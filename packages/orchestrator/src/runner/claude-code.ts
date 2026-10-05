import type { AgentEvent, AgentEventName, TokenUsage } from '@cumulus/shared';
import { readLines } from './ndjson.js';
import {
  RunnerError,
  now,
  shellQuote,
  type AgentIo,
  type AgentRunner,
  type AgentSession,
  type McpServerSpec,
  type SessionOptions,
  type TurnResult,
} from './types.js';

/**
 * C-2 Claude Code runner: `claude -p --input-format stream-json --output-format stream-json`.
 *
 * One long-lived process per session; each turn writes one `user` message and ends at the next `result`
 * message. Policy (§10.5): `--permission-mode bypassPermissions` inside the sandboxed worker pod, so no
 * approval requests reach the client. `result.usage` is per turn; the runner accumulates absolute totals.
 */
export class ClaudeCodeRunner implements AgentRunner {
  readonly kind = 'claude-code';

  buildCommand(command: string, ctx: { mcpServers: McpServerSpec[]; model: string | null }): string {
    const mcp = {
      mcpServers: Object.fromEntries(
        ctx.mcpServers.map((s) => [s.name, { type: 'http', url: s.url, headers: s.headers }]),
      ),
    };
    let cmd = `${command} --permission-mode bypassPermissions --mcp-config ${shellQuote(JSON.stringify(mcp))}`;
    if (ctx.model) cmd += ` --model ${shellQuote(ctx.model)}`;
    return cmd;
  }

  async startSession(io: AgentIo, options: SessionOptions): Promise<AgentSession> {
    return new ClaudeSession(io, options);
  }
}

interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  usage?: Record<string, unknown>;
  rate_limit_info?: unknown;
  message?: { content?: { type?: string; text?: string; name?: string }[] };
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

class ClaudeSession implements AgentSession {
  threadId = '';
  private turn = 0;
  private totals: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  private waiter: { resolve(m: StreamMessage): void; reject(e: Error): void; activity(): void } | null = null;
  private exited = false;
  private turnStarted = false;

  constructor(
    private readonly io: AgentIo,
    private readonly options: SessionOptions,
  ) {
    io.stderr.resume();
    readLines(io.stdout, {
      onLine: (line) => this.onLine(line),
      onOverflow: (bytes) =>
        this.emit('malformed', { message: `<line of ${bytes} bytes exceeds max line size>` }),
      onEnd: () => {
        this.exited = true;
        this.waiter?.reject(new RunnerError('port_exit', 'claude process exited'));
      },
    });
  }

  private emit(event: AgentEventName, extra: Partial<AgentEvent> = {}): void {
    this.waiter?.activity();
    this.options.onEvent({ event, timestamp: now(), ...extra });
  }

  private onLine(line: string): void {
    let msg: StreamMessage;
    try {
      msg = JSON.parse(line) as StreamMessage;
    } catch {
      this.emit('malformed', { message: line.slice(0, 500) });
      return;
    }
    if (msg.session_id && !this.threadId) this.threadId = msg.session_id;
    this.markStarted();
    switch (msg.type) {
      case 'result':
        this.waiter?.activity();
        this.waiter?.resolve(msg);
        return;
      case 'assistant': {
        const parts = msg.message?.content ?? [];
        const text = parts
          .map((p) => (p.type === 'text' ? p.text : p.type === 'tool_use' ? `tool_use ${p.name}` : ''))
          .filter(Boolean)
          .join(' ');
        this.emit('notification', { message: text ? text.slice(0, 500) : 'assistant' });
        return;
      }
      case 'rate_limit_event':
        this.emit('other_message', { message: 'rate_limit_event', rate_limits: msg.rate_limit_info ?? null });
        return;
      default:
        this.emit('other_message', {
          message: [msg.type, msg.subtype].filter(Boolean).join('/') || 'unknown',
        });
    }
  }

  /** Emits session_started once per turn, as soon as the session id is known. */
  private markStarted(): void {
    if (this.turnStarted || !this.waiter || !this.threadId) return;
    this.turnStarted = true;
    this.options.onEvent({
      event: 'session_started',
      timestamp: now(),
      session_id: `${this.threadId}-${this.turn}`,
    });
  }

  async runTurn(prompt: string, _title: string): Promise<TurnResult> {
    if (this.exited) throw new RunnerError('port_exit', 'claude process exited');
    this.turn++;
    this.turnStarted = false;
    const waitResult = new Promise<StreamMessage>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const activity = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.waiter = null;
          reject(new RunnerError('turn_timeout', `no agent output for ${this.options.turnTimeoutMs}ms`));
        }, this.options.turnTimeoutMs);
      };
      this.waiter = {
        resolve: (m) => {
          clearTimeout(timer);
          this.waiter = null;
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.waiter = null;
          reject(e);
        },
        activity,
      };
      activity();
    });
    this.io.stdin.write(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`,
    );

    let result: StreamMessage;
    try {
      result = await waitResult;
    } catch (err) {
      if (err instanceof RunnerError && err.code === 'turn_timeout') {
        this.emit('turn_failed', { message: err.message });
      }
      throw err;
    }

    const turnId = `${this.threadId}-${this.turn}`;
    const u = result.usage ?? {};
    const input =
      n(u['input_tokens']) + n(u['cache_creation_input_tokens']) + n(u['cache_read_input_tokens']);
    const output = n(u['output_tokens']);
    this.totals = {
      input_tokens: this.totals.input_tokens + input,
      output_tokens: this.totals.output_tokens + output,
      total_tokens: this.totals.total_tokens + input + output,
    };
    const usage = { ...this.totals };
    if (result.is_error || (result.subtype && result.subtype !== 'success')) {
      this.emit('turn_failed', {
        session_id: turnId,
        usage,
        message: `${result.subtype}: ${String(result.result ?? '').slice(0, 300)}`,
      });
      throw new RunnerError('turn_failed', `turn ended with ${result.subtype}`);
    }
    this.emit('turn_completed', { session_id: turnId, usage });
    return { turnId, usage };
  }

  async close(): Promise<void> {
    this.io.stdin.end();
  }
}

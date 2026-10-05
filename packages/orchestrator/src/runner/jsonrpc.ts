import type { Readable, Writable } from 'node:stream';
import { readLines } from './ndjson.js';
import { RunnerError } from './types.js';

export class JsonRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export interface JsonRpcHandlers {
  onNotification?(method: string, params: unknown): void;
  onRequest?(method: string, params: unknown): Promise<unknown>;
  onMalformed?(line: string): void;
  onClose?(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** JSON-RPC 2.0 over newline-delimited JSON (used by ACP). */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  closed = false;

  constructor(
    private readonly out: Writable,
    input: Readable,
    private readonly handlers: JsonRpcHandlers,
  ) {
    let ended = false;
    readLines(input, {
      onLine: (line) => this.handleLine(line),
      onOverflow: (bytes) => handlers.onMalformed?.(`<line of ${bytes} bytes exceeds max line size>`),
      onEnd: () => {
        if (ended) return;
        ended = true;
        this.close();
      },
    });
  }

  private close(): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RunnerError('port_exit', 'agent stream closed'));
      this.pending.delete(id);
    }
    this.handlers.onClose?.();
  }

  private send(message: object): void {
    if (this.closed || this.out.destroyed) return;
    this.out.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  request(method: string, params: unknown, timeoutMs: number | null): Promise<unknown> {
    if (this.closed) return Promise.reject(new RunnerError('port_exit', 'agent stream closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new RunnerError('response_timeout', `${method} timed out after ${timeoutMs}ms`));
        },
        timeoutMs ?? 2 ** 31 - 1,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private handleLine(line: string): void {
    let msg: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      this.handlers.onMalformed?.(line);
      return;
    }
    if (typeof msg !== 'object' || msg === null) {
      this.handlers.onMalformed?.(line);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      const id = msg.id;
      const handler =
        this.handlers.onRequest ??
        (() => Promise.reject(new JsonRpcError(-32601, `method not found: ${msg.method}`)));
      handler(msg.method, msg.params).then(
        (result) => this.send({ id, result: result ?? null }),
        (err: Error) =>
          this.send({
            id,
            error: { code: err instanceof JsonRpcError ? err.rpcCode : -32603, message: err.message },
          }),
      );
      return;
    }
    if (msg.method !== undefined) {
      this.handlers.onNotification?.(msg.method, msg.params);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new JsonRpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    this.handlers.onMalformed?.(line);
  }
}

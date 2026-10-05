import { PassThrough } from 'node:stream';
import { readLines } from '../../src/runner/ndjson.js';
import type { AgentIo } from '../../src/runner/types.js';

/** A scripted stdio agent. `handle` receives each parsed client message and may reply via `send`. */
export class FakeAgent {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Record<string, unknown>[] = [];

  constructor(private readonly handle: (msg: Record<string, unknown>, agent: FakeAgent) => void) {
    readLines(this.stdin, {
      onLine: (line) => {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.received.push(msg);
        this.handle(msg, this);
      },
    });
  }

  get io(): AgentIo {
    return { stdin: this.stdin, stdout: this.stdout, stderr: this.stderr };
  }

  send(msg: object): void {
    this.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  raw(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  exit(): void {
    this.stdout.end();
  }

  methods(): string[] {
    return this.received.map((m) => String(m['method'] ?? `response:${String(m['id'])}`));
  }
}

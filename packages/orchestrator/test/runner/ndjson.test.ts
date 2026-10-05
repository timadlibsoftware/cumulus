import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readLines } from '../../src/runner/ndjson.js';

function collect(stream: PassThrough, maxBytes = 1024) {
  const lines: string[] = [];
  const overflows: number[] = [];
  const done = new Promise<void>((resolve) =>
    readLines(stream, {
      maxLineBytes: maxBytes,
      onLine: (l) => lines.push(l),
      onOverflow: (n) => overflows.push(n),
      onEnd: resolve,
    }),
  );
  return { lines, overflows, done };
}

describe('readLines', () => {
  it('§10.3 splits newline-delimited frames across chunk boundaries', async () => {
    const s = new PassThrough();
    const c = collect(s);
    s.write('{"a":1}\n{"b"');
    s.write(':2}\r\n\n{"c":3}');
    s.end();
    await c.done;
    expect(c.lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('§10.1 drops lines above the max line size and reports the overflow', async () => {
    const s = new PassThrough();
    const c = collect(s, 10);
    s.write('x'.repeat(25) + '\nok\n');
    s.end();
    await c.done;
    expect(c.lines).toEqual(['ok']);
    expect(c.overflows).toEqual([25]);
  });
});

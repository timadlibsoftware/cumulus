import type { Readable } from 'node:stream';

/** §10.1 recommended max line size. */
export const MAX_LINE_BYTES = 10 * 1024 * 1024;

export interface LineHandlers {
  maxLineBytes?: number;
  onLine(line: string): void;
  onOverflow?(bytes: number): void;
  onEnd?(): void;
}

/** Splits a byte stream into newline-delimited frames, dropping frames above the size cap. */
export function readLines(stream: Readable, h: LineHandlers): void {
  const max = h.maxLineBytes ?? MAX_LINE_BYTES;
  let parts: Buffer[] = [];
  let size = 0;
  let overflow = false;

  const flush = () => {
    if (overflow) {
      h.onOverflow?.(size);
    } else {
      const line = Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
      if (line.trim() !== '') h.onLine(line);
    }
    parts = [];
    size = 0;
    overflow = false;
  };

  stream.on('data', (chunk: Buffer | string) => {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let nl: number;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      const piece = buf.subarray(0, nl);
      size += piece.length;
      if (!overflow && size <= max) parts.push(piece);
      else overflow = true;
      flush();
      buf = buf.subarray(nl + 1);
    }
    if (buf.length > 0) {
      size += buf.length;
      if (!overflow && size <= max) parts.push(Buffer.from(buf));
      else {
        overflow = true;
        parts = [];
      }
    }
  });
  stream.on('end', () => {
    if (size > 0) flush();
    h.onEnd?.();
  });
  stream.on('close', () => h.onEnd?.());
}

#!/usr/bin/env node
import { main } from './main.js';

/** §17.7: exit 0 on normal shutdown, nonzero on startup failure. C-4: drain on SIGTERM/SIGQUIT. */
main(process.argv.slice(2)).then(
  (stop) => {
    for (const signal of ['SIGTERM', 'SIGQUIT', 'SIGINT'] as const) {
      process.on(signal, () => {
        stop().then(
          () => process.exit(0),
          (err: unknown) => {
            console.error(`cumulus: shutdown failed: ${(err as Error).message}`);
            process.exit(1);
          },
        );
      });
    }
  },
  (err: unknown) => {
    const e = err as { code?: string; category?: string; message?: string };
    const code = e.code ?? e.category;
    console.error(`cumulus: startup failed: ${code ? `${code}: ` : ''}${e.message ?? String(err)}`);
    process.exit(1);
  },
);

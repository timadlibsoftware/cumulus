#!/usr/bin/env node
// Usage: node scripts/set-chart-value.mjs <values.yaml> <dotted.path> <value>
//
// Sets one scalar in a block-style YAML file to a double-quoted string, editing only that line so
// comments (including Renovate annotations) and formatting survive. No dependencies, so it runs on
// a bare CI runner. Exits 1 if the path is not found.
/* global process, console */
import { readFileSync, writeFileSync } from 'node:fs';

const [file, path, value] = process.argv.slice(2);
if (!file || !path || value === undefined) {
  console.error('usage: set-chart-value.mjs <values.yaml> <dotted.path> <value>');
  process.exit(2);
}

const want = path.split('.');
const lines = readFileSync(file, 'utf8').split('\n');
const stack = []; // [{ indent, key }]
let hit = -1;

for (let i = 0; i < lines.length; i++) {
  const m = /^( *)([A-Za-z0-9_.-]+):(.*)$/.exec(lines[i]);
  if (!m) continue;
  const indent = m[1].length;
  while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
  stack.push({ indent, key: m[2] });
  if (stack.length === want.length && stack.every((s, j) => s.key === want[j])) {
    hit = i;
    break;
  }
}

if (hit === -1) {
  console.error(`set-chart-value: ${path} not found in ${file}`);
  process.exit(1);
}

lines[hit] = lines[hit].replace(
  /^( *[A-Za-z0-9_.-]+:)\s*(?:"[^"]*"|'[^']*'|[^#\s]*)(\s+#.*)?$/,
  (_m, head, comment) => `${head} ${JSON.stringify(value)}${comment ?? ''}`,
);
writeFileSync(file, lines.join('\n'));

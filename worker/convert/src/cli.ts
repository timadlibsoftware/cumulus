#!/usr/bin/env node
// Usage: cumulus-convert-skills --marketplace <dir> --pins <file> --out <dir> [--plugin-root <dir>]
//
// Reads <dir>/.claude-plugin/marketplace.json and writes into --out:
//   opencode.json            MCP servers of every plugin, in OpenCode format
//   skills/<name>/           every skill the plugins list, copied whole
//   claude-marketplace.json  the marketplace with pinned npx servers, for Claude Code
//   UNMAPPED.md              features with no OpenCode equivalent (also printed)
// --plugin-root is where the marketplace lives at runtime; it resolves ${CLAUDE_PLUGIN_ROOT}.
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  convertMcpServer,
  parseFrontmatter,
  pinMarketplace,
  renderUnmapped,
  type Marketplace,
  type MarketplacePlugin,
  type OpenCodeMcp,
  type Pins,
} from './convert.ts';

const UNSUPPORTED_COMPONENTS = [
  'commands',
  'agents',
  'hooks',
  'lspServers',
  'outputStyles',
  'themes',
  'workflows',
];

interface Io {
  log: (line: string) => void;
}

async function skillDirs(pluginDir: string, plugin: MarketplacePlugin): Promise<string[]> {
  if (plugin.skills) return plugin.skills.map((s) => resolve(pluginDir, s));
  const root = join(pluginDir, 'skills');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
}

export async function run(argv: string[], io: Io = { log: (l) => console.log(l) }): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      marketplace: { type: 'string' },
      pins: { type: 'string' },
      out: { type: 'string' },
      'plugin-root': { type: 'string' },
    },
  });
  if (!values.marketplace || !values.pins || !values.out) {
    throw new Error(
      'usage: cumulus-convert-skills --marketplace <dir> --pins <file> --out <dir> [--plugin-root <dir>]',
    );
  }
  const marketplaceDir = resolve(values.marketplace);
  const out = resolve(values.out);
  const runtimeRoot = values['plugin-root'] ?? marketplaceDir;
  const marketplace = JSON.parse(
    await readFile(join(marketplaceDir, '.claude-plugin', 'marketplace.json'), 'utf8'),
  ) as Marketplace;
  const pins = JSON.parse(await readFile(values.pins, 'utf8')) as Pins;

  const mcp: Record<string, OpenCodeMcp> = {};
  const unmapped: string[] = [];
  await mkdir(join(out, 'skills'), { recursive: true });

  for (const plugin of marketplace.plugins) {
    if (typeof plugin.source !== 'string') {
      unmapped.push(`Plugin \`${plugin.name}\`: non-local source is not supported; skipped.`);
      continue;
    }
    const pluginDir = resolve(marketplaceDir, plugin.source);
    const pluginRoot = join(runtimeRoot, plugin.source).replace(/\/$/, '');

    for (const key of UNSUPPORTED_COMPONENTS) {
      if (plugin[key] !== undefined) {
        unmapped.push(`Plugin \`${plugin.name}\`: \`${key}\` components have no OpenCode conversion.`);
      }
    }

    const servers = plugin.mcpServers;
    if (servers !== undefined && (typeof servers !== 'object' || Array.isArray(servers))) {
      unmapped.push(`Plugin \`${plugin.name}\`: \`mcpServers\` file or bundle references are not converted.`);
    } else if (servers !== undefined) {
      for (const [name, server] of Object.entries(servers)) {
        const r = convertMcpServer(name, server, pins, pluginRoot);
        unmapped.push(...r.unmapped);
        if (r.config) mcp[name] = r.config;
      }
    }

    for (const dir of await skillDirs(pluginDir, plugin)) {
      const text = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null);
      const fm = text === null ? null : parseFrontmatter(text);
      if (!fm?.name || !fm.description) {
        unmapped.push(`Skill \`${basename(dir)}\`: missing SKILL.md, name or description; skipped.`);
        continue;
      }
      await cp(dir, join(out, 'skills', fm.name), { recursive: true });
    }
  }

  const opencode = { $schema: 'https://opencode.ai/config.json', mcp };
  await writeFile(join(out, 'opencode.json'), JSON.stringify(opencode, null, 2) + '\n');
  await writeFile(
    join(out, 'claude-marketplace.json'),
    JSON.stringify(pinMarketplace(marketplace, pins), null, 2) + '\n',
  );
  const md = renderUnmapped(unmapped);
  await writeFile(join(out, 'UNMAPPED.md'), md);
  io.log(md.trim());
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  run(process.argv.slice(2)).catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

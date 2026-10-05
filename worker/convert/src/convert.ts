// Pure conversion of a Claude Code plugin marketplace (CloudOps-Skills) into OpenCode config.
// OpenCode config schema: https://opencode.ai/config.json (`mcp` local/remote entries, `{env:VAR}`).

/** npm package name -> version installed globally in the worker image and the binary it provides. */
export type Pins = Record<string, { version: string; bin: string }>;

export interface ClaudeMcpServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface MarketplacePlugin {
  name: string;
  source: string | Record<string, unknown>;
  skills?: string[];
  mcpServers?: Record<string, ClaudeMcpServer> | string | unknown[];
  [key: string]: unknown;
}

export interface Marketplace {
  name: string;
  plugins: MarketplacePlugin[];
  [key: string]: unknown;
}

export type OpenCodeMcp =
  | { type: 'local'; command: string[]; environment?: Record<string, string>; enabled: boolean }
  | { type: 'remote'; url: string; headers?: Record<string, string>; enabled: boolean };

const STDIO_KEYS = new Set(['type', 'command', 'args', 'env', 'disabled']);
const REMOTE_KEYS = new Set(['type', 'url', 'headers', 'disabled']);
const KEY_NOTES: Record<string, string> = {
  alwaysAllow: 'has no OpenCode equivalent (worker sessions auto-approve tools).',
};

/** Claude `${VAR}` / `${VAR:-default}` -> OpenCode `{env:VAR}`; `${CLAUDE_PLUGIN_ROOT}` -> path. */
export function toOpenCodeEnv(value: string, pluginRoot?: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g, (_m, name: string) =>
    name === 'CLAUDE_PLUGIN_ROOT' && pluginRoot !== undefined ? pluginRoot : `{env:${name}}`,
  );
}

function mapValues(obj: Record<string, string>, pluginRoot?: string): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toOpenCodeEnv(v, pluginRoot)]));
}

/** `npx -y pkg@latest a b` -> `{ command: bin, args: [a, b] }` when `pkg` is pinned; null otherwise. */
function pinnedNpx(command: string, args: string[], pins: Pins): { command: string; args: string[] } | null {
  if (command !== 'npx') return null;
  const pkgIndex = args.findIndex((a) => !a.startsWith('-'));
  const spec = args[pkgIndex];
  if (spec === undefined) return null;
  const name = spec.replace(/(.)@[^@/]*$/, '$1');
  const pin = pins[name];
  if (pin === undefined) return null;
  return { command: pin.bin, args: args.slice(pkgIndex + 1) };
}

function npxPackage(command: string, args: string[]): string | null {
  if (command !== 'npx') return null;
  return args.find((a) => !a.startsWith('-')) ?? null;
}

function transportOf(server: ClaudeMcpServer): string {
  if (server.type !== undefined) return server.type;
  return server.url !== undefined ? 'http' : 'stdio';
}

export function convertMcpServer(
  name: string,
  server: ClaudeMcpServer,
  pins: Pins,
  pluginRoot?: string,
): { config: OpenCodeMcp | null; unmapped: string[] } {
  const unmapped: string[] = [];
  const transport = transportOf(server);
  const enabled = server.disabled !== true;

  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    return {
      config: null,
      unmapped: [`MCP server \`${name}\`: transport \`${transport}\` is not supported by OpenCode; skipped.`],
    };
  }

  const known = transport === 'stdio' ? STDIO_KEYS : REMOTE_KEYS;
  for (const key of Object.keys(server)) {
    if (!known.has(key)) {
      unmapped.push(`MCP server \`${name}\`: \`${key}\` ${KEY_NOTES[key] ?? 'has no OpenCode equivalent.'}`);
    }
  }

  if (transport === 'stdio') {
    const rawCommand = server.command ?? '';
    const rawArgs = server.args ?? [];
    const pinned = pinnedNpx(rawCommand, rawArgs, pins);
    const command = pinned ? [pinned.command, ...pinned.args] : [rawCommand, ...rawArgs];
    const pkg = pinned ? null : npxPackage(rawCommand, rawArgs);
    if (pkg !== null) {
      unmapped.push(
        `MCP server \`${name}\`: npx package \`${pkg}\` is not pinned in the worker image; it is fetched at runtime.`,
      );
    }
    const config: OpenCodeMcp = {
      type: 'local',
      command: command.map((c) => toOpenCodeEnv(c, pluginRoot)),
      ...(server.env ? { environment: mapValues(server.env, pluginRoot) } : {}),
      enabled,
    };
    return { config, unmapped };
  }

  const config: OpenCodeMcp = {
    type: 'remote',
    url: toOpenCodeEnv(server.url ?? '', pluginRoot),
    ...(server.headers ? { headers: mapValues(server.headers, pluginRoot) } : {}),
    enabled,
  };
  return { config, unmapped };
}

/** Same marketplace with pinned `npx …` servers replaced by their installed binaries (for Claude Code). */
export function pinMarketplace(marketplace: Marketplace, pins: Pins): Marketplace {
  return {
    ...marketplace,
    plugins: marketplace.plugins.map((plugin) => {
      const servers = plugin.mcpServers;
      if (servers === undefined || typeof servers !== 'object' || Array.isArray(servers)) return plugin;
      const next = Object.fromEntries(
        Object.entries(servers).map(([name, server]) => {
          const pinned = pinnedNpx(server.command ?? '', server.args ?? [], pins);
          return [name, pinned ? { ...server, ...pinned } : server];
        }),
      );
      return { ...plugin, mcpServers: next };
    }),
  };
}

/** Minimal SKILL.md front matter reader: only `name` and `description` matter to OpenCode. */
export function parseFrontmatter(text: string): { name: string | null; description: string | null } {
  const result: { name: string | null; description: string | null } = { name: null, description: null };
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return result;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const m = /^(name|description):\s*(.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined) {
      result[m[1] as 'name' | 'description'] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2') || null;
    }
  }
  return result;
}

export function renderUnmapped(items: string[]): string {
  const header =
    '# Unmapped CloudOps-Skills features\n\n' +
    'Generated by `@cumulus/worker-convert`. These Claude Code plugin features have no OpenCode\n' +
    'equivalent in the worker image. File an issue for each one that matters.\n\n';
  return header + (items.length ? items.map((i) => `- ${i}`).join('\n') + '\n' : 'Nothing unmapped.\n');
}

import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  convertMcpServer,
  parseFrontmatter,
  pinMarketplace,
  renderUnmapped,
  toOpenCodeEnv,
  type Pins,
} from '../src/convert.ts';
import { run } from '../src/cli.ts';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'marketplace');

const pins: Pins = {
  '@azure/mcp': { version: '3.0.0-beta.49', bin: 'azmcp' },
  '@azure-devops/mcp': { version: '2.10.0', bin: 'mcp-server-azuredevops' },
};

describe('toOpenCodeEnv', () => {
  it('rewrites ${VAR} references to {env:VAR}', () => {
    expect(toOpenCodeEnv('Bearer ${GITHUB_TOKEN}')).toBe('Bearer {env:GITHUB_TOKEN}');
  });

  it('drops a ${VAR:-default} fallback, which OpenCode cannot express', () => {
    expect(toOpenCodeEnv('${URL:-https://x}')).toBe('{env:URL}');
  });

  it('substitutes ${CLAUDE_PLUGIN_ROOT} with the installed plugin path', () => {
    expect(toOpenCodeEnv('${CLAUDE_PLUGIN_ROOT}/server.js', '/opt/skills')).toBe('/opt/skills/server.js');
  });
});

describe('convertMcpServer', () => {
  it('maps a stdio server to type local with a command array and environment', () => {
    const r = convertMcpServer(
      'grafana',
      { command: 'mcp-grafana', args: [], env: { GRAFANA_SERVICE_ACCOUNT_TOKEN: '${TOKEN}', URL: 'u' } },
      pins,
    );
    expect(r.config).toEqual({
      type: 'local',
      command: ['mcp-grafana'],
      environment: { GRAFANA_SERVICE_ACCOUNT_TOKEN: '{env:TOKEN}', URL: 'u' },
      enabled: true,
    });
    expect(r.unmapped).toEqual([]);
  });

  it('maps an http server to type remote with url and headers', () => {
    const r = convertMcpServer(
      'github',
      { type: 'http', url: 'https://x/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
      pins,
    );
    expect(r.config).toEqual({
      type: 'remote',
      url: 'https://x/mcp/',
      headers: { Authorization: 'Bearer {env:GITHUB_TOKEN}' },
      enabled: true,
    });
  });

  it('replaces a pinned npx @latest package with its globally installed binary', () => {
    const r = convertMcpServer(
      'azure',
      { command: 'npx', args: ['-y', '@azure/mcp@latest', 'server', 'start'], type: 'stdio' },
      pins,
    );
    expect(r.config).toMatchObject({ type: 'local', command: ['azmcp', 'server', 'start'] });
  });

  it('keeps an unpinned npx package and reports it as unmapped', () => {
    const r = convertMcpServer('swsd', { command: 'npx', args: ['-y', '@adlibsoftware/mcp-swsd'] }, pins);
    expect(r.config).toMatchObject({ command: ['npx', '-y', '@adlibsoftware/mcp-swsd'] });
    expect(r.unmapped.join('\n')).toMatch(/swsd.*@adlibsoftware\/mcp-swsd.*not pinned/);
  });

  it('maps disabled to enabled: false', () => {
    const r = convertMcpServer('x', { command: 'a', disabled: true }, pins);
    expect(r.config).toMatchObject({ enabled: false });
  });

  it('reports alwaysAllow and other Claude-only keys as unmapped', () => {
    const r = convertMcpServer('azure', { command: 'a', alwaysAllow: ['monitor'], gallery: true }, pins);
    expect(r.unmapped).toEqual([
      'MCP server `azure`: `alwaysAllow` has no OpenCode equivalent (worker sessions auto-approve tools).',
      'MCP server `azure`: `gallery` has no OpenCode equivalent.',
    ]);
  });

  it('reports an unsupported transport and skips the server', () => {
    const r = convertMcpServer('w', { type: 'ws', url: 'wss://x' }, pins);
    expect(r.config).toBeNull();
    expect(r.unmapped[0]).toMatch(/`w`.*transport `ws`/);
  });
});

describe('pinMarketplace', () => {
  it('rewrites pinned npx @latest servers for Claude Code and leaves the rest alone', () => {
    const out = pinMarketplace(
      {
        name: 'm',
        plugins: [
          {
            name: 'p',
            source: './',
            mcpServers: {
              azure: { command: 'npx', args: ['-y', '@azure/mcp@latest', 'server', 'start'] },
              swsd: { command: 'npx', args: ['-y', '@adlibsoftware/mcp-swsd'] },
            },
          },
        ],
      },
      pins,
    );
    const servers = out.plugins[0]?.mcpServers as Record<string, unknown>;
    expect(servers.azure).toEqual({ command: 'azmcp', args: ['server', 'start'] });
    expect(servers.swsd).toEqual({ command: 'npx', args: ['-y', '@adlibsoftware/mcp-swsd'] });
  });
});

describe('parseFrontmatter', () => {
  it('reads name and description, unquoting values', () => {
    expect(parseFrontmatter('---\nname: a\ndescription: "b c"\nx: y\n---\nbody')).toEqual({
      name: 'a',
      description: 'b c',
    });
  });

  it('returns empty fields when there is no front matter', () => {
    expect(parseFrontmatter('# title')).toEqual({ name: null, description: null });
  });
});

describe('renderUnmapped', () => {
  it('renders a markdown list, or a none line when empty', () => {
    expect(renderUnmapped(['a', 'b'])).toContain('- a\n- b\n');
    expect(renderUnmapped([])).toContain('Nothing unmapped.');
  });
});

describe('cli run', () => {
  async function convertFixture() {
    const out = await mkdtemp(join(tmpdir(), 'cumulus-convert-'));
    const pinsPath = join(out, 'pins.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(pinsPath, JSON.stringify(pins));
    const logs: string[] = [];
    await run(['--marketplace', fixture, '--pins', pinsPath, '--out', out, '--plugin-root', '/opt/skills'], {
      log: (line) => logs.push(line),
    });
    return { out, logs };
  }

  it('writes opencode.json with every MCP server of the plugin', async () => {
    const { out } = await convertFixture();
    const config = JSON.parse(await readFile(join(out, 'opencode.json'), 'utf8'));
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    expect(Object.keys(config.mcp).sort()).toEqual([
      'azure',
      'azure-devops',
      'context7',
      'github',
      'grafana',
      'swsd',
    ]);
    expect(config.mcp['azure-devops'].command).toEqual([
      'mcp-server-azuredevops',
      'adlibsoftware',
      '-a',
      'azcli',
    ]);
  });

  it('copies listed skills with their files, named by front matter, and skips unlisted ones', async () => {
    const { out } = await convertFixture();
    expect((await readdir(join(out, 'skills'))).sort()).toEqual(['alpha', 'beta-renamed']);
    expect((await stat(join(out, 'skills', 'alpha', 'references', 'notes.md'))).isFile()).toBe(true);
  });

  it('writes a pinned marketplace.json for Claude Code', async () => {
    const { out } = await convertFixture();
    const m = JSON.parse(await readFile(join(out, 'claude-marketplace.json'), 'utf8'));
    expect(m.plugins[0].mcpServers.azure.command).toBe('azmcp');
  });

  it('writes UNMAPPED.md and prints it', async () => {
    const { out, logs } = await convertFixture();
    const md = await readFile(join(out, 'UNMAPPED.md'), 'utf8');
    expect(md).toMatch(/alwaysAllow/);
    expect(md).toMatch(/mcp-swsd/);
    expect(logs.join('\n')).toContain(md.trim());
  });
});

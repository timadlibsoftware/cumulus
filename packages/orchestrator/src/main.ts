import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { resolveWorkflowPath } from './config/workflow.js';
import { SettingsStore } from './config/settings.js';
import { WorkflowStore } from './config/store.js';
import type { ServiceConfig } from './config/config.js';
import { PostgresStore } from './db/postgres.js';
import { ClientNodeK8sApi } from './executor/k8s-client.js';
import { KubernetesExecutor } from './executor/kubernetes.js';
import { LocalExecutor } from './executor/local.js';
import type { WorkerExecutor } from './executor/types.js';
import { GitHubApp } from './github/app.js';
import { buildInternalServer } from './http/internal.js';
import { createEntraClient } from './http/oidc.js';
import { buildPublicServer, type AuthConfig } from './http/public.js';
import { CompositeJanitor, GitHubBranchJanitor, LocalWorkspaceJanitor } from './janitor.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { noopAudit, type WorkspaceJanitor } from './orchestrator/ports.js';
import { RunRegistryImpl } from './registry.js';
import { ClaudeCodeRunner } from './runner/claude-code.js';
import { OpenCodeAcpRunner } from './runner/opencode-acp.js';
import type { AgentRunner } from './runner/types.js';
import { cachedTrackerFactory } from './tracker/registry.js';

export interface CliArgs {
  workflowPath: string | undefined;
  port: number | undefined;
  host: string | undefined;
  internalPort: number | undefined;
}

/** `cumulus [path-to-WORKFLOW.md] [--port N] [--host H] [--internal-port N]` (§17.7, §13.7). */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { workflowPath: undefined, port: undefined, host: undefined, internalPort: undefined };
  const int = (flag: string, v: string | undefined) => {
    const n = Number(v);
    if (v === undefined || !Number.isInteger(n) || n < 0 || n > 65535)
      throw new Error(`${flag} expects a port number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') out.port = int('--port', argv[++i]);
    else if (a === '--internal-port') out.internalPort = int('--internal-port', argv[++i]);
    else if (a === '--host') {
      out.host = argv[++i];
      if (!out.host) throw new Error('--host expects a value');
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (out.workflowPath === undefined) out.workflowPath = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return out;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required (or set CUMULUS_AUTH_DISABLED=1 for local development)`);
  return v;
}

/** Wires the service from CLI args and environment. Returns a stop function. */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<void>> {
  const args = parseArgs(argv);
  const logger = pino({ base: { service: 'cumulus' }, level: env['LOG_LEVEL'] ?? 'info' });
  const workflow = new WorkflowStore(resolveWorkflowPath(args.workflowPath, process.cwd()), env);
  await workflow.load();
  const stopWatching = workflow.watch();
  workflow.on('reload', () => logger.info({ path: workflow.path }, 'workflow reloaded'));
  workflow.on('reload_error', (error: string) =>
    logger.error({ path: workflow.path, error }, 'workflow reload failed; keeping last good config'),
  );

  // C-5 persistence (optional; scheduling never depends on it).
  let db: PostgresStore | null = null;
  if (env['CUMULUS_DB_HOST']) {
    db = PostgresStore.withEntra(
      {
        host: env['CUMULUS_DB_HOST'],
        database: env['CUMULUS_DB_NAME'] ?? 'cumulus',
        user: required(env, 'CUMULUS_DB_USER'),
        token: PostgresStore.entraTokenProvider(),
      },
      { logger },
    );
  } else if (env['CUMULUS_DATABASE_URL']) {
    db = PostgresStore.fromConnectionString(env['CUMULUS_DATABASE_URL'], { logger });
  }
  if (db) {
    try {
      await db.migrate();
    } catch (err) {
      logger.error(
        { error: (err as Error).message },
        'postgres migration failed; continuing without guaranteed audit trail',
      );
    }
  }

  const settings = new SettingsStore(db);
  await settings.refresh();
  const settingsTimer = setInterval(() => void settings.refresh(), 30_000);

  const github =
    env['CUMULUS_GITHUB_APP_ID'] && env['CUMULUS_GITHUB_APP_PRIVATE_KEY']
      ? new GitHubApp({
          appId: env['CUMULUS_GITHUB_APP_ID'],
          privateKey: env['CUMULUS_GITHUB_APP_PRIVATE_KEY'],
          org: env['CUMULUS_GITHUB_ORG'] ?? 'Adlibsoftware',
        })
      : null;

  const trackerFor = cachedTrackerFactory({ env, logger });
  const runners: Record<string, AgentRunner> = {
    opencode: new OpenCodeAcpRunner(),
    'claude-code': new ClaudeCodeRunner(),
  };
  const executors = new Map<string, WorkerExecutor>();
  const instance = randomUUID();
  const executorFor = (config: ServiceConfig): WorkerExecutor => {
    const key = `${config.worker.executor}:${JSON.stringify(config.worker)}`;
    let ex = executors.get(key);
    if (!ex) {
      ex =
        config.worker.executor === 'local'
          ? new LocalExecutor()
          : new KubernetesExecutor(new ClientNodeK8sApi(), config.worker, { instance });
      executors.set(key, ex);
    }
    return ex;
  };

  const keyIndex = async () =>
    db ? db.workspaceKeys().catch(() => new Map<string, string>()) : new Map<string, string>();
  const janitors: WorkspaceJanitor[] = [];
  if (github) janitors.push(new GitHubBranchJanitor(github, keyIndex));
  if (workflow.current().config.worker.executor === 'local')
    janitors.push(new LocalWorkspaceJanitor(keyIndex));

  const registry = new RunRegistryImpl();
  const serverPort = args.port ?? workflow.current().config.server.port;
  const internalPort =
    args.internalPort ?? (env['CUMULUS_INTERNAL_PORT'] ? Number(env['CUMULUS_INTERNAL_PORT']) : 8081);

  const orchestrator = new Orchestrator({
    workflow,
    trackerFor,
    runnerFor: (kind) => {
      const r = runners[kind];
      if (!r) throw new Error(`runner.kind ${kind} is not supported`);
      return r;
    },
    executorFor,
    audit: db ?? noopAudit,
    janitor: new CompositeJanitor(janitors),
    registry,
    settings,
    logger,
    internalUrl: env['CUMULUS_INTERNAL_URL'] ?? null,
    newRunId: () => randomUUID(),
    newToken: () => randomBytes(32).toString('base64url'),
  });

  await orchestrator.start();

  const servers: FastifyInstance[] = [];
  if (serverPort !== null && serverPort !== undefined) {
    let auth: AuthConfig;
    if (env['CUMULUS_AUTH_DISABLED'] === '1') {
      auth = { mode: 'disabled' };
      logger.warn({}, 'authentication is DISABLED (CUMULUS_AUTH_DISABLED=1)');
    } else {
      auth = {
        mode: 'oidc',
        publicUrl: required(env, 'CUMULUS_PUBLIC_URL'),
        client: await createEntraClient({
          issuer: required(env, 'CUMULUS_OIDC_ISSUER'),
          clientId: required(env, 'CUMULUS_OIDC_CLIENT_ID'),
          clientSecret: required(env, 'CUMULUS_OIDC_CLIENT_SECRET'),
        }),
      };
    }
    const staticDir = fileURLToPath(new URL('../public', import.meta.url));
    const publicServer = await buildPublicServer({
      orchestrator,
      runs: db,
      settings,
      workflowRaw: () => workflow.raw(),
      ready: async () => {
        const error = workflow.current().error ?? orchestrator.snapshot().config_error;
        return {
          ok: !error && !orchestrator.isDraining,
          checks: { workflow: error ?? 'ok', draining: orchestrator.isDraining ? 'yes' : 'no' },
        };
      },
      auth,
      sessionSecret:
        auth.mode === 'oidc' ? required(env, 'CUMULUS_SESSION_SECRET') : randomBytes(32).toString('hex'),
      staticDir: existsSync(staticDir) ? staticDir : null,
    });
    const host = args.host ?? workflow.current().config.server.host;
    const url = await publicServer.listen({ port: serverPort, host });
    logger.info({ url }, 'http listening');
    servers.push(publicServer);

    const internal = await buildInternalServer({
      registry,
      gitTokens: github ? { token: () => github.installationToken() } : null,
    });
    const internalUrl = await internal.listen({ port: internalPort === serverPort ? 0 : internalPort, host });
    logger.info({ url: internalUrl }, 'internal http listening');
    servers.push(internal);
  }

  let stopping: Promise<void> | null = null;
  return () => {
    stopping ??= (async () => {
      const { config } = workflow.current();
      logger.info({ drain_timeout_ms: config.shutdown.drainTimeoutMs }, 'shutdown requested; draining');
      await orchestrator.drain(config.shutdown.drainTimeoutMs);
      orchestrator.stop();
      stopWatching();
      clearInterval(settingsTimer);
      await Promise.allSettled(servers.map((s) => s.close()));
      await db?.close().catch(() => {});
      logger.flush();
    })();
    return stopping;
  };
}

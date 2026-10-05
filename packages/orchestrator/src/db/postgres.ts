import type { Issue, RunRecord, RunStatus, TokenUsage } from '@cumulus/shared';
import { asc, count, desc, eq, inArray } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { StoredSetting, SettingsBackend } from '../config/settings.js';
import type { AuditStore, Logger, PersistedRetry } from '../orchestrator/ports.js';
import { retryQueue, runs, runTransitions, settings, settingsHistory } from './schema.js';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const POSTGRES_ENTRA_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

export interface PostgresOptions {
  timeoutMs?: number;
  logger?: Logger;
}

export interface EntraConnection {
  host: string;
  database: string;
  user: string;
  token: () => Promise<string>;
}

/**
 * C-5 audit trail + C-6 settings backend. Audit methods fail open (log and continue); settings methods
 * throw so the SettingsStore can keep its last known values.
 */
export class PostgresStore implements AuditStore, SettingsBackend {
  private readonly db: NodePgDatabase;
  private readonly timeoutMs: number;

  private constructor(
    private readonly pool: pg.Pool,
    private readonly options: PostgresOptions,
  ) {
    this.db = drizzle(pool);
    this.timeoutMs = options.timeoutMs ?? 5000;
    pool.on('error', (err) => options.logger?.warn({ error: err.message }, 'postgres pool error'));
  }

  static fromConnectionString(connectionString: string, options: PostgresOptions = {}): PostgresStore {
    const timeout = options.timeoutMs ?? 5000;
    return new PostgresStore(
      new pg.Pool({ connectionString, connectionTimeoutMillis: timeout, query_timeout: timeout, max: 5 }),
      options,
    );
  }

  /** Azure Database for PostgreSQL with an Entra token as the password (workload identity). */
  static withEntra(conn: EntraConnection, options: PostgresOptions = {}): PostgresStore {
    const timeout = options.timeoutMs ?? 5000;
    return new PostgresStore(
      new pg.Pool({
        host: conn.host,
        database: conn.database,
        user: conn.user,
        password: conn.token,
        port: 5432,
        ssl: { rejectUnauthorized: true },
        connectionTimeoutMillis: timeout,
        query_timeout: timeout,
        max: 5,
      }),
      options,
    );
  }

  static entraTokenProvider(): () => Promise<string> {
    return async () => {
      const { DefaultAzureCredential } = await import('@azure/identity');
      const token = await new DefaultAzureCredential().getToken(POSTGRES_ENTRA_SCOPE);
      if (!token) throw new Error('no Entra token for Azure Database for PostgreSQL');
      return token.token;
    };
  }

  async migrate(): Promise<void> {
    await migrate(this.db, { migrationsFolder: MIGRATIONS });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  /** Runs an audit write; never throws. */
  private async failOpen<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>(
          (_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs)),
        ),
      ]);
    } catch (err) {
      this.options.logger?.warn({ error: (err as Error).message }, `audit write failed: ${what}`);
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------ AuditStore

  markStaleRunsInterrupted(): Promise<void> {
    return this.failOpen(
      'mark stale runs',
      async () => {
        const stale = await this.db
          .update(runs)
          .set({ status: 'interrupted', endedAt: new Date(), exitReason: 'orchestrator restarted' })
          .where(inArray(runs.status, ['claimed', 'pod_created', 'running']))
          .returning({ id: runs.id });
        if (stale.length > 0) {
          await this.db
            .insert(runTransitions)
            .values(
              stale.map((r) => ({ runId: r.id, status: 'interrupted', message: 'orchestrator restarted' })),
            );
        }
      },
      undefined,
    );
  }

  runClaimed(run: {
    runId: string;
    issue: Issue;
    attempt: number | null;
    agent: string;
    workspaceKey: string;
  }): Promise<void> {
    return this.failOpen(
      'run claimed',
      async () => {
        await this.db.insert(runs).values({
          id: run.runId,
          issueId: run.issue.id,
          issueIdentifier: run.issue.identifier,
          workspaceKey: run.workspaceKey,
          attempt: run.attempt,
          agent: run.agent,
          status: 'claimed',
        });
        await this.db.insert(runTransitions).values({ runId: run.runId, status: 'claimed' });
      },
      undefined,
    );
  }

  runTransition(
    runId: string,
    status: RunStatus,
    detail: { workerName?: string; imageDigest?: string | null; message?: string } = {},
  ): Promise<void> {
    return this.failOpen(
      `run ${status}`,
      async () => {
        await this.db
          .update(runs)
          .set({
            status,
            ...(detail.workerName !== undefined ? { workerName: detail.workerName } : {}),
            ...(detail.imageDigest !== undefined ? { imageDigest: detail.imageDigest } : {}),
          })
          .where(eq(runs.id, runId));
        await this.db.insert(runTransitions).values({ runId, status, message: detail.message ?? null });
      },
      undefined,
    );
  }

  runEnded(
    runId: string,
    status: RunStatus,
    detail: { exitReason: string | null; tokens: TokenUsage },
  ): Promise<void> {
    return this.failOpen(
      'run ended',
      async () => {
        await this.db
          .update(runs)
          .set({
            status,
            endedAt: new Date(),
            exitReason: detail.exitReason,
            inputTokens: detail.tokens.input_tokens,
            outputTokens: detail.tokens.output_tokens,
            totalTokens: detail.tokens.total_tokens,
          })
          .where(eq(runs.id, runId));
        await this.db.insert(runTransitions).values({ runId, status, message: detail.exitReason });
      },
      undefined,
    );
  }

  saveRetry(e: PersistedRetry): Promise<void> {
    return this.failOpen(
      'save retry',
      async () => {
        const row = {
          identifier: e.identifier,
          attempt: e.attempt,
          dueAt: e.dueAt,
          error: e.error,
          updatedAt: new Date(),
        };
        await this.db
          .insert(retryQueue)
          .values({ issueId: e.issueId, ...row })
          .onConflictDoUpdate({ target: retryQueue.issueId, set: row });
      },
      undefined,
    );
  }

  deleteRetry(issueId: string): Promise<void> {
    return this.failOpen(
      'delete retry',
      async () => {
        await this.db.delete(retryQueue).where(eq(retryQueue.issueId, issueId));
      },
      undefined,
    );
  }

  loadRetries(): Promise<PersistedRetry[]> {
    return this.failOpen(
      'load retries',
      async () =>
        (await this.db.select().from(retryQueue)).map((r) => ({
          issueId: r.issueId,
          identifier: r.identifier,
          attempt: r.attempt,
          dueAt: r.dueAt,
          error: r.error,
        })),
      [],
    );
  }

  // ------------------------------------------------------------ queries

  async listRuns(q: {
    limit: number;
    offset: number;
    status?: string;
  }): Promise<{ items: RunRecord[]; total: number }> {
    const where = q.status ? eq(runs.status, q.status) : undefined;
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(runs)
        .where(where)
        .orderBy(desc(runs.startedAt), desc(runs.id))
        .limit(q.limit)
        .offset(q.offset),
      this.db.select({ n: count() }).from(runs).where(where),
    ]);
    return {
      total: totals[0]?.n ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        issue_id: r.issueId,
        issue_identifier: r.issueIdentifier,
        attempt: r.attempt,
        agent: r.agent,
        worker_name: r.workerName,
        image_digest: r.imageDigest,
        status: r.status as RunStatus,
        started_at: r.startedAt.toISOString(),
        ended_at: r.endedAt ? r.endedAt.toISOString() : null,
        exit_reason: r.exitReason,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        total_tokens: r.totalTokens,
      })),
    };
  }

  async transitions(runId: string): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(runTransitions)
      .where(eq(runTransitions.runId, runId))
      .orderBy(asc(runTransitions.id));
    return rows.map((r) => r.status);
  }

  /** C-9 sweeper: workspace key → issue id. */
  async workspaceKeys(): Promise<Map<string, string>> {
    const rows = await this.db.selectDistinct({ key: runs.workspaceKey, issueId: runs.issueId }).from(runs);
    return new Map(rows.map((r) => [r.key, r.issueId]));
  }

  // ------------------------------------------------------------ SettingsBackend

  async load(): Promise<Map<string, StoredSetting>> {
    const rows = await this.db.select().from(settings);
    return new Map(
      rows.map((r) => [r.key, { value: r.value, updatedBy: r.updatedBy, updatedAt: r.updatedAt }]),
    );
  }

  async set(key: string, value: number, user: string, at: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(settings)
        .values({ key, value, updatedBy: user, updatedAt: at })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: user, updatedAt: at } });
      await tx.insert(settingsHistory).values({ key, value, changedBy: user, changedAt: at });
    });
  }

  async delete(key: string, user: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(settings).where(eq(settings.key, key));
      await tx.insert(settingsHistory).values({ key, value: null, changedBy: user });
    });
  }

  async settingsHistory(key: string): Promise<{ value: number | null; changedBy: string }[]> {
    const rows = await this.db
      .select()
      .from(settingsHistory)
      .where(eq(settingsHistory.key, key))
      .orderBy(asc(settingsHistory.id));
    return rows.map((r) => ({ value: r.value, changedBy: r.changedBy }));
  }

  async truncateForTests(): Promise<void> {
    await this.pool.query(
      'truncate runs, run_transitions, retry_queue, settings, settings_history restart identity cascade',
    );
  }
}

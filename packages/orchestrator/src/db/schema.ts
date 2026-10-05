import { bigint, bigserial, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** C-5: one row per attempt. */
export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id').notNull(),
    issueIdentifier: text('issue_identifier').notNull(),
    workspaceKey: text('workspace_key').notNull(),
    attempt: integer('attempt'),
    agent: text('agent').notNull(),
    workerName: text('worker_name'),
    imageDigest: text('image_digest'),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    exitReason: text('exit_reason'),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    index('runs_issue_idx').on(t.issueId),
    index('runs_started_idx').on(t.startedAt),
    index('runs_status_idx').on(t.status),
  ],
);

/** C-5: each state change with a timestamp. */
export const runTransitions = pgTable(
  'run_transitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    message: text('message'),
  },
  (t) => [index('run_transitions_run_idx').on(t.runId)],
);

/** C-5: persisted backoff, loaded at startup. */
export const retryQueue = pgTable('retry_queue', {
  issueId: text('issue_id').primaryKey(),
  identifier: text('identifier').notNull(),
  attempt: integer('attempt').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  error: text('error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** C-6: current UI overrides. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: integer('value').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

/** C-6: who changed what and when, including resets (value null). */
export const settingsHistory = pgTable('settings_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  key: text('key').notNull(),
  value: integer('value'),
  changedBy: text('changed_by').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

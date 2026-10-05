import { EventEmitter } from 'node:events';
import { watch as fsWatch } from 'node:fs';
import { dirname, basename } from 'node:path';
import type { WorkflowSnapshot, WorkflowSource } from '../orchestrator/ports.js';
import { resolveConfig, type ServiceConfig } from './config.js';
import { loadWorkflow } from './workflow.js';

function describe(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? err);
}

/** §6.2 dynamic reload: keeps the last known good workflow and reports reload errors. */
export class WorkflowStore extends EventEmitter implements WorkflowSource {
  private config: ServiceConfig | null = null;
  private prompt = '';
  private rawConfig: Record<string, unknown> = {};
  private error: string | null = null;

  constructor(
    readonly path: string,
    private readonly env: Record<string, string | undefined>,
  ) {
    super();
  }

  private async read(): Promise<{ config: ServiceConfig; prompt: string; raw: Record<string, unknown> }> {
    const wf = await loadWorkflow(this.path);
    const config = resolveConfig(wf.config, { workflowDir: dirname(this.path), env: this.env });
    return { config, prompt: wf.promptTemplate, raw: wf.config };
  }

  /** Initial load; throws so startup fails visibly (§6.3). */
  async load(): Promise<void> {
    const next = await this.read();
    this.config = next.config;
    this.prompt = next.prompt;
    this.rawConfig = next.raw;
    this.error = null;
  }

  async refresh(): Promise<void> {
    try {
      const next = await this.read();
      const changed =
        JSON.stringify(next) !==
        JSON.stringify({ config: this.config, prompt: this.prompt, raw: this.rawConfig });
      this.config = next.config;
      this.prompt = next.prompt;
      this.rawConfig = next.raw;
      const recovered = this.error !== null;
      this.error = null;
      if (changed || recovered) this.emit('reload', this.current());
    } catch (err) {
      const message = describe(err);
      if (message !== this.error) this.emit('reload_error', message);
      this.error = message;
    }
  }

  current(): WorkflowSnapshot {
    if (!this.config) throw new Error('workflow not loaded');
    return { config: this.config, promptTemplate: this.prompt, error: this.error };
  }

  raw(): Record<string, unknown> {
    return this.rawConfig;
  }

  /** Watches the containing directory (ConfigMap updates swap symlinks) with a debounce. */
  watch(debounceMs = 250): () => void {
    let timer: NodeJS.Timeout | undefined;
    const name = basename(this.path);
    const watcher = fsWatch(dirname(this.path), (_event, file) => {
      if (file && file !== name && !String(file).startsWith('..')) return;
      clearTimeout(timer);
      timer = setTimeout(() => void this.refresh(), debounceMs);
    });
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }
}

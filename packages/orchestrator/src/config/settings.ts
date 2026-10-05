import type { SettingView } from '@cumulus/shared';
import { DEFAULT_MAX_CONCURRENT_AGENTS, type ServiceConfig } from './config.js';

export class SettingsError extends Error {
  constructor(
    readonly code: 'unknown_setting' | 'invalid_value' | 'settings_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

export interface StoredSetting {
  value: number;
  updatedBy: string;
  updatedAt: Date;
}

/** Persistence for UI overrides (Postgres in production). */
export interface SettingsBackend {
  load(): Promise<Map<string, StoredSetting>>;
  set(key: string, value: number, user: string, at: Date): Promise<void>;
  delete(key: string, user: string): Promise<void>;
}

interface SettingDefinition {
  key: string;
  label: string;
  min: number;
  max: number;
  defaultValue: number;
  /** Value explicitly set in WORKFLOW.md front matter, or null. */
  fromWorkflow(raw: Record<string, unknown>): number | null;
}

const DEFINITIONS: SettingDefinition[] = [
  {
    key: 'agent.max_concurrent_agents',
    label: 'Max simultaneous runs',
    min: 0,
    max: 100,
    defaultValue: DEFAULT_MAX_CONCURRENT_AGENTS,
    fromWorkflow: (raw) => {
      const v = (raw['agent'] as Record<string, unknown> | undefined)?.['max_concurrent_agents'];
      return typeof v === 'number' && Number.isInteger(v) ? v : null;
    },
  },
];

/** C-6: UI override → WORKFLOW.md → built-in default. Keeps last known overrides when the backend fails. */
export class SettingsStore {
  private overrides = new Map<string, StoredSetting>();

  constructor(
    private readonly backend: SettingsBackend | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async refresh(): Promise<void> {
    if (!this.backend) return;
    try {
      this.overrides = await this.backend.load();
    } catch {
      // Keep the last known values (C-6).
    }
  }

  private definition(key: string): SettingDefinition {
    const def = DEFINITIONS.find((d) => d.key === key);
    if (!def) throw new SettingsError('unknown_setting', `unknown setting ${key}`);
    return def;
  }

  async set(key: string, value: unknown, user: string): Promise<void> {
    const def = this.definition(key);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < def.min || value > def.max) {
      throw new SettingsError('invalid_value', `${key} must be an integer between ${def.min} and ${def.max}`);
    }
    if (!this.backend) throw new SettingsError('settings_unavailable', 'settings storage is not configured');
    const at = this.now();
    try {
      await this.backend.set(key, value, user, at);
    } catch (err) {
      throw new SettingsError(
        'settings_unavailable',
        `settings storage unavailable: ${(err as Error).message}`,
      );
    }
    this.overrides.set(key, { value, updatedBy: user, updatedAt: at });
  }

  async reset(key: string, user: string): Promise<void> {
    this.definition(key);
    if (!this.backend) throw new SettingsError('settings_unavailable', 'settings storage is not configured');
    try {
      await this.backend.delete(key, user);
    } catch (err) {
      throw new SettingsError(
        'settings_unavailable',
        `settings storage unavailable: ${(err as Error).message}`,
      );
    }
    this.overrides.delete(key);
  }

  list(raw: Record<string, unknown>): SettingView[] {
    return DEFINITIONS.map((def) => {
      const o = this.overrides.get(def.key) ?? null;
      const workflowValue = def.fromWorkflow(raw);
      return {
        key: def.key,
        label: def.label,
        type: 'integer',
        default_value: def.defaultValue,
        workflow_value: workflowValue,
        override_value: o?.value ?? null,
        effective_value: o?.value ?? workflowValue ?? def.defaultValue,
        updated_by: o?.updatedBy ?? null,
        updated_at: o ? o.updatedAt.toISOString() : null,
      };
    });
  }

  /** `config.agent.maxConcurrentAgents` already holds WORKFLOW.md or the default. */
  maxConcurrentAgents(config: ServiceConfig): number {
    return this.overrides.get('agent.max_concurrent_agents')?.value ?? config.agent.maxConcurrentAgents;
  }
}

export class MemorySettingsBackend implements SettingsBackend {
  readonly data = new Map<string, StoredSetting>();
  fail = false;
  private check() {
    if (this.fail) throw new Error('backend unavailable');
  }
  async load() {
    this.check();
    return new Map(this.data);
  }
  async set(key: string, value: number, user: string, at: Date) {
    this.check();
    this.data.set(key, { value, updatedBy: user, updatedAt: at });
  }
  async delete(key: string) {
    this.check();
    this.data.delete(key);
  }
}

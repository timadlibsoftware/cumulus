import type { RunningRow, StateSnapshot } from '@cumulus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import { formatNumber } from '@/format';
import DashboardView from '@/views/DashboardView.vue';
import { flushPromises, mountApp } from './helpers';

class FakeEventSource {
  static last: FakeEventSource;
  listeners = new Map<string, (e: MessageEvent) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  close() {}
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

const running = (id: string, identifier: string): RunningRow => ({
  run_id: id,
  issue_id: id,
  issue_identifier: identifier,
  issue_url: null,
  state: 'Dev',
  session_id: null,
  turn_count: 4,
  last_event: 'notification',
  last_message: 'running tests',
  started_at: '2026-10-04T10:00:00Z',
  last_event_at: null,
  worker_name: `w-${id}`,
  tokens: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
});

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    generated_at: '2026-10-04T10:00:00Z',
    counts: { running: 1, retrying: 1 },
    running: [running('r1', 'AB#1')],
    retrying: [
      {
        issue_id: '2',
        issue_identifier: 'AB#2',
        issue_url: null,
        attempt: 2,
        due_at: '2026-10-04T10:05:00Z',
        error: 'boom',
      },
    ],
    codex_totals: { input_tokens: 40000, output_tokens: 5000, total_tokens: 45000, seconds_running: 3700 },
    rate_limits: null,
    draining: false,
    config_error: null,
    ...overrides,
  };
}

describe('DashboardView', () => {
  let runs: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(api, 'state').mockResolvedValue(snapshot());
    runs = vi.spyOn(api, 'runs').mockResolvedValue({
      items: [
        {
          id: 'f1',
          issue_id: '3',
          issue_identifier: 'AB#3',
          attempt: 3,
          agent: 'opencode',
          worker_name: null,
          image_digest: null,
          status: 'failed',
          started_at: '2026-10-04T09:00:00Z',
          ended_at: '2026-10-04T09:30:00Z',
          exit_reason: 'turn_failed',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      ],
      total: 1,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mountDashboard() {
    const { wrapper } = await mountApp(DashboardView);
    await flushPromises();
    return wrapper;
  }

  it('shows running, retrying and failing counts plus token use', async () => {
    const w = await mountDashboard();
    expect(w.find('[data-testid="stat-running"]').text()).toContain('1');
    expect(w.find('[data-testid="stat-retrying"]').text()).toContain('1');
    expect(w.find('[data-testid="stat-failed"]').text()).toContain('1');
    expect(w.find('[data-testid="stat-tokens"]').text()).toContain(formatNumber(45000));
  });

  it('C-8 lists running, retrying and recently failed runs', async () => {
    const w = await mountDashboard();
    expect(runs).toHaveBeenCalledWith({ status: 'failed', limit: 10, offset: 0 });
    expect(w.find('[data-testid="running"]').text()).toContain('AB#1');
    expect(w.find('[data-testid="running"]').text()).toContain('running tests');
    expect(w.find('[data-testid="retrying"]').text()).toContain('AB#2');
    expect(w.find('[data-testid="retrying"]').text()).toContain('boom');
    expect(w.find('[data-testid="failing"]').text()).toContain('AB#3');
    expect(w.find('[data-testid="failing"]').text()).toContain('turn_failed');
  });

  it('C-8 updates live from SSE state events', async () => {
    const w = await mountDashboard();
    FakeEventSource.last.emit(
      'state',
      snapshot({
        counts: { running: 2, retrying: 0 },
        running: [running('r1', 'AB#1'), running('r9', 'AB#9')],
        retrying: [],
      }),
    );
    await flushPromises();
    expect(w.find('[data-testid="stat-running"]').text()).toContain('2');
    expect(w.find('[data-testid="running"]').text()).toContain('AB#9');
  });

  it('reloads failed runs when a running run finishes', async () => {
    await mountDashboard();
    expect(runs).toHaveBeenCalledTimes(1);
    FakeEventSource.last.emit('state', snapshot({ counts: { running: 0, retrying: 1 }, running: [] }));
    await flushPromises();
    expect(runs).toHaveBeenCalledTimes(2);
  });

  it('warns when draining or the config is invalid', async () => {
    vi.spyOn(api, 'state').mockResolvedValue(snapshot({ draining: true, config_error: 'bad WORKFLOW.md' }));
    const w = await mountDashboard();
    expect(w.text()).toContain('Draining');
    expect(w.text()).toContain('bad WORKFLOW.md');
  });
});

import type { RunningRow, StateSnapshot } from '@cumulus/shared';
import { effectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import { POLL_INTERVAL_MS, useLiveState } from '@/composables/useLiveState';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    const e = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners.get(type)?.forEach((fn) => fn(e));
  }
}

function row(overrides: Partial<RunningRow> = {}): RunningRow {
  return {
    run_id: 'r1',
    issue_id: '1',
    issue_identifier: 'AB#1',
    issue_url: null,
    state: 'Dev',
    session_id: null,
    turn_count: 1,
    last_event: null,
    last_message: null,
    started_at: '2026-10-04T10:00:00Z',
    last_event_at: null,
    worker_name: 'w1',
    tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    ...overrides,
  };
}

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    generated_at: '2026-10-04T10:00:00Z',
    counts: { running: 1, retrying: 0 },
    running: [row()],
    retrying: [],
    codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    rate_limits: null,
    draining: false,
    config_error: null,
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('useLiveState', () => {
  let stateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    stateSpy = vi.spyOn(api, 'state').mockResolvedValue(snapshot());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function start() {
    const scope = effectScope();
    const live = scope.run(() => useLiveState())!;
    return { live, scope, es: () => FakeEventSource.instances.at(-1)! };
  }

  it('C-8 loads /api/v1/state and subscribes to /api/v1/events', async () => {
    const { live, es } = start();
    await flush();
    expect(stateSpy).toHaveBeenCalledOnce();
    expect(es().url).toBe('/api/v1/events');
    expect(live.snapshot.value?.counts.running).toBe(1);
  });

  it('C-8 a `state` event replaces the snapshot', async () => {
    const { live, es } = start();
    await flush();
    es().onopen?.();
    expect(live.mode.value).toBe('live');
    es().emit('state', snapshot({ counts: { running: 0, retrying: 2 }, running: [] }));
    expect(live.snapshot.value?.counts.retrying).toBe(2);
  });

  it('C-8 an `agent_event` updates the matching running row and the event feed', async () => {
    const { live, es } = start();
    await flush();
    const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
    es().emit('agent_event', {
      run_id: 'r1',
      issue_identifier: 'AB#1',
      event: { event: 'notification', timestamp: '2026-10-04T10:01:00Z', message: 'editing', usage },
    });
    const r = live.snapshot.value!.running[0]!;
    expect(r.last_event).toBe('notification');
    expect(r.last_message).toBe('editing');
    expect(r.last_event_at).toBe('2026-10-04T10:01:00Z');
    expect(r.tokens).toEqual(usage);
    expect(live.events.value[0]?.issue_identifier).toBe('AB#1');
  });

  it('keeps only the most recent agent events', async () => {
    const { live, es } = start();
    await flush();
    for (let i = 0; i < 60; i++) {
      es().emit('agent_event', {
        run_id: 'x',
        issue_identifier: `AB#${i}`,
        event: { event: 'notification', timestamp: '2026-10-04T10:01:00Z' },
      });
    }
    expect(live.events.value).toHaveLength(50);
    expect(live.events.value[0]?.issue_identifier).toBe('AB#59');
  });

  it('falls back to polling /api/v1/state every 10s when SSE errors', async () => {
    vi.useFakeTimers();
    const { live, es } = start();
    await vi.advanceTimersByTimeAsync(0);
    es().onerror?.();
    expect(es().closed).toBe(true);
    expect(live.mode.value).toBe('polling');
    expect(POLL_INTERVAL_MS).toBe(10_000);
    stateSpy.mockResolvedValue(snapshot({ counts: { running: 7, retrying: 0 } }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateSpy).toHaveBeenCalledTimes(2);
    expect(live.snapshot.value?.counts.running).toBe(7);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateSpy).toHaveBeenCalledTimes(3);
  });

  it('records a load error without throwing', async () => {
    stateSpy.mockRejectedValue(new Error('down'));
    const { live } = start();
    await flush();
    expect(live.error.value).toBe('down');
  });

  it('closes the EventSource and stops polling when its scope ends', async () => {
    vi.useFakeTimers();
    const { scope, es } = start();
    await vi.advanceTimersByTimeAsync(0);
    es().onerror?.();
    scope.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stateSpy).toHaveBeenCalledOnce();

    const second = start();
    second.scope.stop();
    expect(second.es().closed).toBe(true);
  });
});

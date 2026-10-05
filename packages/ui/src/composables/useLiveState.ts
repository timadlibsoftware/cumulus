import type { ServerEvent, StateSnapshot } from '@cumulus/shared';
import { getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { api } from '@/api';

export const POLL_INTERVAL_MS = 10_000;
export const EVENTS_URL = '/api/v1/events';
const MAX_EVENTS = 50;

export type AgentEventMessage = Extract<ServerEvent, { type: 'agent_event' }>['data'];
/** `connecting` until SSE opens, `live` on SSE, `polling` after SSE failed. */
export type LiveMode = 'connecting' | 'live' | 'polling';

/**
 * Owns the dashboard's live data: one EventSource on /api/v1/events, with a fallback to polling
 * /api/v1/state when SSE errors. Stops when the calling component (effect scope) is disposed.
 */
export function useLiveState() {
  const snapshot = shallowRef<StateSnapshot | null>(null);
  const events = ref<AgentEventMessage[]>([]);
  const mode = ref<LiveMode>('connecting');
  const error = ref<string | null>(null);
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh() {
    try {
      snapshot.value = await api.state();
      error.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  function applyAgentEvent(msg: AgentEventMessage) {
    events.value = [msg, ...events.value].slice(0, MAX_EVENTS);
    const snap = snapshot.value;
    if (!snap?.running.some((r) => r.run_id === msg.run_id)) return;
    const { event } = msg;
    snapshot.value = {
      ...snap,
      running: snap.running.map((r) =>
        r.run_id !== msg.run_id
          ? r
          : {
              ...r,
              last_event: event.event,
              last_message: event.message ?? r.last_message,
              last_event_at: event.timestamp,
              session_id: event.session_id ?? r.session_id,
              tokens: event.usage ?? r.tokens,
            },
      ),
    };
  }

  function startPolling() {
    mode.value = 'polling';
    timer ??= setInterval(() => void refresh(), POLL_INTERVAL_MS);
  }

  function connect() {
    const es = new EventSource(EVENTS_URL);
    source = es;
    es.onopen = () => {
      mode.value = 'live';
    };
    es.onerror = () => {
      es.close();
      startPolling();
    };
    es.addEventListener('state', (e) => {
      snapshot.value = JSON.parse((e as MessageEvent<string>).data) as StateSnapshot;
      error.value = null;
    });
    es.addEventListener('agent_event', (e) => {
      applyAgentEvent(JSON.parse((e as MessageEvent<string>).data) as AgentEventMessage);
    });
  }

  function stop() {
    source?.close();
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  void refresh();
  connect();
  if (getCurrentScope()) onScopeDispose(stop);

  return { snapshot, events, mode, error, refresh, stop };
}

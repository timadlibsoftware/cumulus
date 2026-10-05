<script setup lang="ts">
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Message from 'primevue/message';
import { computed, watch } from 'vue';
import { api } from '@/api';
import IssueLink from '@/components/IssueLink.vue';
import { useLiveState } from '@/composables/useLiveState';
import { useResource } from '@/composables/useResource';
import { formatDateTime, formatDuration, formatNumber, formatRelative } from '@/format';

const FAILED_LIMIT = 10;

const live = useLiveState();
const failed = useResource(() => api.runs({ status: 'failed', limit: FAILED_LIMIT, offset: 0 }));

const snap = live.snapshot;
const running = computed(() => snap.value?.running ?? []);
const retrying = computed(() => snap.value?.retrying ?? []);
const failing = computed(() => failed.data.value?.items ?? []);
const totals = computed(() => snap.value?.codex_totals);

// A run leaving the running set may have failed: refresh the failure list then.
const runningIds = computed(() =>
  running.value
    .map((r) => r.run_id)
    .sort()
    .join(','),
);
watch(runningIds, (now, before) => {
  if (before.split(',').some((id) => id && !now.split(',').includes(id))) void failed.load();
});

const stats = computed(() => [
  {
    id: 'running',
    label: 'Running',
    value: snap.value?.counts.running ?? 0,
    icon: 'pi pi-play',
    color: 'text-blue-500',
  },
  {
    id: 'retrying',
    label: 'Retrying',
    value: snap.value?.counts.retrying ?? 0,
    icon: 'pi pi-replay',
    color: 'text-orange-500',
  },
  {
    id: 'failed',
    label: 'Recent failures',
    value: failing.value.length,
    icon: 'pi pi-exclamation-triangle',
    color: 'text-red-500',
  },
  {
    id: 'tokens',
    label: 'Tokens',
    value: formatNumber(totals.value?.total_tokens ?? 0),
    icon: 'pi pi-bolt',
    color: 'text-purple-500',
  },
]);
</script>

<template>
  <div class="flex flex-col gap-8">
    <Message v-if="snap?.draining" severity="warn">Draining: no new runs are being started.</Message>
    <Message v-if="snap?.config_error" severity="error">Configuration error: {{ snap.config_error }}</Message>
    <Message v-if="live.error.value" severity="error">{{ live.error.value }}</Message>
    <Message v-if="live.mode.value === 'polling'" severity="secondary" size="small">
      Live updates unavailable; refreshing every 10 seconds.
    </Message>

    <div class="grid grid-cols-12 gap-8">
      <div v-for="s in stats" :key="s.id" class="col-span-12 sm:col-span-6 xl:col-span-3">
        <div class="card h-full" :data-testid="`stat-${s.id}`">
          <div class="flex justify-between">
            <div>
              <span class="block text-muted-color font-medium mb-4">{{ s.label }}</span>
              <div class="text-surface-900 dark:text-surface-0 font-medium text-xl">{{ s.value }}</div>
            </div>
            <i :class="[s.icon, s.color]" class="text-xl!"></i>
          </div>
          <span v-if="s.id === 'tokens' && totals" class="text-muted-color text-sm">
            {{ formatNumber(totals.input_tokens) }} in · {{ formatNumber(totals.output_tokens) }} out ·
            {{ formatDuration(totals.seconds_running) }} agent time
          </span>
        </div>
      </div>
    </div>

    <div class="card mb-0!" data-testid="running">
      <h2 class="section-title">Running now</h2>
      <DataTable :value="running" data-key="run_id" size="small">
        <template #empty>Nothing is running.</template>
        <Column header="Issue">
          <template #body="{ data: r }"
            ><IssueLink :identifier="r.issue_identifier" :url="r.issue_url"
          /></template>
        </Column>
        <Column field="state" header="State" />
        <Column field="worker_name" header="Worker" />
        <Column field="turn_count" header="Turns" />
        <Column header="Last event">
          <template #body="{ data: r }">
            <div>{{ r.last_event ?? '—' }}</div>
            <small class="text-muted-color">{{ r.last_message }}</small>
          </template>
        </Column>
        <Column header="Started">
          <template #body="{ data: r }">
            <span :title="formatDateTime(r.started_at)">{{ formatRelative(r.started_at) }}</span>
          </template>
        </Column>
        <Column header="Tokens">
          <template #body="{ data: r }">{{ formatNumber(r.tokens.total_tokens) }}</template>
        </Column>
      </DataTable>
    </div>

    <div class="grid grid-cols-12 gap-8">
      <div class="col-span-12 xl:col-span-6">
        <div class="card" data-testid="retrying">
          <h2 class="section-title">Retrying</h2>
          <DataTable :value="retrying" data-key="issue_id" size="small">
            <template #empty>No retries pending.</template>
            <Column header="Issue">
              <template #body="{ data: r }">
                <IssueLink :identifier="r.issue_identifier" :url="r.issue_url" />
              </template>
            </Column>
            <Column field="attempt" header="Attempt" />
            <Column header="Due">
              <template #body="{ data: r }">
                <span :title="formatDateTime(r.due_at)">{{ formatRelative(r.due_at) }}</span>
              </template>
            </Column>
            <Column field="error" header="Error" />
          </DataTable>
        </div>
      </div>
      <div class="col-span-12 xl:col-span-6">
        <div class="card" data-testid="failing">
          <h2 class="section-title">Recent failures</h2>
          <Message v-if="failed.error.value" severity="error">{{ failed.error.value }}</Message>
          <DataTable :value="failing" data-key="id" size="small">
            <template #empty>No recent failures.</template>
            <Column field="issue_identifier" header="Issue" />
            <Column field="attempt" header="Attempt" />
            <Column header="Ended">
              <template #body="{ data: r }">{{ formatDateTime(r.ended_at) }}</template>
            </Column>
            <Column field="exit_reason" header="Reason" />
          </DataTable>
        </div>
      </div>
    </div>
  </div>
</template>

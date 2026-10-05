<script setup lang="ts">
import type { RunRecord, RunStatus } from '@cumulus/shared';
import Column from 'primevue/column';
import DataTable, { type DataTablePageEvent } from 'primevue/datatable';
import Message from 'primevue/message';
import Select from 'primevue/select';
import Tag from 'primevue/tag';
import { onMounted, ref, watch } from 'vue';
import { api, type RunsQuery } from '@/api';
import { formatDateTime, formatNumber, statusSeverity } from '@/format';

const PAGE_SIZE = 25;
const STATUSES: RunStatus[] = [
  'claimed',
  'pod_created',
  'running',
  'retrying',
  'completed',
  'failed',
  'interrupted',
  'canceled',
];

const rows = ref<RunRecord[]>([]);
const total = ref(0);
const first = ref(0);
const limit = ref(PAGE_SIZE);
const status = ref<RunStatus | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load() {
  loading.value = true;
  const query: RunsQuery = { limit: limit.value, offset: first.value };
  if (status.value) query.status = status.value;
  try {
    const page = await api.runs(query);
    rows.value = page.items;
    total.value = page.total;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function onPage(e: DataTablePageEvent) {
  first.value = e.first;
  limit.value = e.rows;
  void load();
}

watch(status, () => {
  first.value = 0;
  void load();
});

onMounted(load);
</script>

<template>
  <div class="card">
    <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
      <h1 class="page-title">Runs</h1>
      <div class="flex items-center gap-3">
        <span class="text-muted-color">{{ formatNumber(total) }} runs</span>
        <Select
          v-model="status"
          :options="STATUSES"
          placeholder="All statuses"
          show-clear
          aria-label="Filter by status"
          class="w-48"
        />
      </div>
    </div>
    <Message v-if="error" severity="error" class="mb-4">{{ error }}</Message>
    <DataTable
      :value="rows"
      lazy
      paginator
      :first="first"
      :rows="limit"
      :rows-per-page-options="[10, 25, 50, 100]"
      :total-records="total"
      :loading="loading"
      data-key="id"
      size="small"
      striped-rows
      @page="onPage"
    >
      <template #empty>No runs.</template>
      <Column field="issue_identifier" header="Issue" />
      <Column header="Status">
        <template #body="{ data }">
          <Tag :value="data.status" :severity="statusSeverity(data.status)" />
        </template>
      </Column>
      <Column field="agent" header="Agent" />
      <Column field="attempt" header="Attempt" />
      <Column field="worker_name" header="Worker" />
      <Column header="Started">
        <template #body="{ data }">{{ formatDateTime(data.started_at) }}</template>
      </Column>
      <Column header="Ended">
        <template #body="{ data }">{{ formatDateTime(data.ended_at) }}</template>
      </Column>
      <Column field="exit_reason" header="Exit reason" />
      <Column header="Tokens">
        <template #body="{ data }">{{ formatNumber(data.total_tokens) }}</template>
      </Column>
    </DataTable>
  </div>
</template>

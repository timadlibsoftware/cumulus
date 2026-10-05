<script setup lang="ts">
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { api } from '@/api';
import { useResource } from '@/composables/useResource';
import { formatDateTime } from '@/format';

const { data, loading, error, load } = useResource(() => api.workers());

const phaseSeverity = (phase: string) =>
  ({ Running: 'info', Succeeded: 'success', Failed: 'danger', Pending: 'warn' })[phase] ?? 'secondary';
</script>

<template>
  <div class="card">
    <div class="flex items-center justify-between gap-4 mb-4">
      <h1 class="page-title">Workers</h1>
      <Button
        data-testid="refresh"
        icon="pi pi-refresh"
        label="Refresh"
        severity="secondary"
        text
        :loading="loading"
        @click="load"
      />
    </div>
    <p class="text-muted-color">Live worker pods in the cluster.</p>
    <Message v-if="error" severity="error" class="mb-4">{{ error }}</Message>
    <DataTable :value="data?.items ?? []" data-key="name" size="small" striped-rows>
      <template #empty>No worker pods.</template>
      <Column field="name" header="Pod" />
      <Column header="Phase">
        <template #body="{ data: row }">
          <Tag :value="row.phase" :severity="phaseSeverity(row.phase)" />
        </template>
      </Column>
      <Column field="issue_identifier" header="Issue" />
      <Column field="run_id" header="Run" />
      <Column header="Created">
        <template #body="{ data: row }">{{ formatDateTime(row.created_at) }}</template>
      </Column>
    </DataTable>
  </div>
</template>

<script setup lang="ts">
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Message from 'primevue/message';
import { api } from '@/api';
import IssueLink from '@/components/IssueLink.vue';
import { useResource } from '@/composables/useResource';
import { formatDateTime, formatRelative } from '@/format';

const { data, loading, error, load } = useResource(() => api.queue());
</script>

<template>
  <div class="card">
    <div class="flex items-center justify-between gap-4 mb-4">
      <h1 class="page-title">Queue</h1>
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
    <p class="text-muted-color">Issues waiting to be retried, including those in backoff.</p>
    <Message v-if="error" severity="error" class="mb-4">{{ error }}</Message>
    <DataTable :value="data?.retrying ?? []" data-key="issue_id" size="small" striped-rows>
      <template #empty>Nothing is waiting.</template>
      <Column header="Issue">
        <template #body="{ data: row }">
          <IssueLink :identifier="row.issue_identifier" :url="row.issue_url" />
        </template>
      </Column>
      <Column field="attempt" header="Attempt" />
      <Column header="Due">
        <template #body="{ data: row }">
          <span :title="formatRelative(row.due_at)">{{ formatDateTime(row.due_at) }}</span>
        </template>
      </Column>
      <Column field="error" header="Last error" />
    </DataTable>
  </div>
</template>

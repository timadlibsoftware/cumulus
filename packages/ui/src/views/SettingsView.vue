<script setup lang="ts">
import Message from 'primevue/message';
import { api } from '@/api';
import SettingField from '@/components/SettingField.vue';
import { useResource } from '@/composables/useResource';

const { data, loading, error, load } = useResource(() => api.settings());
</script>

<template>
  <div class="card">
    <h1 class="page-title">Settings</h1>
    <p class="text-muted-color">
      Overrides set here take precedence over WORKFLOW.md. Leave a field empty to use the value shown in grey.
    </p>
    <Message v-if="error" severity="error">{{ error }}</Message>
    <p v-else-if="loading && !data">Loading…</p>
    <div v-if="data" class="flex flex-col gap-8 mt-6">
      <SettingField v-for="s in data.items" :key="s.key" :setting="s" @changed="load" />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ identifier: string; url?: string | null }>();
</script>

<template>
  <a v-if="url" :href="url" target="_blank" rel="noopener" class="text-primary hover:underline">{{
    identifier
  }}</a>
  <span v-else>{{ identifier }}</span>
</template>

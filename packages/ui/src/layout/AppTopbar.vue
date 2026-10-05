<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type Me } from '@/api';
import { THEME_MODES, useTheme, type ThemeMode } from '@/composables/useTheme';
import { useLayout } from './useLayout';

const { toggleMenu } = useLayout();
const theme = useTheme();
const me = ref<Me | null>(null);

const themeOptions: Record<ThemeMode, { label: string; icon: string }> = {
  system: { label: 'System', icon: 'pi pi-desktop' },
  light: { label: 'Light', icon: 'pi pi-sun' },
  dark: { label: 'Dark', icon: 'pi pi-moon' },
};

onMounted(async () => {
  try {
    me.value = await api.me();
  } catch {
    // 401 already redirects; anything else just leaves the user slot empty.
  }
});
</script>

<template>
  <div class="layout-topbar">
    <div class="layout-topbar-logo-container">
      <button class="layout-menu-button layout-topbar-action" aria-label="Toggle menu" @click="toggleMenu">
        <i class="pi pi-bars"></i>
      </button>
      <router-link to="/" class="layout-topbar-logo">
        <i class="pi pi-cloud text-primary" style="font-size: 1.75rem"></i>
        <span>Cumulus</span>
      </router-link>
    </div>

    <div class="layout-topbar-actions items-center">
      <div data-testid="theme-switch" class="theme-switch" role="group" aria-label="Theme">
        <button
          v-for="m in THEME_MODES"
          :key="m"
          type="button"
          class="layout-topbar-action"
          :class="{ 'theme-switch-active': theme.mode.value === m }"
          :aria-label="themeOptions[m].label"
          :title="themeOptions[m].label"
          :aria-pressed="theme.mode.value === m"
          @click="theme.setMode(m)"
        >
          <i :class="themeOptions[m].icon"></i>
        </button>
      </div>
      <div v-if="me" class="flex items-center gap-3">
        <i class="pi pi-user"></i>
        <span data-testid="user-name" class="hidden sm:inline" :title="me.email">{{ me.name }}</span>
        <a data-testid="sign-out" href="/auth/logout" class="text-primary hover:underline">Sign out</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theme-switch {
  display: inline-flex;
  gap: 0.25rem;
  padding: 0.125rem;
  border-radius: 2rem;
  border: 1px solid var(--surface-border);
}
.theme-switch .layout-topbar-action {
  width: 2rem;
  height: 2rem;
}
.theme-switch .layout-topbar-action i {
  font-size: 1rem;
}
.theme-switch-active {
  background-color: var(--surface-hover);
  color: var(--primary-color);
}
</style>

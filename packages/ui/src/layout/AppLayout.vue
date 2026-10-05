<script setup lang="ts">
import { computed } from 'vue';
import AppSidebar from './AppSidebar.vue';
import AppTopbar from './AppTopbar.vue';
import { useLayout } from './useLayout';

const { layoutState, hideMobileMenu } = useLayout();

const containerClass = computed(() => ({
  'layout-static': true,
  'layout-static-inactive': layoutState.staticMenuInactive,
  'layout-mobile-active': layoutState.mobileMenuActive,
}));
</script>

<template>
  <div class="layout-wrapper" :class="containerClass">
    <AppTopbar />
    <AppSidebar />
    <div class="layout-main-container">
      <div class="layout-main">
        <router-view />
      </div>
    </div>
    <div class="layout-mask animate-fadein" @click="hideMobileMenu" />
  </div>
</template>

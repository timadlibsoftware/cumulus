<script setup lang="ts">
import { sections } from '@/router';
import { useLayout } from './useLayout';

const { hideMobileMenu } = useLayout();
</script>

<template>
  <ul class="layout-menu">
    <li class="layout-root-menuitem">
      <div class="layout-menuitem-root-text">Cumulus</div>
      <ul class="layout-submenu">
        <li v-for="item in sections" :key="item.path">
          <router-link
            :to="item.path"
            class="layout-menuitem-link"
            exact-active-class="active-route"
            @click="hideMobileMenu"
          >
            <i :class="item.icon" class="layout-menuitem-icon" />
            <span class="layout-menuitem-text">{{ item.label }}</span>
          </router-link>
        </li>
      </ul>
    </li>
  </ul>
</template>

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

export interface NavRoute {
  path: string;
  name: string;
  label: string;
  icon: string;
}

/** Sidebar order. The router and the menu both derive from this list. */
export const sections: NavRoute[] = [
  { path: '/', name: 'dashboard', label: 'Dashboard', icon: 'pi pi-fw pi-home' },
  { path: '/runs', name: 'runs', label: 'Runs', icon: 'pi pi-fw pi-history' },
  { path: '/queue', name: 'queue', label: 'Queue', icon: 'pi pi-fw pi-clock' },
  { path: '/workers', name: 'workers', label: 'Workers', icon: 'pi pi-fw pi-server' },
  { path: '/settings', name: 'settings', label: 'Settings', icon: 'pi pi-fw pi-cog' },
];

const views: Record<string, RouteRecordRaw['component']> = {
  dashboard: () => import('@/views/DashboardView.vue'),
  runs: () => import('@/views/RunsView.vue'),
  queue: () => import('@/views/QueueView.vue'),
  workers: () => import('@/views/WorkersView.vue'),
  settings: () => import('@/views/SettingsView.vue'),
};

export const routes: RouteRecordRaw[] = [
  ...sections.map((s): RouteRecordRaw => ({
    path: s.path,
    name: s.name,
    component: views[s.name]!,
    meta: { title: s.label },
  })),
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export function createAppRouter() {
  return createRouter({ history: createWebHistory('/'), routes });
}

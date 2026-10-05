import { mount, type ComponentMountingOptions } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { vi } from 'vitest';
import type { Component } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';

export function testRouter() {
  return createRouter({ history: createMemoryHistory(), routes });
}

/** Mounts with PrimeVue (unstyled theme) and an in-memory router. */
export async function mountApp<C extends Component>(
  component: C,
  options: ComponentMountingOptions<C> = {},
  path = '/',
) {
  const router = testRouter();
  await router.push(path);
  await router.isReady();
  const wrapper = mount(component, {
    ...options,
    global: { plugins: [router, [PrimeVue, { theme: 'none' }]], ...options.global },
  } as ComponentMountingOptions<C>);
  return { wrapper, router };
}

export function stubMatchMedia(dark = false) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: dark, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

export const flushPromises = () => new Promise((r) => setTimeout(r, 0));

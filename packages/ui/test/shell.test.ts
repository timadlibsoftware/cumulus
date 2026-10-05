import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import { useTheme } from '@/composables/useTheme';
import AppMenu from '@/layout/AppMenu.vue';
import AppTopbar from '@/layout/AppTopbar.vue';
import { useLayout } from '@/layout/useLayout';
import { routes } from '@/router';
import { flushPromises, mountApp, stubMatchMedia } from './helpers';

describe('app shell', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    vi.spyOn(api, 'me').mockResolvedValue({ name: 'Tim B', email: 'tim@example.com' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('defines the five sections', () => {
    expect(routes.at(-1)).toMatchObject({ path: '/:pathMatch(.*)*', redirect: '/' });
    expect(routes.filter((r) => !r.redirect).map((r) => r.path)).toEqual([
      '/',
      '/runs',
      '/queue',
      '/workers',
      '/settings',
    ]);
  });

  it('sidebar links every section', async () => {
    const { wrapper } = await mountApp(AppMenu);
    const links = wrapper.findAll('a.layout-menuitem-link');
    expect(links.map((a) => a.text())).toEqual(['Dashboard', 'Runs', 'Queue', 'Workers', 'Settings']);
    expect(links.map((a) => a.attributes('href'))).toEqual(['/', '/runs', '/queue', '/workers', '/settings']);
  });

  it('topbar shows the signed-in user and a sign-out link', async () => {
    const { wrapper } = await mountApp(AppTopbar);
    await flushPromises();
    expect(wrapper.find('[data-testid="user-name"]').text()).toBe('Tim B');
    expect(wrapper.find('[data-testid="user-name"]').attributes('title')).toBe('tim@example.com');
    expect(wrapper.find('a[data-testid="sign-out"]').attributes('href')).toBe('/auth/logout');
  });

  it('topbar theme switch offers System, Light and Dark', async () => {
    const theme = useTheme();
    const { wrapper } = await mountApp(AppTopbar);
    const buttons = wrapper.findAll('[data-testid="theme-switch"] button');
    expect(buttons.map((b) => b.attributes('aria-label'))).toEqual(['System', 'Light', 'Dark']);
    await buttons[2]!.trigger('click');
    expect(theme.mode.value).toBe('dark');
    expect(buttons[2]!.attributes('aria-pressed')).toBe('true');
    expect(document.documentElement.classList.contains('app-dark')).toBe(true);
    await buttons[0]!.trigger('click');
    expect(theme.mode.value).toBe('system');
  });

  it('topbar menu button toggles the sidebar', async () => {
    const { layoutState } = useLayout();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    const { wrapper } = await mountApp(AppTopbar);
    await wrapper.find('button.layout-menu-button').trigger('click');
    expect(layoutState.staticMenuInactive).toBe(true);
    layoutState.staticMenuInactive = false;
  });
});

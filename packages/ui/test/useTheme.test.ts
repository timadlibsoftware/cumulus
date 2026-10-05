import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTheme, THEME_STORAGE_KEY } from '@/composables/useTheme';

type Listener = (e: { matches: boolean }) => void;

function mockMatchMedia(initialDark: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  };
  const matchMedia = vi.fn(() => mql);
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    matchMedia,
    listeners,
    setDark(dark: boolean) {
      mql.matches = dark;
      listeners.forEach((fn) => fn({ matches: dark }));
    },
  };
}

const isDarkClass = () => document.documentElement.classList.contains('app-dark');

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('defaults to system and follows prefers-color-scheme: dark', () => {
    const os = mockMatchMedia(true);
    const theme = createTheme();
    expect(theme.mode.value).toBe('system');
    expect(os.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(theme.isDark.value).toBe(true);
    expect(isDarkClass()).toBe(true);
  });

  it('defaults to system and stays light when the OS is light', () => {
    mockMatchMedia(false);
    const theme = createTheme();
    expect(theme.isDark.value).toBe(false);
    expect(isDarkClass()).toBe(false);
  });

  it('updates live when the OS scheme changes in system mode', () => {
    const os = mockMatchMedia(false);
    const theme = createTheme();
    os.setDark(true);
    expect(theme.isDark.value).toBe(true);
    expect(isDarkClass()).toBe(true);
    os.setDark(false);
    expect(isDarkClass()).toBe(false);
  });

  it('light and dark override the OS scheme', () => {
    const os = mockMatchMedia(true);
    const theme = createTheme();
    theme.setMode('light');
    expect(isDarkClass()).toBe(false);
    os.setDark(true);
    expect(isDarkClass()).toBe(false);
    theme.setMode('dark');
    os.setDark(false);
    expect(isDarkClass()).toBe(true);
  });

  it('persists the choice and restores it on the next load', () => {
    mockMatchMedia(false);
    createTheme().setMode('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    document.documentElement.className = '';
    const next = createTheme();
    expect(next.mode.value).toBe('dark');
    expect(isDarkClass()).toBe(true);
  });

  it('ignores an invalid stored value', () => {
    mockMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(createTheme().mode.value).toBe('system');
  });

  it('works when localStorage throws', () => {
    mockMatchMedia(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const theme = createTheme();
    expect(theme.mode.value).toBe('system');
    expect(() => theme.setMode('light')).not.toThrow();
    expect(theme.mode.value).toBe('light');
    expect(isDarkClass()).toBe(false);
  });

  it('dispose removes the OS listener', () => {
    const os = mockMatchMedia(false);
    const theme = createTheme();
    expect(os.listeners.size).toBe(1);
    theme.dispose();
    expect(os.listeners.size).toBe(0);
  });
});

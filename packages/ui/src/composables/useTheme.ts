import { computed, readonly, ref } from 'vue';

export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];
export const THEME_STORAGE_KEY = 'cumulus.theme';
/** Must match PrimeVue's `darkModeSelector` in main.ts. */
export const DARK_CLASS = 'app-dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStored(): ThemeMode {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_MODES.includes(value as ThemeMode) ? (value as ThemeMode) : 'system';
  } catch {
    return 'system';
  }
}

function writeStored(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Storage unavailable (private mode, blocked): the choice lasts for this page only.
  }
}

/** Creates an independent theme controller bound to the current window. */
export function createTheme() {
  const mode = ref<ThemeMode>(readStored());
  const mql = window.matchMedia(DARK_QUERY);
  const systemDark = ref(mql.matches);
  const isDark = computed(() => mode.value === 'dark' || (mode.value === 'system' && systemDark.value));

  const apply = () => document.documentElement.classList.toggle(DARK_CLASS, isDark.value);
  const onChange = (e: { matches: boolean }) => {
    systemDark.value = e.matches;
    apply();
  };
  mql.addEventListener('change', onChange);
  apply();

  return {
    mode: readonly(mode),
    isDark,
    setMode(next: ThemeMode) {
      mode.value = next;
      writeStored(next);
      apply();
    },
    dispose() {
      mql.removeEventListener('change', onChange);
    },
  };
}

export type Theme = ReturnType<typeof createTheme>;

let instance: Theme | undefined;

/** App-wide theme controller. The first call applies the stored choice. */
export function useTheme(): Theme {
  instance ??= createTheme();
  return instance;
}

import { reactive } from 'vue';

// Adapted from Sakai's layout composable: static menu mode only; dark mode lives in useTheme.
const layoutState = reactive({
  /** Desktop: sidebar collapsed, content uses the full width. */
  staticMenuInactive: false,
  /** Narrow screens: sidebar shown as an overlay drawer. */
  mobileMenuActive: false,
});

const DESKTOP_MIN_WIDTH = 992;

export function useLayout() {
  const isDesktop = () => window.innerWidth >= DESKTOP_MIN_WIDTH;

  const toggleMenu = () => {
    if (isDesktop()) layoutState.staticMenuInactive = !layoutState.staticMenuInactive;
    else layoutState.mobileMenuActive = !layoutState.mobileMenuActive;
  };

  const hideMobileMenu = () => {
    layoutState.mobileMenuActive = false;
  };

  return { layoutState, isDesktop, toggleMenu, hideMobileMenu };
}

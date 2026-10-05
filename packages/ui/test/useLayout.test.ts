import { afterEach, describe, expect, it } from 'vitest';
import { useLayout } from '@/layout/useLayout';

function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px });
}

describe('useLayout', () => {
  const { layoutState, toggleMenu, hideMobileMenu } = useLayout();
  afterEach(() => {
    layoutState.staticMenuInactive = false;
    layoutState.mobileMenuActive = false;
  });

  it('collapses the static sidebar on desktop, freeing the content width', () => {
    setWidth(1400);
    toggleMenu();
    expect(layoutState.staticMenuInactive).toBe(true);
    expect(layoutState.mobileMenuActive).toBe(false);
    toggleMenu();
    expect(layoutState.staticMenuInactive).toBe(false);
  });

  it('opens an overlay drawer on narrow screens', () => {
    setWidth(600);
    toggleMenu();
    expect(layoutState.mobileMenuActive).toBe(true);
    expect(layoutState.staticMenuInactive).toBe(false);
    hideMobileMenu();
    expect(layoutState.mobileMenuActive).toBe(false);
  });
});

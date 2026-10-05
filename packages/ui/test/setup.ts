// jsdom has no matchMedia; PrimeVue (DataTable, Paginator) and useTheme need one. Tests that care
// about the result stub it with vi.stubGlobal.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

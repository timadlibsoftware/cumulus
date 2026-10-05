import Aura from '@primeuix/themes/aura';
import PrimeVue from 'primevue/config';
import { createApp } from 'vue';
import App from './App.vue';
import { DARK_CLASS, useTheme } from './composables/useTheme';
import { createAppRouter } from './router';

import '@/assets/tailwind.css';
import '@/assets/styles.scss';

// Apply the stored theme before the first paint.
useTheme();

createApp(App)
  .use(createAppRouter())
  .use(PrimeVue, { theme: { preset: Aura, options: { darkModeSelector: `.${DARK_CLASS}` } } })
  .mount('#app');

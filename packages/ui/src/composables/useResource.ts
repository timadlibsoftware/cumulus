import { onMounted, ref, shallowRef, type Ref } from 'vue';

/** Loads `fetcher` on mount; `load()` reloads. Errors land in `error` instead of throwing. */
export function useResource<T>(fetcher: () => Promise<T>) {
  const data = shallowRef<T | null>(null) as Ref<T | null>;
  const loading = ref(true);
  const error = ref<string | null>(null);

  async function load() {
    loading.value = true;
    try {
      data.value = await fetcher();
      error.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  onMounted(load);
  return { data, loading, error, load };
}

<script setup lang="ts">
import type { SettingView } from '@cumulus/shared';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { formatDateTime } from '@/format';

const props = defineProps<{ setting: SettingView }>();
const emit = defineEmits<{ changed: [] }>();

const draft = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

const overridden = computed(() => props.setting.override_value !== null);
/** What applies without an override: WORKFLOW.md, else the built-in default (C-6). */
const inherited = computed(() => props.setting.workflow_value ?? props.setting.default_value);
const inputId = computed(() => `setting-${props.setting.key}`);

watch(
  () => props.setting.override_value,
  (v) => {
    draft.value = v === null ? '' : String(v);
  },
  { immediate: true },
);

async function run(action: () => Promise<void>) {
  busy.value = true;
  error.value = null;
  try {
    await action();
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function save() {
  const text = draft.value.trim();
  if (text === '') return;
  const value = Number(text);
  if (!Number.isInteger(value)) {
    error.value = 'Enter a whole number.';
    return;
  }
  void run(() => api.putSetting(props.setting.key, value));
}

function reset() {
  void run(() => api.deleteSetting(props.setting.key));
}
</script>

<template>
  <div :data-setting="setting.key" class="flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <label :for="inputId" class="font-semibold">{{ setting.label }}</label>
      <Tag v-if="overridden" value="modified" severity="info" />
    </div>
    <form class="flex flex-wrap items-center gap-2" @submit.prevent="save">
      <InputText
        :id="inputId"
        v-model="draft"
        type="text"
        inputmode="numeric"
        :placeholder="String(inherited)"
        :invalid="error !== null"
        class="w-40"
      />
      <Button type="submit" label="Save" size="small" :disabled="busy" />
      <Button
        v-if="overridden"
        data-testid="reset"
        type="button"
        label="Reset"
        link
        size="small"
        :disabled="busy"
        @click="reset"
      />
    </form>
    <Message v-if="error" data-testid="field-error" severity="error" size="small" variant="simple">
      {{ error }}
    </Message>
    <small v-if="overridden" data-testid="audit" class="text-muted-color">
      Set by {{ setting.updated_by ?? 'unknown' }} at {{ formatDateTime(setting.updated_at) }}
    </small>
    <small v-else class="text-muted-color">
      {{ setting.workflow_value !== null ? 'From WORKFLOW.md' : 'Built-in default' }}
    </small>
  </div>
</template>

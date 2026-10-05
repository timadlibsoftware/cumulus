import type { SettingView } from '@cumulus/shared';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/api';
import { formatDateTime } from '@/format';
import SettingsView from '@/views/SettingsView.vue';
import { flushPromises, mountApp } from './helpers';

const KEY = 'agent.max_concurrent_agents';

function setting(overrides: Partial<SettingView> = {}): SettingView {
  return {
    key: KEY,
    label: 'Max simultaneous runs',
    type: 'integer',
    default_value: 5,
    workflow_value: null,
    override_value: null,
    effective_value: 5,
    updated_by: null,
    updated_at: null,
    ...overrides,
  };
}

const overridden = setting({
  override_value: 3,
  effective_value: 3,
  updated_by: 'tim@example.com',
  updated_at: '2026-10-04T10:00:00Z',
});

async function mountSettings(...responses: SettingView[][]) {
  const list = vi.spyOn(api, 'settings');
  for (const items of responses) list.mockResolvedValueOnce({ items });
  const { wrapper } = await mountApp(SettingsView);
  await flushPromises();
  return { wrapper, list };
}

const field = (w: VueWrapper, key = KEY) => w.find(`[data-setting="${key}"]`);
const input = (w: VueWrapper, key = KEY) => field(w, key).find('input');

describe('SettingsView', () => {
  let put: ReturnType<typeof vi.spyOn>;
  let del: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    put = vi.spyOn(api, 'putSetting').mockResolvedValue();
    del = vi.spyOn(api, 'deleteSetting').mockResolvedValue();
  });
  afterEach(() => vi.restoreAllMocks());

  it('C-6 renders settings generically from the API', async () => {
    const { wrapper } = await mountSettings([
      setting(),
      setting({ key: 'other.limit', label: 'Other limit', default_value: 9, effective_value: 9 }),
    ]);
    expect(field(wrapper).find('label').text()).toBe('Max simultaneous runs');
    expect(field(wrapper, 'other.limit').find('label').text()).toBe('Other limit');
    expect(input(wrapper, 'other.limit').attributes('placeholder')).toBe('9');
  });

  it('C-6 without an override the field is empty with the default as placeholder', async () => {
    const { wrapper } = await mountSettings([setting()]);
    const el = input(wrapper).element as HTMLInputElement;
    expect(el.value).toBe('');
    expect(el.placeholder).toBe('5');
    expect(field(wrapper).find('.p-tag').exists()).toBe(false);
    expect(field(wrapper).find('[data-testid="reset"]').exists()).toBe(false);
  });

  it('C-6 the placeholder shows the WORKFLOW.md value when set', async () => {
    const { wrapper } = await mountSettings([setting({ workflow_value: 8, effective_value: 8 })]);
    expect(input(wrapper).attributes('placeholder')).toBe('8');
  });

  it('C-6 an override shows its value, a modified tag, a Reset link and who set it', async () => {
    const { wrapper } = await mountSettings([overridden]);
    expect((input(wrapper).element as HTMLInputElement).value).toBe('3');
    expect(field(wrapper).find('.p-tag').text()).toBe('modified');
    expect(field(wrapper).find('[data-testid="reset"]').text()).toBe('Reset');
    const audit = field(wrapper).find('[data-testid="audit"]').text();
    expect(audit).toContain('tim@example.com');
    expect(audit).toContain(formatDateTime('2026-10-04T10:00:00Z'));
  });

  it('C-6 Reset calls DELETE and returns the field to empty with placeholder', async () => {
    const { wrapper, list } = await mountSettings([overridden], [setting()]);
    await field(wrapper).find('[data-testid="reset"]').trigger('click');
    await flushPromises();
    expect(del).toHaveBeenCalledWith(KEY);
    expect(list).toHaveBeenCalledTimes(2);
    const el = input(wrapper).element as HTMLInputElement;
    expect(el.value).toBe('');
    expect(el.placeholder).toBe('5');
    expect(field(wrapper).find('.p-tag').exists()).toBe(false);
  });

  it('C-6 saving an empty field does nothing', async () => {
    const { wrapper, list } = await mountSettings([setting()]);
    await field(wrapper).find('form').trigger('submit');
    await flushPromises();
    expect(put).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('C-6 saving a value PUTs it and shows the field as modified', async () => {
    const { wrapper } = await mountSettings([setting()], [setting({ ...overridden, override_value: 7 })]);
    await input(wrapper).setValue('7');
    await field(wrapper).find('form').trigger('submit');
    await flushPromises();
    expect(put).toHaveBeenCalledWith(KEY, 7);
    expect((input(wrapper).element as HTMLInputElement).value).toBe('7');
    expect(field(wrapper).find('.p-tag').text()).toBe('modified');
  });

  it('C-6 rejects a non-integer without calling the API', async () => {
    const { wrapper } = await mountSettings([setting()]);
    await input(wrapper).setValue('2.5');
    await field(wrapper).find('form').trigger('submit');
    await flushPromises();
    expect(put).not.toHaveBeenCalled();
    expect(field(wrapper).find('[data-testid="field-error"]').text()).toMatch(/whole number/);
  });

  it('shows the server error when saving fails', async () => {
    put.mockRejectedValue(new ApiError(400, 'invalid_value', 'must be at least 1'));
    const { wrapper } = await mountSettings([setting()]);
    await input(wrapper).setValue('0');
    await field(wrapper).find('form').trigger('submit');
    await flushPromises();
    expect(field(wrapper).find('[data-testid="field-error"]').text()).toBe('must be at least 1');
  });
});

import type { RunRecord } from '@cumulus/shared';
import Select from 'primevue/select';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import RunsView from '@/views/RunsView.vue';
import { flushPromises, mountApp } from './helpers';

function run(i: number, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `run-${i}`,
    issue_id: String(i),
    issue_identifier: `AB#${i}`,
    attempt: 1,
    agent: 'opencode',
    worker_name: `w-${i}`,
    image_digest: null,
    status: 'completed',
    started_at: '2026-10-04T10:00:00Z',
    ended_at: '2026-10-04T10:10:00Z',
    exit_reason: null,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    ...overrides,
  };
}

describe('RunsView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('C-8 loads the first page of /api/v1/runs and renders rows', async () => {
    const runs = vi.spyOn(api, 'runs').mockResolvedValue({
      items: [run(1), run(2, { status: 'failed', exit_reason: 'timeout' })],
      total: 60,
    });
    const { wrapper } = await mountApp(RunsView);
    await flushPromises();
    expect(runs).toHaveBeenCalledWith({ limit: 25, offset: 0 });
    const rows = wrapper.findAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.text()).toContain('AB#2');
    expect(rows[1]!.text()).toContain('failed');
    expect(rows[1]!.text()).toContain('timeout');
    expect(wrapper.text()).toContain('60 runs');
  });

  it('C-8 pages server-side', async () => {
    const runs = vi.spyOn(api, 'runs').mockResolvedValue({ items: [run(1)], total: 60 });
    const { wrapper } = await mountApp(RunsView);
    await flushPromises();
    await wrapper.find('.p-paginator-next').trigger('click');
    await flushPromises();
    expect(runs).toHaveBeenLastCalledWith({ limit: 25, offset: 25 });
  });

  it('C-8 filters by status and restarts at the first page', async () => {
    const runs = vi.spyOn(api, 'runs').mockResolvedValue({ items: [run(1)], total: 60 });
    const { wrapper } = await mountApp(RunsView);
    await flushPromises();
    await wrapper.find('.p-paginator-next').trigger('click');
    await flushPromises();
    wrapper.findComponent(Select).vm.$emit('update:modelValue', 'failed');
    await flushPromises();
    expect(runs).toHaveBeenLastCalledWith({ limit: 25, offset: 0, status: 'failed' });
  });
});

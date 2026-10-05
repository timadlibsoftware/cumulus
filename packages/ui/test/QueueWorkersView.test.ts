import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import { formatDateTime } from '@/format';
import QueueView from '@/views/QueueView.vue';
import WorkersView from '@/views/WorkersView.vue';
import { flushPromises, mountApp } from './helpers';

describe('QueueView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('C-8 lists retrying issues with due time and error', async () => {
    const due = '2026-10-04T10:05:00Z';
    vi.spyOn(api, 'queue').mockResolvedValue({
      retrying: [
        {
          issue_id: '1',
          issue_identifier: 'AB#1',
          issue_url: 'https://dev.azure.com/x/1',
          attempt: 3,
          due_at: due,
          error: 'agent exited 1',
        },
      ],
    });
    const { wrapper } = await mountApp(QueueView);
    await flushPromises();
    const row = wrapper.find('tbody tr');
    expect(row.text()).toContain('AB#1');
    expect(row.find('a').attributes('href')).toBe('https://dev.azure.com/x/1');
    expect(row.text()).toContain('3');
    expect(row.text()).toContain(formatDateTime(due));
    expect(row.text()).toContain('agent exited 1');
  });

  it('refresh reloads the queue', async () => {
    const queue = vi.spyOn(api, 'queue').mockResolvedValue({ retrying: [] });
    const { wrapper } = await mountApp(QueueView);
    await flushPromises();
    expect(wrapper.text()).toContain('Nothing is waiting');
    await wrapper.find('[data-testid="refresh"]').trigger('click');
    expect(queue).toHaveBeenCalledTimes(2);
  });
});

describe('WorkersView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('C-8 lists live worker pods and their state', async () => {
    vi.spyOn(api, 'workers').mockResolvedValue({
      items: [
        {
          name: 'cumulus-run-abc',
          run_id: 'r1',
          issue_identifier: 'AB#7',
          phase: 'Running',
          created_at: '2026-10-04T10:00:00Z',
        },
      ],
    });
    const { wrapper } = await mountApp(WorkersView);
    await flushPromises();
    const row = wrapper.find('tbody tr');
    expect(row.text()).toContain('cumulus-run-abc');
    expect(row.text()).toContain('AB#7');
    expect(row.text()).toContain('Running');
  });

  it('shows the load error', async () => {
    vi.spyOn(api, 'workers').mockRejectedValue(new Error('kube unavailable'));
    const { wrapper } = await mountApp(WorkersView);
    await flushPromises();
    expect(wrapper.text()).toContain('kube unavailable');
  });
});

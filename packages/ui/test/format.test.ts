import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDuration, formatNumber, formatRelative } from '@/format';

describe('format', () => {
  it('formatDateTime uses the browser locale and shows a dash for null', () => {
    const iso = '2026-10-04T10:00:00Z';
    expect(formatDateTime(iso)).toBe(new Date(iso).toLocaleString());
    expect(formatDateTime(null)).toBe('—');
  });

  it('formatNumber groups digits', () => {
    expect(formatNumber(1234567)).toBe(new Intl.NumberFormat().format(1234567));
  });

  it('formatDuration', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(3725)).toBe('1h 2m');
    expect(formatDuration(12.7)).toBe('12s');
  });

  it('formatRelative describes past and future times', () => {
    const now = Date.parse('2026-10-04T10:00:00Z');
    expect(formatRelative('2026-10-04T10:02:00Z', now)).toBe('in 2m');
    expect(formatRelative('2026-10-04T09:59:55Z', now)).toBe('5s ago');
    expect(formatRelative('2026-10-04T11:05:00Z', now)).toBe('in 1h 5m');
    expect(formatRelative('2026-10-04T10:00:00Z', now)).toBe('now');
  });
});

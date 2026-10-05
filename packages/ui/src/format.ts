export function formatDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

const numberFormat = new Intl.NumberFormat();

export function formatNumber(n: number): string {
  return numberFormat.format(n);
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** "in 2m" / "5s ago" relative to `now` (epoch ms). */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const diff = Math.round((Date.parse(iso) - now) / 1000);
  if (diff === 0) return 'now';
  const span = formatDuration(Math.abs(diff)).replace(/ 0s$/, '');
  return diff > 0 ? `in ${span}` : `${span} ago`;
}

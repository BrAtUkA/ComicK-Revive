/** Small formatting helpers shared by dashboard tabs */

/** 3820 → "1h 3m", 95 → "1m 35s", 0 → "0m" */
export function fmtDuration(totalSeconds: number): string {
  const sec = Math.round(totalSeconds);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return sec % 60 && m < 10 ? `${m}m ${sec % 60}s` : `${m}m`;
  return sec > 0 ? `${sec}s` : '0m';
}

/** Epoch ms → "just now" / "5m ago" / "3h ago" / "2d ago" / "Jun 12" */
export function timeAgo(timestamp: number): string {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "2026-07-02" → "Jul 2" */
export function fmtDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Prettify a comick slug ("01-solo-leveling" → "Solo Leveling") when no title is stored */
export function titleFromSlug(slug: string): string {
  return slug
    .replace(/^\d+-/, '')
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

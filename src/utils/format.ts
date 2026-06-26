/**
 * Format a byte count into a human-readable string with appropriate unit.
 * Automatically selects B, KB, MB, or GB based on magnitude.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Format a megabyte value into a human-readable string with appropriate unit.
 * Use when you have a value already in MB (e.g. settings like maxSizeMB).
 */
export function formatMB(mb: number): string {
  if (mb < 1) return `${Math.round(mb * 1024)} KB`;
  if (mb < 1024) return `${mb} MB`;
  return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
}

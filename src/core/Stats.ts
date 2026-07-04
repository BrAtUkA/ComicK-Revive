import { storage, STORAGE_KEYS } from './Storage';

/**
 * StatsManager - Reading activity tracking
 *
 * Persists lightweight per-day aggregates plus lifetime totals so the
 * dashboard/popup can render history (chapters per day, reading time,
 * streaks) without storing individual events.
 *
 * Storage layout:
 * - `stats_daily_{YYYY-MM-DD}` (local time) → DailyStats
 * - `stats_totals` → StatsTotals
 *
 * Writers live in the viewer (chapter opened / organically marked read /
 * active reading seconds). Bulk mark-read from the chapter picker is
 * intentionally NOT counted — marking 50 chapters read is bookkeeping,
 * not reading activity.
 */

export interface DailyStats {
  opened: number;      // chapters opened
  read: number;        // chapters marked read while reading
  activeSec: number;   // seconds of active reading time
  manga: string[];     // distinct comick slugs read this day
}

export interface StatsTotals {
  chaptersOpened: number;
  chaptersRead: number;
  activeSec: number;
  firstTrackedAt: number;  // epoch ms of first recorded event
}

const EMPTY_DAY: DailyStats = { opened: 0, read: 0, activeSec: 0, manga: [] };

const DEFAULT_TOTALS: StatsTotals = {
  chaptersOpened: 0,
  chaptersRead: 0,
  activeSec: 0,
  firstTrackedAt: 0,
};

/** Local-timezone YYYY-MM-DD key for a date */
export function dayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class StatsManager {
  private async mutateDay(slug: string | null, fn: (day: DailyStats) => void): Promise<void> {
    const key = STORAGE_KEYS.STATS_DAILY_PREFIX + dayKey();
    const day = await storage.get<DailyStats>(key, { ...EMPTY_DAY, manga: [] });
    fn(day);
    if (slug && !day.manga.includes(slug)) {
      day.manga.push(slug);
    }
    await storage.set(key, day);
  }

  private async mutateTotals(fn: (totals: StatsTotals) => void): Promise<void> {
    const totals = await storage.get<StatsTotals>(STORAGE_KEYS.STATS_TOTALS, { ...DEFAULT_TOTALS });
    if (!totals.firstTrackedAt) {
      totals.firstTrackedAt = Date.now();
    }
    fn(totals);
    await storage.set(STORAGE_KEYS.STATS_TOTALS, totals);
  }

  /** A chapter was opened in the reader */
  async recordChapterOpened(comickSlug: string): Promise<void> {
    try {
      await this.mutateDay(comickSlug, (d) => { d.opened += 1; });
      await this.mutateTotals((t) => { t.chaptersOpened += 1; });
    } catch (error) {
      console.warn('[Stats] recordChapterOpened failed:', error);
    }
  }

  /** A chapter was organically marked read while reading */
  async recordChapterRead(comickSlug: string): Promise<void> {
    try {
      await this.mutateDay(comickSlug, (d) => { d.read += 1; });
      await this.mutateTotals((t) => { t.chaptersRead += 1; });
    } catch (error) {
      console.warn('[Stats] recordChapterRead failed:', error);
    }
  }

  /** Accumulated active reading seconds (flushed periodically by the viewer) */
  async addActiveTime(seconds: number, comickSlug?: string): Promise<void> {
    const whole = Math.round(seconds);
    if (whole <= 0) return;
    try {
      await this.mutateDay(comickSlug ?? null, (d) => { d.activeSec += whole; });
      await this.mutateTotals((t) => { t.activeSec += whole; });
    } catch (error) {
      console.warn('[Stats] addActiveTime failed:', error);
    }
  }

  async getTotals(): Promise<StatsTotals> {
    return await storage.get<StatsTotals>(STORAGE_KEYS.STATS_TOTALS, { ...DEFAULT_TOTALS });
  }

  /** All recorded days, keyed by YYYY-MM-DD */
  async getAllDaily(): Promise<Record<string, DailyStats>> {
    const byKey = await storage.getByPrefix<DailyStats>(STORAGE_KEYS.STATS_DAILY_PREFIX);
    const result: Record<string, DailyStats> = {};
    for (const [key, value] of Object.entries(byKey)) {
      result[key.slice(STORAGE_KEYS.STATS_DAILY_PREFIX.length)] = value;
    }
    return result;
  }

  /**
   * Last `days` days ending today (oldest first), zero-filled for days
   * without activity — ready for charting.
   */
  async getDailyRange(days: number): Promise<Array<{ date: string; stats: DailyStats }>> {
    const all = await this.getAllDaily();
    const range: Array<{ date: string; stats: DailyStats }> = [];
    const cursor = new Date();
    cursor.setDate(cursor.getDate() - (days - 1));
    for (let i = 0; i < days; i++) {
      const key = dayKey(cursor);
      range.push({ date: key, stats: all[key] ?? { ...EMPTY_DAY, manga: [] } });
      cursor.setDate(cursor.getDate() + 1);
    }
    return range;
  }

  /**
   * Current streak: consecutive days ending today (or yesterday, so an
   * unbroken streak isn't shown as 0 before today's first read) with at
   * least one chapter opened or read.
   */
  async getCurrentStreak(): Promise<number> {
    const all = await this.getAllDaily();
    const isActive = (key: string) => {
      const d = all[key];
      return !!d && (d.opened > 0 || d.read > 0 || d.activeSec >= 60);
    };
    const cursor = new Date();
    let streak = 0;
    if (!isActive(dayKey(cursor))) {
      cursor.setDate(cursor.getDate() - 1);  // allow "haven't read yet today"
    }
    while (isActive(dayKey(cursor))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  /** Wipe all stats (dashboard "reset stats" action) */
  async clearAll(): Promise<void> {
    await storage.removeByPrefix(STORAGE_KEYS.STATS_DAILY_PREFIX);
    await storage.remove(STORAGE_KEYS.STATS_TOTALS);
  }
}

export const statsManager = new StatsManager();

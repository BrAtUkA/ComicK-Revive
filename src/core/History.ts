import { storage, STORAGE_KEYS } from './Storage';
import { statsManager, dayKey } from './Stats';

/**
 * HistoryManager - Chronological log of chapter opens
 *
 * One storage key (`reading_history`) holding a capped, append-only list.
 * The viewer records an entry every time a chapter opens; re-opening the
 * same chapter on the same day refreshes that entry instead of stacking
 * duplicates, so a session of flipping back and forth stays one line.
 *
 * The log starts empty on first ship: nothing recorded per-chapter before
 * it existed. A one-time seed converts the stats daily aggregates (which
 * manga were touched on which day) into coarse "reading session" entries so
 * the timeline isn't blank for existing users. Seeded entries carry
 * chapter -1 and `seeded: true`.
 */

export interface HistoryEntry {
  slug: string;
  /** Chapter number; -1 on seeded entries where only the day is known */
  chapter: number;
  /** Epoch ms of the (latest) open */
  at: number;
  seeded?: boolean;
  /** Furthest page reached this session (1-based) */
  page?: number;
  /** Chapter page total at the time */
  pages?: number;
  /** Active reading seconds spent in this chapter that day */
  sec?: number;
  /** Chapter actually finished this day: reached the last page, moved on
   * to the next chapter, or crossed its boundary in continuous scroll */
  fin?: boolean;
}

interface HistoryStore {
  v: 1;
  seededFromStats: boolean;
  /** Oldest first; readers reverse for display */
  entries: HistoryEntry[];
}

const MAX_ENTRIES = 1500;

const EMPTY_STORE: HistoryStore = { v: 1, seededFromStats: false, entries: [] };

export class HistoryManager {
  // All mutations funnel through one chain: the store is a single key, so
  // concurrent read-modify-write calls (recordOpen right after markFinished
  // on a continuous-scroll boundary) would clobber each other otherwise
  private writeChain: Promise<unknown> = Promise.resolve();

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<HistoryStore> {
    const store = await storage.get<HistoryStore>(STORAGE_KEYS.READING_HISTORY, { ...EMPTY_STORE, entries: [] });
    if (!Array.isArray(store.entries)) store.entries = [];
    return store;
  }

  private async persist(store: HistoryStore): Promise<void> {
    if (store.entries.length > MAX_ENTRIES) {
      store.entries = store.entries.slice(store.entries.length - MAX_ENTRIES);
    }
    await storage.set(STORAGE_KEYS.READING_HISTORY, store);
  }

  /** A chapter was opened in the reader */
  async recordOpen(slug: string, chapter: number): Promise<void> {
    return this.serialized(async () => {
      try {
        const store = await this.load();
        const now = Date.now();
        const today = dayKey();

        // Same chapter already logged today: refresh it and move it to the end
        // so the timeline shows the latest touch (session data carries over).
        // Only today's tail needs scanning; entries are appended in time order.
        let prior: HistoryEntry | undefined;
        for (let i = store.entries.length - 1; i >= 0; i--) {
          const e = store.entries[i];
          if (dayKey(new Date(e.at)) !== today) break;
          if (e.slug === slug && e.chapter === chapter) {
            prior = e;
            store.entries.splice(i, 1);
            break;
          }
        }

        store.entries.push({
          slug, chapter, at: now,
          page: prior?.page, pages: prior?.pages, sec: prior?.sec, fin: prior?.fin,
        });
        await this.persist(store);
      } catch (error) {
        console.warn('[History] recordOpen failed:', error);
      }
    });
  }

  /**
   * A chapter was genuinely finished: last page reached, next-chapter
   * navigation, or a forward boundary cross in continuous scroll. Upserts so
   * chapters read purely by scrolling (which bypass recordOpen) still land.
   */
  async markFinished(slug: string, chapter: number): Promise<void> {
    return this.serialized(async () => {
      try {
        const store = await this.load();
        const today = dayKey();
        for (let i = store.entries.length - 1; i >= 0; i--) {
          const e = store.entries[i];
          if (dayKey(new Date(e.at)) !== today) break;
          if (e.slug === slug && e.chapter === chapter) {
            if (e.fin) return;
            e.fin = true;
            await this.persist(store);
            return;
          }
        }
        store.entries.push({ slug, chapter, at: Date.now(), fin: true });
        await this.persist(store);
      } catch (error) {
        console.warn('[History] markFinished failed:', error);
      }
    });
  }

  // Session progress buffers: storage writes are throttled per chapter,
  // accumulated deltas ride along with the next allowed write
  private progressPending = new Map<string, { page?: number; pages?: number; sec: number }>();
  private progressLastWrite = new Map<string, number>();

  /**
   * Update today's entry for a chapter with session progress (furthest
   * page, page total, active seconds). Called from the viewer's autosave
   * and time-tracker flushes; writes hit storage at most every 15s per
   * chapter, so a crash loses one window at most.
   */
  async updateProgress(slug: string, chapter: number, patch: { page?: number; pages?: number; addSec?: number }): Promise<void> {
    const key = `${slug}|${chapter}`;
    const pending = this.progressPending.get(key) ?? { sec: 0 };
    if (patch.page !== undefined) pending.page = Math.max(pending.page ?? 0, patch.page);
    if (patch.pages !== undefined) pending.pages = patch.pages;
    pending.sec += patch.addSec ?? 0;
    this.progressPending.set(key, pending);

    const last = this.progressLastWrite.get(key) ?? 0;
    if (Date.now() - last < 15_000) return;

    return this.serialized(async () => {
      try {
        // Re-check under the lock: a concurrent call may have just flushed
        // this same buffer (autosave and the time tracker can fire together)
        if (Date.now() - (this.progressLastWrite.get(key) ?? 0) < 15_000) return;
        const buf = this.progressPending.get(key);
        if (!buf || (buf.page === undefined && buf.pages === undefined && buf.sec <= 0)) return;

        const store = await this.load();
        const today = dayKey();
        for (let i = store.entries.length - 1; i >= 0; i--) {
          const e = store.entries[i];
          if (dayKey(new Date(e.at)) !== today) break;
          if (e.slug === slug && e.chapter === chapter) {
            if (buf.page !== undefined) e.page = Math.max(e.page ?? 0, buf.page);
            if (buf.pages !== undefined) e.pages = buf.pages;
            if (buf.sec > 0) e.sec = Math.round((e.sec ?? 0) + buf.sec);
            // Reaching the last page counts as finishing the chapter
            if (e.pages && (e.page ?? 0) >= e.pages) e.fin = true;
            this.progressPending.set(key, { sec: 0 });
            this.progressLastWrite.set(key, Date.now());
            await this.persist(store);
            return;
          }
        }
      } catch (error) {
        console.warn('[History] updateProgress failed:', error);
      }
    });
  }

  /** Newest first */
  async getAll(): Promise<HistoryEntry[]> {
    const store = await this.load();
    return [...store.entries].reverse();
  }

  async clear(): Promise<void> {
    return this.serialized(async () => {
      await storage.set(STORAGE_KEYS.READING_HISTORY, { ...EMPTY_STORE, entries: [] } satisfies HistoryStore);
    });
  }

  /** Drop all entries for a manga (called when it's removed from the library) */
  async removeForSlug(slug: string): Promise<void> {
    return this.serialized(async () => {
      const store = await this.load();
      const before = store.entries.length;
      store.entries = store.entries.filter((e) => e.slug !== slug);
      if (store.entries.length !== before) {
        await this.persist(store);
      }
    });
  }

  /**
   * One-time backfill from stats daily aggregates; safe to call on every
   * History tab mount. Real entries recorded before the first seed run are
   * kept: seeded rows only fill in days older than the first real entry.
   */
  async seedFromStatsIfNeeded(): Promise<void> {
    const store = await this.load();
    if (store.seededFromStats) return;

    try {
      const daily = await statsManager.getAllDaily();
      const firstRealAt = store.entries.length > 0 ? store.entries[0].at : Number.POSITIVE_INFINITY;
      const seeded: HistoryEntry[] = [];
      for (const [day, stats] of Object.entries(daily)) {
        const [y, m, d] = day.split('-').map(Number);
        const at = new Date(y, m - 1, d, 12, 0, 0).getTime();
        if (at >= firstRealAt) continue;
        for (const slug of stats.manga ?? []) {
          seeded.push({ slug, chapter: -1, at, seeded: true });
        }
      }
      seeded.sort((a, b) => a.at - b.at);
      store.entries = [...seeded, ...store.entries];
    } catch (error) {
      console.warn('[History] seeding from stats failed:', error);
    }

    store.seededFromStats = true;
    await this.persist(store);
  }
}

export const historyManager = new HistoryManager();

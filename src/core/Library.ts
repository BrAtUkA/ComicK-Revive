import { storage, STORAGE_KEYS } from './Storage';

/**
 * LibraryManager - Per-manga library metadata beyond reading progress
 *
 * One storage key (`library_meta`) holding a slug-keyed map, so the whole
 * library loads in a single read. Reading progress itself stays in
 * reading_state_{slug}; this holds what the dashboard needs on top of it:
 * shelf status and new-chapter bookkeeping for the manual update check.
 *
 * Status model (decided 2026-07-06): statuses are manual with one automatic
 * rule. Finishing every known chapter counts as Completed; when new chapters
 * appear it moves back to Reading. On hold and Dropped are sticky and only
 * change by hand.
 */

export type LibraryStatus = 'reading' | 'completed' | 'onhold' | 'dropped';

export interface LibraryMeta {
  /** Manually chosen shelf; absent means Reading */
  status?: LibraryStatus;
  /** Highest chapter number the user has seen exist (clears the "new" badge) */
  knownLatest?: number;
  /** Chapter count from the last list fetch (for progress display) */
  totalChapters?: number;
  /** Latest chapter number from the last list fetch */
  latestChapter?: number;
  /** Epoch ms of the last manual update check for this manga */
  lastCheckedAt?: number;
  /** Chapters discovered above knownLatest by the last check */
  newCount?: number;
  /** Epoch ms when newCount last went above zero (drives "recently updated" sort) */
  lastNewAt?: number;
}

type LibraryMetaMap = Record<string, LibraryMeta>;

export class LibraryManager {
  private cache: LibraryMetaMap | null = null;

  private async load(): Promise<LibraryMetaMap> {
    if (this.cache) return this.cache;
    this.cache = await storage.get<LibraryMetaMap>(STORAGE_KEYS.LIBRARY_META, {});
    return this.cache;
  }

  private async persist(): Promise<void> {
    if (this.cache) {
      await storage.set(STORAGE_KEYS.LIBRARY_META, this.cache);
    }
  }

  async getAll(): Promise<LibraryMetaMap> {
    return { ...(await this.load()) };
  }

  async get(slug: string): Promise<LibraryMeta> {
    const all = await this.load();
    return { ...(all[slug] ?? {}) };
  }

  async update(slug: string, patch: Partial<LibraryMeta>): Promise<void> {
    const all = await this.load();
    all[slug] = { ...(all[slug] ?? {}), ...patch };
    await this.persist();
  }

  async setStatus(slug: string, status: LibraryStatus): Promise<void> {
    await this.update(slug, { status });
  }

  async remove(slug: string): Promise<void> {
    const all = await this.load();
    if (slug in all) {
      delete all[slug];
      await this.persist();
    }
  }

  /**
   * The user has seen the current chapter list (opened the manga or its
   * details): the "new" badge no longer applies.
   */
  async markSeen(slug: string, latestChapter: number, totalChapters?: number): Promise<void> {
    const all = await this.load();
    const meta = all[slug] ?? {};
    const patch: LibraryMeta = { ...meta, knownLatest: latestChapter, newCount: 0 };
    if (totalChapters !== undefined) {
      patch.totalChapters = totalChapters;
      patch.latestChapter = latestChapter;
    }
    all[slug] = patch;
    await this.persist();
  }

  /**
   * Record the outcome of an update check. Returns the number of chapters
   * newer than what the user had seen before this check.
   */
  async recordCheck(slug: string, latestChapter: number, totalChapters: number, newAboveKnown: number): Promise<number> {
    const all = await this.load();
    const meta = all[slug] ?? {};
    meta.lastCheckedAt = Date.now();
    meta.totalChapters = totalChapters;
    meta.latestChapter = latestChapter;
    if (meta.knownLatest === undefined) {
      // First ever check: nothing to compare against, baseline quietly
      meta.knownLatest = latestChapter;
      meta.newCount = 0;
    } else if (newAboveKnown > 0) {
      meta.newCount = newAboveKnown;
      meta.lastNewAt = Date.now();
    }
    all[slug] = meta;
    await this.persist();
    return meta.newCount ?? 0;
  }

  /** Drop the in-memory copy (after imports or cross-context writes) */
  invalidateCache(): void {
    this.cache = null;
  }
}

/**
 * Shelf a manga effectively sits on, applying the auto-complete rule on top
 * of the manual status. `readCount`/`total` come from reading state and the
 * cached chapter list; pass total = undefined when the list was never loaded.
 */
export function effectiveStatus(meta: LibraryMeta, readCount: number, total: number | undefined): LibraryStatus {
  const manual = meta.status ?? 'reading';
  if (manual === 'onhold' || manual === 'dropped') return manual;
  if (total && total > 0) {
    return readCount >= total ? 'completed' : 'reading';
  }
  return manual;
}

export const libraryManager = new LibraryManager();

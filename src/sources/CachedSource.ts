/**
 * CachedSource - Wrapper that adds caching layer to any MangaSource
 *
 * Caches chapter lists, page URLs, and manga details to reduce API calls
 * and improve load times for frequently accessed manga.
 */

import { MangaSource } from './Source.interface';
import { SearchResult, MangaDetails, Chapter, PageInfo } from '@/types';
import {
  bridgeGetCachedChapters,
  bridgeSetCachedChapters,
  bridgeGetCachedPages,
  bridgeSetCachedPages,
  bridgeInvalidateChapters,
  bridgeGetCachedDetails,
  bridgeSetCachedDetails,
  bridgeGetChapterPageCount,
  bridgeSetChapterPageTotal,
  type ChapterInfo,
  type PageInfo as CachePageInfo,
} from '@/utils/bridge';

/**
 * Create a cached wrapper around a MangaSource
 */
export function createCachedSource(source: MangaSource): CachedMangaSource {
  return new CachedMangaSource(source);
}

/**
 * CachedMangaSource - Implements MangaSource with caching
 */
export class CachedMangaSource implements MangaSource {
  private source: MangaSource;
  private forceRefreshChapters = false;
  private forceRefreshPages = false;

  // In-flight request deduplication maps
  private pendingDetails = new Map<string, Promise<MangaDetails>>();
  private pendingChapters = new Map<string, Promise<Chapter[]>>();
  private pendingPages = new Map<string, Promise<PageInfo[]>>();

  constructor(source: MangaSource) {
    this.source = source;
  }

  // Delegate properties
  get id() { return this.source.id; }
  get name() { return this.source.name; }
  get baseUrl() { return this.source.baseUrl; }
  get iconUrl() { return this.source.iconUrl; }
  get skipPageCache() { return this.source.skipPageCache; }
  get directImageLoad() { return this.source.directImageLoad; }

  /**
   * Set flag to force refresh chapters on next call
   * Used by refresh button in chapter picker
   */
  setForceRefreshChapters(force: boolean): void {
    this.forceRefreshChapters = force;
  }

  /**
   * Set flag to bypass image cache lookup on next getChapterPages call.
   * Used by retry logic to fetch real page URLs when cached images fail.
   */
  setForceRefreshPages(force: boolean): void {
    this.forceRefreshPages = force;
  }

  /**
   * Search - not cached (dynamic results)
   */
  async search(query: string, page?: number): Promise<SearchResult[]> {
    return this.source.search(query, page);
  }

  /**
   * Get manga details - cached with 30 day TTL
   */
  async getMangaDetails(slug: string): Promise<MangaDetails> {
    // Try cache first (background script handles enabled/disabled state)
    const cached = await bridgeGetCachedDetails(this.id, slug);
    if (cached) {
      console.log(`[CachedSource] Using cached manga details for ${slug}`);
      return cached;
    }

    // Deduplicate concurrent requests for the same slug
    const key = slug;
    if (this.pendingDetails.has(key)) {
      return this.pendingDetails.get(key)!;
    }

    const promise = (async () => {
      console.log(`[CachedSource] Fetching manga details for ${slug} from source`);
      const details = await this.source.getMangaDetails(slug);
      // Cache under the canonical slug
      await bridgeSetCachedDetails(this.id, details.slug, details);
      // Also cache under the input slug if it differs (e.g. base slug → full slug)
      // so future lookups with either key hit the cache
      if (details.slug !== slug) {
        await bridgeSetCachedDetails(this.id, slug, details);
      }
      console.log(`[CachedSource] Cached manga details for ${details.slug}`);
      return details;
    })();

    this.pendingDetails.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingDetails.delete(key);
    }
  }

  /**
   * Get chapter list - cached with 30 day TTL (use refresh button for updates)
   */
  async getChapterList(slug: string): Promise<Chapter[]> {
    // Check for forced refresh
    if (this.forceRefreshChapters) {
      console.log(`[CachedSource] Force refresh chapters for ${slug}`);
      this.forceRefreshChapters = false;
      await bridgeInvalidateChapters(this.id, slug);
    }

    // Try cache first (background script handles enabled/disabled state)
    const cached = await bridgeGetCachedChapters(this.id, slug);
    if (cached) {
      console.log(`[CachedSource] Using cached chapter list for ${slug} (${cached.length} chapters)`);
      return this.chapterInfoToChapters(cached);
    }

    // Deduplicate concurrent requests for the same slug
    const key = slug;
    if (this.pendingChapters.has(key)) {
      return this.pendingChapters.get(key)!;
    }

    const promise = (async () => {
      console.log(`[CachedSource] Fetching chapter list for ${slug} from source`);
      const chapters = await this.source.getChapterList(slug);

      if (chapters.length > 0) {
        const cacheData = this.chaptersToChapterInfo(chapters);
        await bridgeSetCachedChapters(this.id, slug, cacheData);
        console.log(`[CachedSource] Cached ${chapters.length} chapters for ${slug}`);
      }

      return chapters;
    })();

    this.pendingChapters.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingChapters.delete(key);
    }
  }

  /**
   * Invalidate chapter list cache (for refresh button)
   */
  async invalidateChapterList(slug: string): Promise<void> {
    await bridgeInvalidateChapters(this.id, slug);
    console.log(`[CachedSource] Invalidated chapter cache for ${slug}`);
  }

  /**
   * Get chapter pages with unified cache-first strategy:
   *
   * 1. Check if ALL image blobs are cached (any source) → return cached:// URLs
   * 2. Check page URL cache (non-skipPageCache sources only) → return cached URLs
   * 3. Fetch from source API
   *
   * forceRefreshPages bypasses both cache checks, ensuring fresh URLs from the source.
   */
  async getChapterPages(mangaSlug: string, chapterSlug: string): Promise<PageInfo[]> {
    // ─── Step 1: Image blob cache check (ALL sources) ───
    // If all page blobs exist in IndexedDB, return synthetic cached:// URLs.
    // loadImage() serves these directly from blob cache by position key.
    if (!this.forceRefreshPages) {
      const { count: cachedPageCount, total: storedTotal } = await bridgeGetChapterPageCount(
        this.id, mangaSlug, chapterSlug
      );
      if (storedTotal > 0 && cachedPageCount >= storedTotal) {
        console.log(
          `[CachedSource] Image cache hit for ${mangaSlug}/${chapterSlug} ` +
          `(${cachedPageCount}/${storedTotal} pages), serving from blob cache`
        );
        return Array.from({ length: storedTotal }, (_, i) => ({
          url: `cached://${this.id}/${mangaSlug}/${chapterSlug}/${i}`,
        }));
      }
    }

    // ─── Step 2: Page URL cache check (non-skipPageCache sources only) ───
    // Sources with stable URLs cache the page URL list (7-day TTL).
    // skipPageCache sources (e.g., MangaDex) skip this — their URLs expire in minutes.
    if (!this.source.skipPageCache && !this.forceRefreshPages) {
      const cached = await bridgeGetCachedPages(this.id, mangaSlug, chapterSlug);
      if (cached) {
        console.log(`[CachedSource] Using cached page URLs for ${mangaSlug}/${chapterSlug} (${cached.length} pages)`);
        return this.cachePageInfoToPages(cached);
      }
    }

    // ─── Step 3: Fetch from source ───
    // Deduplicate concurrent requests for the same chapter
    const key = `${mangaSlug}:${chapterSlug}`;
    if (this.pendingPages.has(key)) {
      this.forceRefreshPages = false; // Consume flag even when deduplicating
      return this.pendingPages.get(key)!;
    }

    // Consume force-refresh flag
    this.forceRefreshPages = false;

    const promise = (async () => {
      console.log(`[CachedSource] Fetching pages for ${mangaSlug}/${chapterSlug} from source`);
      const pages = await this.source.getChapterPages(mangaSlug, chapterSlug);

      if (pages.length > 0) {
        // Store total page count for blob-cache validation on future loads
        await bridgeSetChapterPageTotal(this.id, mangaSlug, chapterSlug, pages.length);

        // Cache page URLs for sources with stable URLs
        if (!this.source.skipPageCache) {
          const cacheData = this.pagesToCachePageInfo(pages);
          await bridgeSetCachedPages(this.id, mangaSlug, chapterSlug, cacheData);
          console.log(`[CachedSource] Cached ${pages.length} pages for ${mangaSlug}/${chapterSlug}`);
        } else {
          console.log(`[CachedSource] Stored page total (${pages.length}) for ${mangaSlug}/${chapterSlug}`);
        }
      }

      return pages;
    })();

    this.pendingPages.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingPages.delete(key);
    }
  }

  /**
   * Check availability - not cached
   */
  async checkAvailability(title: string): Promise<boolean> {
    return this.source.checkAvailability(title);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONVERSION HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Convert Chapter[] to ChapterInfo[] for caching
   */
  private chaptersToChapterInfo(chapters: Chapter[]): ChapterInfo[] {
    return chapters.map(ch => ({
      slug: ch.slug,
      number: ch.number,
      title: ch.title || null,
      volume: null, // Not used in current Chapter type
      publishedAt: ch.dateUpload ? new Date(ch.dateUpload).toISOString() : undefined,
    }));
  }

  /**
   * Convert ChapterInfo[] from cache back to Chapter[]
   */
  private chapterInfoToChapters(cached: ChapterInfo[]): Chapter[] {
    return cached.map(ch => ({
      slug: ch.slug,
      number: ch.number ?? 0,
      title: ch.title || `Chapter ${ch.number}`,
      dateUpload: ch.publishedAt ? new Date(ch.publishedAt).getTime() : Date.now(),
      isPremium: false,
    }));
  }

  /**
   * Convert PageInfo[] to CachePageInfo[] for caching
   */
  private pagesToCachePageInfo(pages: PageInfo[]): CachePageInfo[] {
    return pages.map((p, i) => ({
      url: p.url,
      index: i,
      width: p.width,
      height: p.height,
    }));
  }

  /**
   * Convert CachePageInfo[] from cache back to PageInfo[]
   */
  private cachePageInfoToPages(cached: CachePageInfo[]): PageInfo[] {
    return cached.map(p => ({
      url: p.url,
      width: p.width,
      height: p.height,
    }));
  }
}

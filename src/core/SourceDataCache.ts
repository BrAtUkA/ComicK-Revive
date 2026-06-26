/**
 * SourceDataCache - Persistent caching for source metadata
 * 
 * Caches chapter lists, page URLs, and manga details to reduce API calls to manga sources.
 * Uses IndexedDB for storage (same as image cache) for larger capacity.
 * 
 * TTL values:
 * - Chapter lists: 30 days (use refresh button for updates)
 * - Page URLs: 7 days (URLs rarely change once published)
 */

import { Chapter, PageInfo, MangaDetails } from '@/types';

const DB_NAME = 'comick-revive-source-cache';
const DB_VERSION = 2;
const CHAPTER_LIST_STORE = 'chapter_lists';
const CHAPTER_PAGES_STORE = 'chapter_pages';

const MANGA_DETAILS_STORE = 'manga_details';

// TTL constants in milliseconds
const TTL = {
  CHAPTER_LIST: 30 * 24 * 60 * 60 * 1000, // 30 days (use refresh button for updates)
  CHAPTER_PAGES: 7 * 24 * 60 * 60 * 1000,  // 7 days
  MANGA_DETAILS: 30 * 24 * 60 * 60 * 1000, // 30 days
};

export interface CachedChapterList {
  key: string;           // {sourceId}:{mangaSlug}
  chapters: Chapter[];
  timestamp: number;
  sourceId: string;
  mangaSlug: string;
}

export interface CachedChapterPages {
  key: string;           // {sourceId}:{mangaSlug}:{chapterSlug}
  pages: PageInfo[];
  timestamp: number;
  sourceId: string;
  mangaSlug: string;
  chapterSlug: string;
}

export interface CachedMangaDetails {
  key: string;           // {sourceId}:{mangaSlug}
  details: MangaDetails;
  timestamp: number;
  sourceId: string;
  mangaSlug: string;
}

/**
 * SourceDataCacheManager - Manages caching of source metadata
 */
export class SourceDataCacheManager {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private cacheEnabled: boolean = true;

  /**
   * Update cache settings (called when user changes settings)
   */
  updateSettings(settings: { enabled?: boolean }): void {
    if (settings.enabled !== undefined) {
      this.cacheEnabled = settings.enabled;
      console.log('[SourceDataCache] Cache enabled:', this.cacheEnabled);
    }
  }

  /**
   * Initialize IndexedDB
   */
  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('[SourceDataCache] Failed to open database:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('[SourceDataCache] Database opened successfully');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Chapter lists store
        if (!db.objectStoreNames.contains(CHAPTER_LIST_STORE)) {
          const store = db.createObjectStore(CHAPTER_LIST_STORE, { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('sourceId', 'sourceId', { unique: false });
        }

        // Chapter pages store
        if (!db.objectStoreNames.contains(CHAPTER_PAGES_STORE)) {
          const store = db.createObjectStore(CHAPTER_PAGES_STORE, { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('mangaKey', ['sourceId', 'mangaSlug'], { unique: false });
        }

        // Slug cache store (kept for DB compatibility, no longer used)
        if (!db.objectStoreNames.contains('slug_cache')) {
          const store = db.createObjectStore('slug_cache', { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Manga details store (added in v2)
        if (!db.objectStoreNames.contains(MANGA_DETAILS_STORE)) {
          const store = db.createObjectStore(MANGA_DETAILS_STORE, { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('sourceId', 'sourceId', { unique: false });
        }

        console.log('[SourceDataCache] Database schema created/upgraded');
      };
    });

    return this.initPromise;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER LIST CACHE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get cached chapter list
   */
  async getChapterList(sourceId: string, mangaSlug: string): Promise<Chapter[] | null> {
    // Return null if cache is disabled
    if (!this.cacheEnabled) return null;
    
    await this.init();
    if (!this.db) return null;

    const key = `${sourceId}:${mangaSlug}`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(CHAPTER_LIST_STORE, 'readwrite');
      const store = tx.objectStore(CHAPTER_LIST_STORE);
      const request = store.get(key);

      request.onsuccess = () => {
        const entry = request.result as CachedChapterList | undefined;

        if (!entry) {
          resolve(null);
          return;
        }

        // Check TTL
        if (Date.now() - entry.timestamp > TTL.CHAPTER_LIST) {
          // Expired - delete and return null
          store.delete(key);
          console.log('[SourceDataCache] Chapter list expired:', key);
          resolve(null);
          return;
        }

        console.log('[SourceDataCache] Chapter list cache hit:', key, `(${entry.chapters.length} chapters)`);
        resolve(entry.chapters);
      };

      request.onerror = () => {
        console.warn('[SourceDataCache] Failed to get chapter list:', key);
        resolve(null);
      };
    });
  }

  /**
   * Store chapter list in cache
   */
  async setChapterList(sourceId: string, mangaSlug: string, chapters: Chapter[]): Promise<boolean> {
    // Skip if cache is disabled
    if (!this.cacheEnabled) return false;
    
    await this.init();
    if (!this.db) return false;

    const key = `${sourceId}:${mangaSlug}`;
    const entry: CachedChapterList = {
      key,
      chapters,
      timestamp: Date.now(),
      sourceId,
      mangaSlug,
    };

    return new Promise((resolve) => {
      const tx = this.db!.transaction(CHAPTER_LIST_STORE, 'readwrite');
      const store = tx.objectStore(CHAPTER_LIST_STORE);
      const request = store.put(entry);

      request.onsuccess = () => {
        console.log('[SourceDataCache] Cached chapter list:', key, `(${chapters.length} chapters)`);
        resolve(true);
      };

      request.onerror = () => {
        console.warn('[SourceDataCache] Failed to cache chapter list:', key);
        resolve(false);
      };
    });
  }

  /**
   * Invalidate chapter list cache (for force refresh)
   */
  async invalidateChapterList(sourceId: string, mangaSlug: string): Promise<void> {
    await this.init();
    if (!this.db) return;

    const key = `${sourceId}:${mangaSlug}`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(CHAPTER_LIST_STORE, 'readwrite');
      const store = tx.objectStore(CHAPTER_LIST_STORE);
      store.delete(key);
      tx.oncomplete = () => {
        console.log('[SourceDataCache] Invalidated chapter list:', key);
        resolve();
      };
      tx.onerror = () => resolve();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER PAGES CACHE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get cached chapter pages
   */
  async getChapterPages(
    sourceId: string,
    mangaSlug: string,
    chapterSlug: string
  ): Promise<PageInfo[] | null> {
    // Return null if cache is disabled
    if (!this.cacheEnabled) return null;
    
    await this.init();
    if (!this.db) return null;

    const key = `${sourceId}:${mangaSlug}:${chapterSlug}`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(CHAPTER_PAGES_STORE, 'readwrite');
      const store = tx.objectStore(CHAPTER_PAGES_STORE);
      const request = store.get(key);

      request.onsuccess = () => {
        const entry = request.result as CachedChapterPages | undefined;

        if (!entry) {
          resolve(null);
          return;
        }

        // Check TTL
        if (Date.now() - entry.timestamp > TTL.CHAPTER_PAGES) {
          // Expired - delete and return null
          store.delete(key);
          console.log('[SourceDataCache] Chapter pages expired:', key);
          resolve(null);
          return;
        }

        console.log('[SourceDataCache] Chapter pages cache hit:', key, `(${entry.pages.length} pages)`);
        resolve(entry.pages);
      };

      request.onerror = () => {
        console.warn('[SourceDataCache] Failed to get chapter pages:', key);
        resolve(null);
      };
    });
  }

  /**
   * Store chapter pages in cache
   */
  async setChapterPages(
    sourceId: string,
    mangaSlug: string,
    chapterSlug: string,
    pages: PageInfo[]
  ): Promise<boolean> {
    // Skip if cache is disabled
    if (!this.cacheEnabled) return false;
    
    await this.init();
    if (!this.db) return false;

    const key = `${sourceId}:${mangaSlug}:${chapterSlug}`;
    const entry: CachedChapterPages = {
      key,
      pages,
      timestamp: Date.now(),
      sourceId,
      mangaSlug,
      chapterSlug,
    };

    return new Promise((resolve) => {
      const tx = this.db!.transaction(CHAPTER_PAGES_STORE, 'readwrite');
      const store = tx.objectStore(CHAPTER_PAGES_STORE);
      const request = store.put(entry);

      request.onsuccess = () => {
        console.log('[SourceDataCache] Cached chapter pages:', key, `(${pages.length} pages)`);
        resolve(true);
      };

      request.onerror = () => {
        console.warn('[SourceDataCache] Failed to cache chapter pages:', key);
        resolve(false);
      };
    });
  }

  /**
   * Clear cached chapter pages for a specific chapter (for reload)
   */
  async clearChapterPages(
    sourceId: string,
    mangaSlug: string,
    chapterSlug: string
  ): Promise<boolean> {
    await this.init();
    if (!this.db) return false;

    const key = `${sourceId}:${mangaSlug}:${chapterSlug}`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(CHAPTER_PAGES_STORE, 'readwrite');
      const store = tx.objectStore(CHAPTER_PAGES_STORE);
      const request = store.delete(key);

      request.onsuccess = () => {
        console.log('[SourceDataCache] Cleared chapter pages cache:', key);
        resolve(true);
      };

      request.onerror = () => {
        console.warn('[SourceDataCache] Failed to clear chapter pages:', key);
        resolve(false);
      };
    });
  }

  /**
   * Update dimensions for a specific page in cached chapter pages.
   * Only updates if the page URL matches (cache invalidation - Option C).
   * Used to persist image dimensions after first load for scroll preservation.
   */
  async updatePageDimensions(
    sourceId: string,
    mangaSlug: string,
    chapterSlug: string,
    pageIndex: number,
    url: string,
    width: number,
    height: number
  ): Promise<boolean> {
    // Skip if cache is disabled
    if (!this.cacheEnabled) return false;
    
    await this.init();
    if (!this.db) return false;

    const key = `${sourceId}:${mangaSlug}:${chapterSlug}`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(CHAPTER_PAGES_STORE, 'readwrite');
      const store = tx.objectStore(CHAPTER_PAGES_STORE);
      const getRequest = store.get(key);

      getRequest.onsuccess = () => {
        const entry = getRequest.result as CachedChapterPages | undefined;

        if (!entry) {
          // No cached pages - nothing to update
          resolve(false);
          return;
        }

        // Check if page exists and URL matches (cache invalidation check)
        if (pageIndex < 0 || pageIndex >= entry.pages.length) {
          resolve(false);
          return;
        }

        const page = entry.pages[pageIndex];
        if (page.url !== url) {
          // URL mismatch - cache is stale, skip update
          console.log('[SourceDataCache] Skipping dimension update - URL mismatch (stale cache)');
          resolve(false);
          return;
        }

        // Skip if dimensions already set
        if (page.width && page.height) {
          resolve(true); // Already has dimensions
          return;
        }

        // Update dimensions
        page.width = width;
        page.height = height;

        // Write back
        const putRequest = store.put(entry);
        putRequest.onsuccess = () => {
          console.log(`[SourceDataCache] Updated page ${pageIndex} dimensions: ${width}x${height}`);
          resolve(true);
        };
        putRequest.onerror = () => {
          console.warn('[SourceDataCache] Failed to update page dimensions');
          resolve(false);
        };
      };

      getRequest.onerror = () => {
        resolve(false);
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MANGA DETAILS CACHE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get cached manga details
   */
  async getMangaDetails(sourceId: string, mangaSlug: string): Promise<MangaDetails | null> {
    if (!this.cacheEnabled) return null;

    await this.init();
    if (!this.db) return null;

    const key = `${sourceId}:${mangaSlug}`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(MANGA_DETAILS_STORE, 'readwrite');
      const store = tx.objectStore(MANGA_DETAILS_STORE);
      const request = store.get(key);

      request.onsuccess = () => {
        const entry = request.result as CachedMangaDetails | undefined;

        if (!entry) {
          resolve(null);
          return;
        }

        if (Date.now() - entry.timestamp > TTL.MANGA_DETAILS) {
          store.delete(key);
          console.log('[SourceDataCache] Manga details expired:', key);
          resolve(null);
          return;
        }

        console.log('[SourceDataCache] Manga details cache hit:', key);
        resolve(entry.details);
      };

      request.onerror = () => {
        console.warn('[SourceDataCache] Failed to get manga details:', key);
        resolve(null);
      };
    });
  }

  /**
   * Store manga details in cache
   */
  async setMangaDetails(sourceId: string, mangaSlug: string, details: MangaDetails): Promise<boolean> {
    if (!this.cacheEnabled) return false;

    await this.init();
    if (!this.db) return false;

    const key = `${sourceId}:${mangaSlug}`;
    const entry: CachedMangaDetails = {
      key,
      details,
      timestamp: Date.now(),
      sourceId,
      mangaSlug,
    };

    return new Promise((resolve) => {
      const tx = this.db!.transaction(MANGA_DETAILS_STORE, 'readwrite');
      const store = tx.objectStore(MANGA_DETAILS_STORE);
      const request = store.put(entry);

      request.onsuccess = () => {
        console.log('[SourceDataCache] Cached manga details:', key);
        resolve(true);
      };

      request.onerror = () => {
        console.warn('[SourceDataCache] Failed to cache manga details:', key);
        resolve(false);
      };
    });
  }

  /**
   * Invalidate manga details cache
   */
  async invalidateMangaDetails(sourceId: string, mangaSlug: string): Promise<void> {
    await this.init();
    if (!this.db) return;

    const key = `${sourceId}:${mangaSlug}`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(MANGA_DETAILS_STORE, 'readwrite');
      const store = tx.objectStore(MANGA_DETAILS_STORE);
      store.delete(key);
      tx.oncomplete = () => {
        console.log('[SourceDataCache] Invalidated manga details:', key);
        resolve();
      };
      tx.onerror = () => resolve();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP & STATS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Clear all source data cache
   */
  async clearAll(): Promise<void> {
    await this.init();
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(
        [CHAPTER_LIST_STORE, CHAPTER_PAGES_STORE, MANGA_DETAILS_STORE],
        'readwrite'
      );

      tx.objectStore(CHAPTER_LIST_STORE).clear();
      tx.objectStore(CHAPTER_PAGES_STORE).clear();
      tx.objectStore(MANGA_DETAILS_STORE).clear();

      tx.oncomplete = () => {
        console.log('[SourceDataCache] All caches cleared');
        resolve();
      };
      tx.onerror = () => resolve();
    });
  }

  /**
   * Clear cache for a specific manga
   */
  async clearManga(sourceId: string, mangaSlug: string): Promise<void> {
    await this.init();
    if (!this.db) return;

    // Clear chapter list
    const chapterListKey = `${sourceId}:${mangaSlug}`;

    // Clear all chapter pages for this manga
    const pagesPrefix = `${sourceId}:${mangaSlug}:`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(
        [CHAPTER_LIST_STORE, CHAPTER_PAGES_STORE, MANGA_DETAILS_STORE],
        'readwrite'
      );

      // Delete chapter list
      tx.objectStore(CHAPTER_LIST_STORE).delete(chapterListKey);

      // Delete manga details
      tx.objectStore(MANGA_DETAILS_STORE).delete(chapterListKey);
      
      // Delete all chapter pages for this manga
      const pagesStore = tx.objectStore(CHAPTER_PAGES_STORE);
      const cursor = pagesStore.openCursor();
      
      cursor.onsuccess = (event) => {
        const c = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (c) {
          if (c.key.toString().startsWith(pagesPrefix)) {
            c.delete();
          }
          c.continue();
        }
      };

      tx.oncomplete = () => {
        console.log('[SourceDataCache] Cleared manga cache:', sourceId, mangaSlug);
        resolve();
      };
      tx.onerror = () => resolve();
    });
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    chapterListCount: number;
    chapterPagesCount: number;
    mangaDetailsCount: number;
  }> {
    await this.init();
    if (!this.db) {
      return { chapterListCount: 0, chapterPagesCount: 0, mangaDetailsCount: 0 };
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(
        [CHAPTER_LIST_STORE, CHAPTER_PAGES_STORE, MANGA_DETAILS_STORE],
        'readonly'
      );

      let chapterListCount = 0;
      let chapterPagesCount = 0;
      let mangaDetailsCount = 0;

      const countReq1 = tx.objectStore(CHAPTER_LIST_STORE).count();
      countReq1.onsuccess = () => { chapterListCount = countReq1.result; };

      const countReq2 = tx.objectStore(CHAPTER_PAGES_STORE).count();
      countReq2.onsuccess = () => { chapterPagesCount = countReq2.result; };

      const countReq3 = tx.objectStore(MANGA_DETAILS_STORE).count();
      countReq3.onsuccess = () => { mangaDetailsCount = countReq3.result; };

      tx.oncomplete = () => {
        resolve({ chapterListCount, chapterPagesCount, mangaDetailsCount });
      };
      tx.onerror = () => {
        resolve({ chapterListCount: 0, chapterPagesCount: 0, mangaDetailsCount: 0 });
      };
    });
  }

  /**
   * Get detailed per-manga source data cache breakdown
   */
  async getDetailedStats(): Promise<{
    chapterListCount: number;
    chapterPagesCount: number;
    mangaDetailsCount: number;
    totalBytes: number;
    chapterListBytes: number;
    chapterPagesBytes: number;
    mangaDetailsBytes: number;
    manga: Array<{
      sourceId: string;
      mangaSlug: string;
      hasChapterList: boolean;
      chapterListTimestamp: number | null;
      chapterListCount: number;
      cachedChapterPages: Array<{
        chapterSlug: string;
        pageCount: number;
        timestamp: number;
      }>;
      hasMangaDetails: boolean;
      mangaDetailsTimestamp: number | null;
    }>;
  }> {
    await this.init();
    if (!this.db) {
      return { chapterListCount: 0, chapterPagesCount: 0, mangaDetailsCount: 0, totalBytes: 0, chapterListBytes: 0, chapterPagesBytes: 0, mangaDetailsBytes: 0, manga: [] };
    }

    const mangaMap = new Map<string, {
      sourceId: string;
      mangaSlug: string;
      hasChapterList: boolean;
      chapterListTimestamp: number | null;
      chapterListCount: number;
      cachedChapterPages: Array<{
        chapterSlug: string;
        pageCount: number;
        timestamp: number;
      }>;
      hasMangaDetails: boolean;
      mangaDetailsTimestamp: number | null;
    }>();

    const getOrCreate = (sourceId: string, mangaSlug: string) => {
      const key = `${sourceId}:${mangaSlug}`;
      if (!mangaMap.has(key)) {
        mangaMap.set(key, {
          sourceId,
          mangaSlug,
          hasChapterList: false,
          chapterListTimestamp: null,
          chapterListCount: 0,
          cachedChapterPages: [],
          hasMangaDetails: false,
          mangaDetailsTimestamp: null,
        });
      }
      return mangaMap.get(key)!;
    };

    let chapterListCount = 0;
    let chapterPagesCount = 0;
    let mangaDetailsCount = 0;
    let totalBytes = 0;
    let chapterListBytes = 0;
    let chapterPagesBytes = 0;
    let mangaDetailsBytes = 0;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(
        [CHAPTER_LIST_STORE, CHAPTER_PAGES_STORE, MANGA_DETAILS_STORE],
        'readonly'
      );

      // Scan chapter lists
      const clCursor = tx.objectStore(CHAPTER_LIST_STORE).openCursor();
      clCursor.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const entry = cursor.value as CachedChapterList;
          chapterListCount++;
          const entryBytes = JSON.stringify(entry).length * 2;
          totalBytes += entryBytes;
          chapterListBytes += entryBytes;
          const info = getOrCreate(entry.sourceId, entry.mangaSlug);
          info.hasChapterList = true;
          info.chapterListTimestamp = entry.timestamp;
          info.chapterListCount = entry.chapters.length;
          cursor.continue();
        }
      };

      // Scan chapter pages
      const cpCursor = tx.objectStore(CHAPTER_PAGES_STORE).openCursor();
      cpCursor.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const entry = cursor.value as CachedChapterPages;
          chapterPagesCount++;
          const entryBytes = JSON.stringify(entry).length * 2;
          totalBytes += entryBytes;
          chapterPagesBytes += entryBytes;
          const info = getOrCreate(entry.sourceId, entry.mangaSlug);
          info.cachedChapterPages.push({
            chapterSlug: entry.chapterSlug,
            pageCount: entry.pages.length,
            timestamp: entry.timestamp,
          });
          cursor.continue();
        }
      };

      // Scan manga details
      const mdCursor = tx.objectStore(MANGA_DETAILS_STORE).openCursor();
      mdCursor.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const entry = cursor.value as CachedMangaDetails;
          mangaDetailsCount++;
          const entryBytes = JSON.stringify(entry).length * 2;
          totalBytes += entryBytes;
          mangaDetailsBytes += entryBytes;
          const info = getOrCreate(entry.sourceId, entry.mangaSlug);
          info.hasMangaDetails = true;
          info.mangaDetailsTimestamp = entry.timestamp;
          cursor.continue();
        }
      };

      tx.oncomplete = () => {
        resolve({
          chapterListCount,
          chapterPagesCount,
          mangaDetailsCount,
          totalBytes,
          chapterListBytes,
          chapterPagesBytes,
          mangaDetailsBytes,
          manga: Array.from(mangaMap.values()),
        });
      };
      tx.onerror = () => {
        resolve({ chapterListCount: 0, chapterPagesCount: 0, mangaDetailsCount: 0, totalBytes: 0, chapterListBytes: 0, chapterPagesBytes: 0, mangaDetailsBytes: 0, manga: [] });
      };
    });
  }
}

// Singleton instance for background script
export const sourceDataCache = new SourceDataCacheManager();

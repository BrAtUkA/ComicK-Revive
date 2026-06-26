/**
 * ImageCache - Persistent image caching using IndexedDB
 *
 * Stores manga page images with composite keys for organization:
 * {sourceId}:{mangaSlug}:{chapterSlug}:{pageIndex}
 *
 * Features:
 * - TTL-based expiration (0 = never expire)
 * - Maximum cache size limit (default 1GB) with configurable eviction
 * - Stores images as Blobs for efficiency
 * - Source-independent design
 */

import type { EvictionUnit, EvictionPriority } from '@/types';

const DB_NAME = 'comick-revive-image-cache';
const DB_VERSION = 1;
const STORE_NAME = 'images';
const META_STORE_NAME = 'metadata';

export interface CacheKey {
  sourceId: string;
  mangaSlug: string;
  chapterSlug: string;
  pageIndex: number;
}

export interface CachedImage {
  key: string;           // Composite key string
  blob: Blob;            // Image data
  mimeType: string;      // e.g., 'image/webp'
  size: number;          // Blob size in bytes
  timestamp: number;     // When cached
  lastAccessed: number;  // For LRU eviction
  originalUrl: string;   // Original URL for debugging
}

export interface CacheMetadata {
  totalSize: number;
  entryCount: number;
  lastCleanup: number;
}

export interface CacheSettings {
  enabled: boolean;
  ttlDays: number;
  maxSizeMB: number;
  evictionUnit: EvictionUnit;
  evictionPriority: EvictionPriority;
}

const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  enabled: true,
  ttlDays: 0,
  maxSizeMB: 1024,
  evictionUnit: 'chapter',
  evictionPriority: 'lru',
};

/** Detail about what was evicted, per manga */
export interface EvictionDetail {
  mangaSlug: string;
  chapters: Array<{ chapterSlug: string; pageCount: number; sizeMB: number }>;
}

export interface EvictionResult {
  evictedCount: number;
  freedBytes: number;
  evictedManga: string[];
  details: EvictionDetail[];
}

/**
 * ImageCacheManager - Manages IndexedDB image cache
 * 
 * This class runs in the background service worker context where
 * IndexedDB is available. The viewer communicates via message passing.
 */
export class ImageCacheManager {
  private db: IDBDatabase | null = null;
  private settings: CacheSettings = { ...DEFAULT_CACHE_SETTINGS };
  private initPromise: Promise<void> | null = null;
  private metadata: CacheMetadata = {
    totalSize: 0,
    entryCount: 0,
    lastCleanup: 0,
  };
  // Serialize eviction to prevent concurrent evictions from racing
  private evictionLock: Promise<void> = Promise.resolve();

  /**
   * Generate composite cache key from parts
   */
  static generateKey(parts: CacheKey): string {
    return `${parts.sourceId}:${parts.mangaSlug}:${parts.chapterSlug}:${parts.pageIndex}`;
  }

  /**
   * Parse composite key back to parts
   */
  static parseKey(key: string): CacheKey | null {
    const parts = key.split(':');
    if (parts.length < 4) return null;
    
    // Handle slugs that may contain colons by taking first, second, last parts
    const sourceId = parts[0];
    const mangaSlug = parts[1];
    const pageIndex = parseInt(parts[parts.length - 1], 10);
    const chapterSlug = parts.slice(2, -1).join(':');
    
    if (isNaN(pageIndex)) return null;
    
    return { sourceId, mangaSlug, chapterSlug, pageIndex };
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
        console.error('[ImageCache] Failed to open database:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('[ImageCache] Database opened successfully');
        this.loadMetadata()
          .then(() => this.loadSettings())
          .then(() => this.reconcileMetadata())
          .then(resolve)
          .catch((err) => {
            console.error('[ImageCache] Init metadata error:', err);
            resolve(); // still resolve — DB is open, just metadata may be stale
          });
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create images store with composite key
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('lastAccessed', 'lastAccessed', { unique: false });
          store.createIndex('size', 'size', { unique: false });
        }

        // Create metadata store
        if (!db.objectStoreNames.contains(META_STORE_NAME)) {
          db.createObjectStore(META_STORE_NAME, { keyPath: 'id' });
        }

        console.log('[ImageCache] Database schema created/upgraded');
      };
    });

    return this.initPromise;
  }

  /**
   * Load cache metadata from IndexedDB
   */
  private async loadMetadata(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(META_STORE_NAME, 'readonly');
      const store = tx.objectStore(META_STORE_NAME);
      const request = store.get('cache_meta');

      request.onsuccess = () => {
        if (request.result) {
          this.metadata = request.result;
        }
        resolve();
      };

      request.onerror = () => {
        console.warn('[ImageCache] Failed to load metadata:', request.error);
        resolve();
      };
    });
  }

  /**
   * Save cache metadata to IndexedDB
   */
  private async saveMetadata(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(META_STORE_NAME, 'readwrite');
      const store = tx.objectStore(META_STORE_NAME);
      store.put({ id: 'cache_meta', ...this.metadata });

      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.warn('[ImageCache] Failed to save metadata');
        resolve();
      };
    });
  }

  /**
   * Load cache settings from IndexedDB (survives service worker restarts)
   */
  private async loadSettings(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(META_STORE_NAME, 'readonly');
      const store = tx.objectStore(META_STORE_NAME);
      const request = store.get('cache_settings');

      request.onsuccess = () => {
        if (request.result) {
          const { id: _, ...saved } = request.result;
          this.settings = { ...DEFAULT_CACHE_SETTINGS, ...saved };
          console.log('[ImageCache] Restored settings:', this.settings);
        }
        resolve();
      };

      request.onerror = () => {
        console.warn('[ImageCache] Failed to load settings:', request.error);
        resolve();
      };
    });
  }

  /**
   * Save cache settings to IndexedDB
   */
  private async saveSettings(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(META_STORE_NAME, 'readwrite');
      const store = tx.objectStore(META_STORE_NAME);
      store.put({ id: 'cache_settings', ...this.settings });

      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.warn('[ImageCache] Failed to save settings');
        resolve();
      };
    });
  }

  /**
   * Reconcile metadata by scanning actual IndexedDB contents.
   * Fixes any drift between in-memory/persisted metadata and reality.
   */
  private async reconcileMetadata(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();

      let actualSize = 0;
      let actualCount = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const entry = cursor.value as CachedImage;
          actualSize += entry.size;
          actualCount++;
          cursor.continue();
        } else {
          const sizeDrift = Math.abs(this.metadata.totalSize - actualSize);
          const countDrift = Math.abs(this.metadata.entryCount - actualCount);

          if (sizeDrift > 1024 * 1024 || countDrift > 0) {
            console.warn(`[ImageCache] Metadata drift detected — size: ${(this.metadata.totalSize / 1024 / 1024).toFixed(1)}MB → ${(actualSize / 1024 / 1024).toFixed(1)}MB, count: ${this.metadata.entryCount} → ${actualCount}`);
            this.metadata.totalSize = actualSize;
            this.metadata.entryCount = actualCount;
            this.saveMetadata();
          }
          resolve();
        }
      };
      request.onerror = () => {
        console.error('[ImageCache] reconcileMetadata cursor failed:', request.error);
        resolve();
      };
    });
  }

  /**
   * Update settings (called when user changes settings).
   * If new max size is below current usage, triggers immediate eviction.
   */
  async updateSettings(settings: Partial<CacheSettings>): Promise<{ evicted?: { count: number; freedMB: number; manga: string[]; details: EvictionDetail[] } }> {
    this.settings = { ...this.settings, ...settings };
    console.log('[ImageCache] Settings updated:', this.settings);
    await this.saveSettings();

    // If max size reduced below current usage, evict immediately
    await this.init();
    const maxBytes = this.settings.maxSizeMB * 1024 * 1024;
    if (this.metadata.totalSize > maxBytes) {
      const result = await this.evict(0);
      return {
        evicted: {
          count: result.evictedCount,
          freedMB: Math.round(result.freedBytes / 1024 / 1024 * 10) / 10,
          manga: result.evictedManga,
          details: result.details,
        },
      };
    }
    return {};
  }

  /**
   * Get an image from cache
   * Returns null if not found or expired
   */
  async get(keyParts: CacheKey): Promise<{ blob: Blob; mimeType: string } | null> {
    if (!this.settings.enabled) return null;
    await this.init();
    if (!this.db) return null;

    const key = ImageCacheManager.generateKey(keyParts);

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const entry = request.result as CachedImage | undefined;

        if (!entry) {
          resolve(null);
          return;
        }

        // Check TTL (0 = never expire)
        if (this.settings.ttlDays > 0) {
          const ttlMs = this.settings.ttlDays * 24 * 60 * 60 * 1000;
          const isExpired = Date.now() - entry.timestamp > ttlMs;

          if (isExpired) {
            // Delete expired entry
            store.delete(key);
            this.metadata.totalSize -= entry.size;
            this.metadata.entryCount--;
            this.saveMetadata();
            resolve(null);
            return;
          }
        }

        // Update last accessed time for LRU
        entry.lastAccessed = Date.now();
        store.put(entry);

        resolve({ blob: entry.blob, mimeType: entry.mimeType });
      };

      request.onerror = () => {
        console.warn('[ImageCache] Failed to get:', key);
        resolve(null);
      };
    });
  }

  /**
   * Check if specific pages are in cache (existence check only, no blob loading)
   * Used to determine if chapter load will be fast (cached) or slow (network)
   * 
   * @param sourceId - Source ID
   * @param mangaSlug - Manga slug
   * @param chapterSlug - Chapter slug  
   * @param pageIndices - Array of page indices to check
   * @returns true if ALL specified pages exist in cache (not expired)
   */
  async arePagesInCache(
    sourceId: string,
    mangaSlug: string,
    chapterSlug: string,
    pageIndices: number[]
  ): Promise<boolean> {
    console.log('[ImageCache] arePagesInCache called:', { sourceId, mangaSlug, chapterSlug, pageIndices });
    
    if (!this.settings.enabled) {
      console.log('[ImageCache] Cache disabled, returning false');
      return false;
    }
    await this.init();
    if (!this.db) {
      console.log('[ImageCache] DB not initialized, returning false');
      return false;
    }
    
    if (pageIndices.length === 0) {
      console.log('[ImageCache] No pages to check, returning true');
      return true;
    }
    
    const ttlMs = this.settings.ttlDays > 0 ? this.settings.ttlDays * 24 * 60 * 60 * 1000 : 0;
    const now = Date.now();

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);

      let checkedCount = 0;
      let allExist = true;

      for (const pageIndex of pageIndices) {
        const key = ImageCacheManager.generateKey({
          sourceId,
          mangaSlug,
          chapterSlug,
          pageIndex
        });

        const request = store.get(key);

        request.onsuccess = () => {
          checkedCount++;
          const entry = request.result as CachedImage | undefined;

          if (!entry) {
            allExist = false;
          } else if (ttlMs > 0) {
            // Check TTL - expired entries don't count (skip if ttlDays = 0)
            const isExpired = now - entry.timestamp > ttlMs;
            if (isExpired) {
              allExist = false;
            }
          }
          
          // All pages checked
          if (checkedCount === pageIndices.length) {
            console.log('[ImageCache] arePagesInCache result:', { allExist, checkedCount });
            resolve(allExist);
          }
        };
        
        request.onerror = () => {
          checkedCount++;
          allExist = false;
          console.log('[ImageCache] Page check error for index', pageIndex);
          if (checkedCount === pageIndices.length) {
            console.log('[ImageCache] arePagesInCache result (with errors):', { allExist, checkedCount });
            resolve(allExist);
          }
        };
      }
    });
  }

  /**
   * Check if a chapter is fully cached (all pages present and not expired)
   * Convenience method that generates page indices and calls arePagesInCache
   * 
   * @param sourceId - Source ID
   * @param mangaSlug - Manga slug
   * @param chapterSlug - Chapter slug
   * @param totalPages - Total number of pages in the chapter
   * @returns true if ALL pages of the chapter are cached
   */
  async isChapterFullyCached(
    sourceId: string,
    mangaSlug: string,
    chapterSlug: string,
    totalPages: number
  ): Promise<boolean> {
    if (totalPages <= 0) return false;
    
    const pageIndices = Array.from({ length: totalPages }, (_, i) => i);
    return this.arePagesInCache(sourceId, mangaSlug, chapterSlug, pageIndices);
  }

  /**
   * Count how many cached pages exist for a chapter.
   * Scans IndexedDB keys with the chapter prefix and returns the count.
   * Used to serve cached images without fetching ephemeral page URLs.
   */
  async getChapterPageCount(
    sourceId: string,
    mangaSlug: string,
    chapterSlug: string
  ): Promise<number> {
    if (!this.settings.enabled) return 0;
    await this.init();
    if (!this.db) return 0;

    const prefix = `${sourceId}:${mangaSlug}:${chapterSlug}:`;
    const ttlMs = this.settings.ttlDays > 0 ? this.settings.ttlDays * 86400000 : 0;
    const now = Date.now();

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      // Use key range to scan only keys with our chapter prefix
      const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
      const request = store.openCursor(range);
      let count = 0;

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(count);
          return;
        }
        // Skip expired entries
        if (ttlMs > 0 && now - cursor.value.timestamp > ttlMs) {
          cursor.continue();
          return;
        }
        count++;
        cursor.continue();
      };

      request.onerror = () => {
        console.error('[ImageCache] getChapterPageCount cursor error');
        resolve(count);
      };
    });
  }

  /**
   * Store the total page count for a chapter.
   * Called after a successful network fetch so we know the expected count
   * for partial-cache validation on subsequent loads.
   */
  async setChapterPageTotal(
    sourceId: string,
    mangaSlug: string,
    chapterSlug: string,
    totalPages: number
  ): Promise<void> {
    await this.init();
    if (!this.db) return;

    const id = `chapter_total:${sourceId}:${mangaSlug}:${chapterSlug}`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(META_STORE_NAME, 'readwrite');
      const store = tx.objectStore(META_STORE_NAME);
      store.put({ id, totalPages });
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.warn('[ImageCache] Failed to save chapter page total');
        resolve();
      };
    });
  }

  /**
   * Get the stored total page count for a chapter.
   * Returns 0 if not stored.
   */
  async getChapterPageTotal(
    sourceId: string,
    mangaSlug: string,
    chapterSlug: string
  ): Promise<number> {
    await this.init();
    if (!this.db) return 0;

    const id = `chapter_total:${sourceId}:${mangaSlug}:${chapterSlug}`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(META_STORE_NAME, 'readonly');
      const store = tx.objectStore(META_STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => {
        resolve(request.result?.totalPages || 0);
      };
      request.onerror = () => resolve(0);
    });
  }

  /**
   * Delete the stored total page count for a chapter.
   */
  private async deleteChapterPageTotal(
    sourceId: string,
    mangaSlug: string,
    chapterSlug: string
  ): Promise<void> {
    if (!this.db) return;

    const id = `chapter_total:${sourceId}:${mangaSlug}:${chapterSlug}`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(META_STORE_NAME, 'readwrite');
      const store = tx.objectStore(META_STORE_NAME);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  /**
   * Delete all chapter_total records for a manga.
   */
  private async deleteChapterPageTotalsForManga(
    sourceId: string,
    mangaSlug: string
  ): Promise<void> {
    if (!this.db) return;

    const prefix = `chapter_total:${sourceId}:${mangaSlug}:`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(META_STORE_NAME, 'readwrite');
      const store = tx.objectStore(META_STORE_NAME);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  /**
   * Delete all chapter_total metadata records.
   */
  private async deleteAllChapterPageTotals(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(META_STORE_NAME, 'readwrite');
      const store = tx.objectStore(META_STORE_NAME);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          if (typeof cursor.key === 'string' && cursor.key.startsWith('chapter_total:')) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  /**
   * Store an image in cache
   * Returns eviction info if eviction was triggered
   */
  async set(
    keyParts: CacheKey,
    blob: Blob,
    mimeType: string,
    originalUrl: string
  ): Promise<{ success: boolean; evicted?: EvictionResult }> {
    if (!this.settings.enabled) return { success: false };
    await this.init();
    if (!this.db) return { success: false };

    const key = ImageCacheManager.generateKey(keyParts);
    const size = blob.size;

    // Check if we need to evict entries (serialized to prevent concurrent over-eviction)
    let evictionResult: EvictionResult | undefined;
    const maxSizeBytes = this.settings.maxSizeMB * 1024 * 1024;
    if (this.metadata.totalSize + size > maxSizeBytes) {
      // Serialize eviction through lock
      const prevLock = this.evictionLock;
      let releaseLock: () => void;
      this.evictionLock = new Promise(resolve => { releaseLock = resolve; });
      await prevLock;
      try {
        // Re-check after acquiring lock (another eviction may have freed space)
        if (this.metadata.totalSize + size > maxSizeBytes) {
          evictionResult = await this.evict(size);
        }
      } finally {
        releaseLock!();
      }
    }

    const entry: CachedImage = {
      key,
      blob,
      mimeType,
      size,
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      originalUrl,
    };

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      // Check if key exists (to update metadata correctly)
      const getRequest = store.get(key);

      getRequest.onsuccess = () => {
        const existing = getRequest.result as CachedImage | undefined;

        if (existing) {
          // Update existing entry
          this.metadata.totalSize -= existing.size;
        } else {
          // New entry
          this.metadata.entryCount++;
        }

        this.metadata.totalSize += size;

        const putRequest = store.put(entry);

        putRequest.onsuccess = () => {
          this.saveMetadata();
          console.log(`[ImageCache] Cached: ${key} (${(size / 1024).toFixed(1)} KB)`);
          resolve({ success: true, evicted: evictionResult });
        };

        putRequest.onerror = () => {
          // Rollback metadata changes since put failed
          this.metadata.totalSize -= size;
          if (!existing) {
            this.metadata.entryCount--;
          } else {
            this.metadata.totalSize += existing.size;
          }
          console.warn('[ImageCache] Failed to cache:', key);
          resolve({ success: false });
        };
      };

      getRequest.onerror = () => {
        resolve({ success: false });
      };
    });
  }

  /**
   * Evict cached entries to make room, using the configured strategy.
   * Supports per-manga or per-image granularity, with LRU or oldest-first ordering.
   */
  private async evict(neededBytes: number): Promise<EvictionResult> {
    if (!this.db) return { evictedCount: 0, freedBytes: 0, evictedManga: [], details: [] };

    if (this.settings.evictionUnit === 'image') {
      return this.evictByImage(neededBytes);
    }
    if (this.settings.evictionUnit === 'chapter') {
      return this.evictByChapter(neededBytes);
    }
    return this.evictByManga(neededBytes);
  }

  /**
   * Per-image eviction: delete individual images sorted by LRU or oldest cached.
   */
  private async evictByImage(neededBytes: number): Promise<EvictionResult> {
    if (!this.db) return { evictedCount: 0, freedBytes: 0, evictedManga: [], details: [] };

    const maxSizeBytes = this.settings.maxSizeMB * 1024 * 1024;
    const targetSize = maxSizeBytes - neededBytes - (10 * 1024 * 1024);

    const indexName = this.settings.evictionPriority === 'lru' ? 'lastAccessed' : 'timestamp';
    let freedBytes = 0;
    let evictedCount = 0;
    const evictedEntries: Array<{ mangaSlug: string; chapterSlug: string; size: number }> = [];

    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index(indexName);
      const request = index.openCursor(); // ascending = oldest/least-recently-accessed first

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor && this.metadata.totalSize - freedBytes > targetSize) {
          const entry = cursor.value as CachedImage;
          const parsed = ImageCacheManager.parseKey(entry.key);
          freedBytes += entry.size;
          evictedCount++;
          if (parsed) {
            evictedEntries.push({ mangaSlug: parsed.mangaSlug, chapterSlug: parsed.chapterSlug, size: entry.size });
          }
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => resolve();
    });

    this.metadata.totalSize -= freedBytes;
    this.metadata.entryCount -= evictedCount;
    await this.saveMetadata();

    // Build details from evicted entries
    const details = this.buildEvictionDetails(evictedEntries);
    const evictedManga = [...new Set(evictedEntries.map(e => e.mangaSlug))];

    console.log(`[ImageCache] Evicted ${evictedCount} images (per-image ${this.settings.evictionPriority}), freed ${(freedBytes / 1024 / 1024).toFixed(1)} MB`);
    return { evictedCount, freedBytes, evictedManga, details };
  }

  /**
   * Per-chapter eviction: evict entire chapters to keep chapter integrity.
   * Groups by sourceId:mangaSlug:chapterSlug, sorts by configured priority, deletes whole chapters at a time.
   */
  private async evictByChapter(neededBytes: number): Promise<EvictionResult> {
    if (!this.db) return { evictedCount: 0, freedBytes: 0, evictedManga: [], details: [] };

    const maxSizeBytes = this.settings.maxSizeMB * 1024 * 1024;
    const targetSize = maxSizeBytes - neededBytes - (10 * 1024 * 1024);

    // Phase 1: Scan all entries and group by chapter
    const chapterGroups = new Map<string, { totalSize: number; imageCount: number; sortKey: number; mangaSlug: string; chapterSlug: string }>();

    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const entry = cursor.value as CachedImage;
          const parsed = ImageCacheManager.parseKey(entry.key);
          if (parsed) {
            const chapterKey = `${parsed.sourceId}:${parsed.mangaSlug}:${parsed.chapterSlug}`;
            const group = chapterGroups.get(chapterKey);
            const entryKey = this.settings.evictionPriority === 'lru' ? entry.lastAccessed : entry.timestamp;
            if (group) {
              group.totalSize += entry.size;
              group.imageCount++;
              if (this.settings.evictionPriority === 'lru') {
                group.sortKey = Math.max(group.sortKey, entryKey);
              } else {
                group.sortKey = Math.min(group.sortKey, entryKey);
              }
            } else {
              chapterGroups.set(chapterKey, {
                totalSize: entry.size,
                imageCount: 1,
                sortKey: entryKey,
                mangaSlug: parsed.mangaSlug,
                chapterSlug: parsed.chapterSlug,
              });
            }
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => resolve();
    });

    // Phase 2: Sort chapters ascending by sort key
    const sorted = Array.from(chapterGroups.entries())
      .sort(([, a], [, b]) => a.sortKey - b.sortKey);

    // Phase 3: Select chapters to evict
    const chaptersToEvict: string[] = [];
    let plannedFree = 0;

    for (const [chapterKey, group] of sorted) {
      if (this.metadata.totalSize - plannedFree <= targetSize) break;
      chaptersToEvict.push(chapterKey);
      plannedFree += group.totalSize;
    }

    if (chaptersToEvict.length === 0) return { evictedCount: 0, freedBytes: 0, evictedManga: [], details: [] };

    // Phase 4: Delete all entries for selected chapters
    const prefixes = new Set(chaptersToEvict.map(k => k + ':'));
    let freedBytes = 0;
    let evictedCount = 0;

    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const entry = cursor.value as CachedImage;
          let shouldDelete = false;
          for (const prefix of prefixes) {
            if (entry.key.startsWith(prefix)) {
              shouldDelete = true;
              break;
            }
          }
          if (shouldDelete) {
            freedBytes += entry.size;
            evictedCount++;
            cursor.delete();
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => resolve();
    });

    this.metadata.totalSize -= freedBytes;
    this.metadata.entryCount -= evictedCount;
    await this.saveMetadata();

    // Collect unique manga slugs from evicted chapters
    const evictedMangaSlugs = [...new Set(chaptersToEvict.map(k => {
      const group = chapterGroups.get(k);
      return group?.mangaSlug || k.split(':')[1];
    }))];

    // Build details from evicted chapters
    const evictedEntries = chaptersToEvict.map(k => {
      const group = chapterGroups.get(k)!;
      return { mangaSlug: group.mangaSlug, chapterSlug: group.chapterSlug, size: group.totalSize, pageCount: group.imageCount };
    });
    const detailMap = new Map<string, EvictionDetail>();
    for (const e of evictedEntries) {
      const detail = detailMap.get(e.mangaSlug);
      const ch = { chapterSlug: e.chapterSlug, pageCount: e.pageCount, sizeMB: Math.round(e.size / 1024 / 1024 * 10) / 10 };
      if (detail) {
        detail.chapters.push(ch);
      } else {
        detailMap.set(e.mangaSlug, { mangaSlug: e.mangaSlug, chapters: [ch] });
      }
    }
    const details = [...detailMap.values()];

    console.log(`[ImageCache] Evicted ${evictedCount} entries from ${chaptersToEvict.length} chapters (per-chapter ${this.settings.evictionPriority}), freed ${(freedBytes / 1024 / 1024).toFixed(1)} MB`);
    return { evictedCount, freedBytes, evictedManga: evictedMangaSlugs, details };
  }

  /**
   * Per-manga eviction: evict entire manga caches to keep chapters intact.
   * Groups by manga, sorts by configured priority, deletes whole manga at a time.
   */
  private async evictByManga(neededBytes: number): Promise<EvictionResult> {
    if (!this.db) return { evictedCount: 0, freedBytes: 0, evictedManga: [], details: [] };

    const maxSizeBytes = this.settings.maxSizeMB * 1024 * 1024;
    const targetSize = maxSizeBytes - neededBytes - (10 * 1024 * 1024); // Leave 10MB buffer

    // Phase 1: Scan all entries and group by manga
    const mangaGroups = new Map<string, { totalSize: number; imageCount: number; sortKey: number }>();

    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const entry = cursor.value as CachedImage;
          const parsed = ImageCacheManager.parseKey(entry.key);
          if (parsed) {
            const mangaKey = `${parsed.sourceId}:${parsed.mangaSlug}`;
            const group = mangaGroups.get(mangaKey);
            const entryKey = this.settings.evictionPriority === 'lru' ? entry.lastAccessed : entry.timestamp;
            if (group) {
              group.totalSize += entry.size;
              group.imageCount++;
              // For LRU: use max lastAccessed (most recent access in this manga)
              // For oldest: use min timestamp (oldest cached entry in this manga)
              if (this.settings.evictionPriority === 'lru') {
                group.sortKey = Math.max(group.sortKey, entryKey);
              } else {
                group.sortKey = Math.min(group.sortKey, entryKey);
              }
            } else {
              mangaGroups.set(mangaKey, {
                totalSize: entry.size,
                imageCount: 1,
                sortKey: entryKey,
              });
            }
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => resolve();
    });

    // Phase 2: Sort manga ascending by sort key (evict first = lowest value)
    const sorted = Array.from(mangaGroups.entries())
      .sort(([, a], [, b]) => a.sortKey - b.sortKey);

    // Phase 3: Select manga to evict until we're under target
    const mangaToEvict: string[] = [];
    let plannedFree = 0;

    for (const [mangaKey, group] of sorted) {
      if (this.metadata.totalSize - plannedFree <= targetSize) break;
      mangaToEvict.push(mangaKey);
      plannedFree += group.totalSize;
    }

    if (mangaToEvict.length === 0) return { evictedCount: 0, freedBytes: 0, evictedManga: [], details: [] };

    // Phase 4: Delete all entries for selected manga
    const prefixes = new Set(mangaToEvict.map(k => k + ':'));
    let freedBytes = 0;
    let evictedCount = 0;
    const evictedEntries: Array<{ mangaSlug: string; chapterSlug: string; size: number }> = [];

    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const entry = cursor.value as CachedImage;
          let shouldDelete = false;
          for (const prefix of prefixes) {
            if (entry.key.startsWith(prefix)) {
              shouldDelete = true;
              break;
            }
          }
          if (shouldDelete) {
            freedBytes += entry.size;
            evictedCount++;
            const parsed = ImageCacheManager.parseKey(entry.key);
            if (parsed) {
              evictedEntries.push({ mangaSlug: parsed.mangaSlug, chapterSlug: parsed.chapterSlug, size: entry.size });
            }
            cursor.delete();
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => resolve();
    });

    this.metadata.totalSize -= freedBytes;
    this.metadata.entryCount -= evictedCount;
    await this.saveMetadata();

    const evictedSlugs = mangaToEvict.map(k => k.split(':')[1]);
    const details = this.buildEvictionDetails(evictedEntries);
    console.log(`[ImageCache] Evicted ${evictedCount} entries from ${mangaToEvict.length} manga (per-manga ${this.settings.evictionPriority}), freed ${(freedBytes / 1024 / 1024).toFixed(1)} MB`);

    return { evictedCount, freedBytes, evictedManga: evictedSlugs, details };
  }

  /** Build EvictionDetail[] from a flat list of evicted entries */
  private buildEvictionDetails(entries: Array<{ mangaSlug: string; chapterSlug: string; size: number }>): EvictionDetail[] {
    const detailMap = new Map<string, EvictionDetail>();
    // Track per-chapter page counts
    const chapterCounts = new Map<string, { pageCount: number; size: number }>();

    for (const e of entries) {
      const chKey = `${e.mangaSlug}:${e.chapterSlug}`;
      const ch = chapterCounts.get(chKey);
      if (ch) {
        ch.pageCount++;
        ch.size += e.size;
      } else {
        chapterCounts.set(chKey, { pageCount: 1, size: e.size });
      }
    }

    for (const [chKey, info] of chapterCounts) {
      const [mangaSlug, chapterSlug] = chKey.split(':');
      const detail = detailMap.get(mangaSlug);
      const ch = { chapterSlug, pageCount: info.pageCount, sizeMB: Math.round(info.size / 1024 / 1024 * 10) / 10 };
      if (detail) {
        detail.chapters.push(ch);
      } else {
        detailMap.set(mangaSlug, { mangaSlug, chapters: [ch] });
      }
    }

    return [...detailMap.values()];
  }

  /**
   * Clean up expired entries based on TTL
   */
  async cleanup(): Promise<{ removed: number; freedBytes: number }> {
    await this.init();
    if (!this.db) return { removed: 0, freedBytes: 0 };

    // TTL = 0 means "never expire" — nothing to clean up
    if (this.settings.ttlDays <= 0) return { removed: 0, freedBytes: 0 };

    const ttlMs = this.settings.ttlDays * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - ttlMs;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('timestamp');
      const range = IDBKeyRange.upperBound(cutoffTime);
      const request = index.openCursor(range);

      let removed = 0;
      let freedBytes = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

        if (cursor) {
          const entry = cursor.value as CachedImage;
          freedBytes += entry.size;
          removed++;
          cursor.delete();
          cursor.continue();
        } else {
          this.metadata.totalSize -= freedBytes;
          this.metadata.entryCount -= removed;
          this.metadata.lastCleanup = Date.now();
          this.saveMetadata();
          
          console.log(`[ImageCache] Cleanup: removed ${removed} expired entries, freed ${(freedBytes / 1024 / 1024).toFixed(1)} MB`);
          resolve({ removed, freedBytes });
        }
      };

      request.onerror = () => resolve({ removed: 0, freedBytes: 0 });
    });
  }

  /**
   * Clear all cached images
   */
  async clearAll(): Promise<void> {
    await this.init();
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();

      tx.oncomplete = () => {
        this.metadata = {
          totalSize: 0,
          entryCount: 0,
          lastCleanup: Date.now(),
        };
        this.saveMetadata();
        this.deleteAllChapterPageTotals();
        console.log('[ImageCache] Cache cleared');
        resolve();
      };

      tx.onerror = () => resolve();
    });
  }

  /**
   * Clear cache for a specific manga
   */
  async clearManga(sourceId: string, mangaSlug: string): Promise<number> {
    await this.init();
    if (!this.db) return 0;

    const prefix = `${sourceId}:${mangaSlug}:`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();

      let removed = 0;
      let freedBytes = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

        if (cursor) {
          const entry = cursor.value as CachedImage;
          if (entry.key.startsWith(prefix)) {
            freedBytes += entry.size;
            removed++;
            cursor.delete();
          }
          cursor.continue();
        } else {
          this.metadata.totalSize -= freedBytes;
          this.metadata.entryCount -= removed;
          this.saveMetadata();
          
          console.log(`[ImageCache] Cleared manga ${mangaSlug}: ${removed} entries`);
          this.deleteChapterPageTotalsForManga(sourceId, mangaSlug);
          resolve(removed);
        }
      };

      request.onerror = () => resolve(0);
    });
  }

  /**
   * Clear cache for a specific chapter
   */
  async clearChapter(sourceId: string, mangaSlug: string, chapterSlug: string): Promise<number> {
    await this.init();
    if (!this.db) return 0;

    const prefix = `${sourceId}:${mangaSlug}:${chapterSlug}:`;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();

      let removed = 0;
      let freedBytes = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

        if (cursor) {
          const entry = cursor.value as CachedImage;
          if (entry.key.startsWith(prefix)) {
            freedBytes += entry.size;
            removed++;
            cursor.delete();
          }
          cursor.continue();
        } else {
          this.metadata.totalSize -= freedBytes;
          this.metadata.entryCount -= removed;
          this.saveMetadata();
          
          console.log(`[ImageCache] Cleared chapter ${chapterSlug}: ${removed} entries`);
          this.deleteChapterPageTotal(sourceId, mangaSlug, chapterSlug);
          resolve(removed);
        }
      };

      request.onerror = () => resolve(0);
    });
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    enabled: boolean;
    entryCount: number;
    totalSizeMB: number;
    maxSizeMB: number;
    ttlDays: number;
    lastCleanup: number;
  }> {
    await this.init();
    return {
      enabled: this.settings.enabled,
      entryCount: this.metadata.entryCount,
      totalSizeMB: Math.round(this.metadata.totalSize / 1024 / 1024 * 10) / 10,
      maxSizeMB: this.settings.maxSizeMB,
      ttlDays: this.settings.ttlDays,
      lastCleanup: this.metadata.lastCleanup,
    };
  }

  /**
   * Get detailed per-manga/per-chapter cache breakdown
   */
  async getDetailedStats(): Promise<{
    totalSize: number;
    totalEntries: number;
    maxSizeMB: number;
    ttlDays: number;
    enabled: boolean;
    lastCleanup: number;
    manga: Array<{
      sourceId: string;
      mangaSlug: string;
      imageCount: number;
      totalSize: number;
      chapters: Array<{
        chapterSlug: string;
        imageCount: number;
        totalSize: number;
        oldestTimestamp: number;
        newestTimestamp: number;
      }>;
    }>;
  }> {
    await this.init();

    const mangaMap = new Map<string, Map<string, {
      imageCount: number;
      totalSize: number;
      oldestTimestamp: number;
      newestTimestamp: number;
    }>>();

    if (this.db) {
      await new Promise<void>((resolve) => {
        const tx = this.db!.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.openCursor();

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const entry = cursor.value as CachedImage;
            const parsed = ImageCacheManager.parseKey(entry.key);
            if (parsed) {
              const mangaKey = `${parsed.sourceId}:${parsed.mangaSlug}`;
              if (!mangaMap.has(mangaKey)) {
                mangaMap.set(mangaKey, new Map());
              }
              const chapters = mangaMap.get(mangaKey)!;
              const ch = chapters.get(parsed.chapterSlug);
              if (ch) {
                ch.imageCount++;
                ch.totalSize += entry.size;
                ch.oldestTimestamp = Math.min(ch.oldestTimestamp, entry.timestamp);
                ch.newestTimestamp = Math.max(ch.newestTimestamp, entry.timestamp);
              } else {
                chapters.set(parsed.chapterSlug, {
                  imageCount: 1,
                  totalSize: entry.size,
                  oldestTimestamp: entry.timestamp,
                  newestTimestamp: entry.timestamp,
                });
              }
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => resolve();
      });
    }

    const manga: Array<{
      sourceId: string;
      mangaSlug: string;
      imageCount: number;
      totalSize: number;
      chapters: Array<{
        chapterSlug: string;
        imageCount: number;
        totalSize: number;
        oldestTimestamp: number;
        newestTimestamp: number;
      }>;
    }> = [];

    for (const [mangaKey, chapters] of mangaMap) {
      const [sourceId, mangaSlug] = mangaKey.split(':');
      let totalSize = 0;
      let imageCount = 0;
      const chapterList: Array<{
        chapterSlug: string;
        imageCount: number;
        totalSize: number;
        oldestTimestamp: number;
        newestTimestamp: number;
      }> = [];

      for (const [chapterSlug, info] of chapters) {
        totalSize += info.totalSize;
        imageCount += info.imageCount;
        chapterList.push({ chapterSlug, ...info });
      }

      chapterList.sort((a, b) => a.chapterSlug.localeCompare(b.chapterSlug, undefined, { numeric: true }));
      manga.push({ sourceId, mangaSlug, imageCount, totalSize, chapters: chapterList });
    }

    manga.sort((a, b) => b.totalSize - a.totalSize);

    // Compute actual totals from the scan (not stale metadata)
    const actualSize = manga.reduce((sum, m) => sum + m.totalSize, 0);
    const actualEntries = manga.reduce((sum, m) => sum + m.imageCount, 0);

    // Auto-correct metadata if it has drifted
    if (actualSize !== this.metadata.totalSize || actualEntries !== this.metadata.entryCount) {
      console.warn(`[ImageCache] Correcting metadata drift — size: ${(this.metadata.totalSize / 1024 / 1024).toFixed(1)}MB → ${(actualSize / 1024 / 1024).toFixed(1)}MB, count: ${this.metadata.entryCount} → ${actualEntries}`);
      this.metadata.totalSize = actualSize;
      this.metadata.entryCount = actualEntries;
      this.saveMetadata();
    }

    return {
      totalSize: actualSize,
      totalEntries: actualEntries,
      maxSizeMB: this.settings.maxSizeMB,
      ttlDays: this.settings.ttlDays,
      enabled: this.settings.enabled,
      lastCleanup: this.metadata.lastCleanup,
      manga,
    };
  }

  /**
   * Check if cache needs cleanup (run periodically)
   */
  async maybeCleanup(): Promise<void> {
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
    
    if (Date.now() - this.metadata.lastCleanup > CLEANUP_INTERVAL) {
      await this.cleanup();
    }
  }
}

// Singleton instance for background script
export const imageCache = new ImageCacheManager();

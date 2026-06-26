/**
 * Bridge - Communication bridge between page script and content script
 *
 * Since the viewer runs in page context (not extension context),
 * it cannot directly access chrome.* APIs. This bridge sends messages
 * to the content script which relays them to the background.
 *
 * Uses window.postMessage() which works across page/content script boundary.
 */

import type { MangaDetails, EvictionUnit, EvictionPriority } from '@/types';

let messageId = 0;
const pendingMessages = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();

// Listen for responses from content script
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent) => {
    // Only accept messages from same window
    if (event.source !== window) return;
    
    // Check if it's our response message
    if (event.data?.type !== 'COMICK_REVIVE_BRIDGE_RESPONSE') return;
    
    const { id, success, result, error } = event.data;
    console.log('[Bridge] Received response:', id, success, typeof result === 'object' ? JSON.stringify(result).substring(0, 100) : result);
    const pending = pendingMessages.get(id);
    if (pending) {
      pendingMessages.delete(id);
      if (success) {
        pending.resolve(result);
      } else {
        pending.reject(new Error(error));
      }
    }
  });
}

/**
 * Send a single message attempt to the content script via the bridge
 */
function sendBridgeMessageOnce(type: string, payload: any, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    pendingMessages.set(id, { resolve, reject });
    
    setTimeout(() => {
      if (pendingMessages.has(id)) {
        pendingMessages.delete(id);
        reject(new Error(`Bridge message timeout: ${type}`));
      }
    }, timeoutMs);
    
    window.postMessage({
      type: 'COMICK_REVIVE_BRIDGE',
      id,
      action: type,
      payload
    }, '*');
  });
}

/**
 * Send a message to the content script via the bridge.
 * Retries once on failure to handle transient service worker restarts.
 */
async function sendBridgeMessage(type: string, payload: any): Promise<any> {
  try {
    return await sendBridgeMessageOnce(type, payload, 60000);
  } catch (firstError) {
    console.warn(`[Bridge] First attempt failed for ${type}, retrying...`, firstError);
    // Delay to let a restarting service worker re-initialize (MV3 SW can take 1-2s to wake)
    await new Promise(r => setTimeout(r, 1500));
    return await sendBridgeMessageOnce(type, payload, 60000);
  }
}

/**
 * Bridge Storage - replacement for chrome.storage that uses the bridge
 */
export const bridgeStorage = {
  async get<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const result = await sendBridgeMessage('STORAGE_GET', { key, defaultValue });
      return result ?? defaultValue;
    } catch (error) {
      console.error(`[Bridge Storage] Error getting ${key}:`, error);
      return defaultValue;
    }
  },
  
  async set<T>(key: string, value: T): Promise<void> {
    await sendBridgeMessage('STORAGE_SET', { key, value });
  },
  
  async remove(key: string): Promise<void> {
    await sendBridgeMessage('STORAGE_REMOVE', { key });
  },
  
  async getAll(): Promise<Record<string, any>> {
    return await sendBridgeMessage('STORAGE_GET_ALL', {});
  }
};

/**
 * Bridge Runtime - replacement for chrome.runtime.sendMessage
 */
export const bridgeRuntime = {
  async sendMessage(message: { type: string; payload?: any }): Promise<any> {
    return await sendBridgeMessage(message.type, message.payload);
  }
};

/**
 * Bridge Fetch - for making fetch requests through background script (CORS bypass)
 */
export async function bridgeFetch(url: string, options?: RequestInit): Promise<Response> {
  const result = await sendBridgeMessage('FETCH', { url, options });
  
  if (result.error) {
    throw new Error(result.error);
  }
  
  // Reconstruct a Response-like object
  return {
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    headers: new Headers(result.headers || {}),
    text: async () => result.body,
    json: async () => JSON.parse(result.body),
    blob: async () => new Blob([result.body]),
  } as Response;
}

/**
 * Bridge Image Fetch - proxy image through background script to add proper headers
 * Returns a data URL that can be used directly in img src
 */
export async function bridgeFetchImage(url: string): Promise<string> {
  const result = await sendBridgeMessage('FETCH_IMAGE', { url });
  
  if (result.error || !result.ok) {
    throw new Error(result.error || 'Failed to fetch image');
  }
  
  return result.dataUrl;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE CACHE BRIDGE
// ═══════════════════════════════════════════════════════════════════════════

export interface CacheKey {
  sourceId: string;
  mangaSlug: string;
  chapterSlug: string;
  pageIndex: number;
}

/**
 * Fetch image with cache support
 * Checks cache first, then fetches and caches if not found
 */
export async function bridgeFetchImageCached(
  url: string,
  cacheKey: CacheKey | null
): Promise<{ dataUrl: string; fromCache: boolean; evicted?: { count: number; freedMB: number; manga: string[]; details: Array<{ mangaSlug: string; chapters: Array<{ chapterSlug: string; pageCount: number; sizeMB: number }> }> } }> {
  const result = await sendBridgeMessage('FETCH_IMAGE_CACHED', { url, cacheKey });

  if (result.error || !result.ok) {
    throw new Error(result.error || 'Failed to fetch image');
  }

  return { dataUrl: result.dataUrl, fromCache: result.fromCache, evicted: result.evicted };
}

/**
 * Get image from cache only (no fetch if miss)
 */
export async function bridgeCacheGet(cacheKey: CacheKey): Promise<string | null> {
  const result = await sendBridgeMessage('CACHE_GET', cacheKey);
  
  if (result.error) {
    console.warn('[Bridge] Cache get error:', result.error);
    return null;
  }
  
  return result.hit ? result.dataUrl : null;
}

/**
 * Store image in cache
 */
export async function bridgeCacheSet(
  cacheKey: CacheKey,
  dataUrl: string,
  mimeType: string,
  originalUrl: string
): Promise<boolean> {
  const result = await sendBridgeMessage('CACHE_SET', {
    cacheKey,
    dataUrl,
    mimeType,
    originalUrl,
  });
  
  return result.success === true;
}

/**
 * Check if specific pages are in cache
 * Used to determine if chapter load will be fast (cached) or slow (network)
 *
 * @param sourceId - Source ID
 * @param mangaSlug - Manga slug
 * @param chapterSlug - Chapter slug
 * @param pageIndices - Array of page indices to check
 * @returns true if ALL specified pages exist in cache
 */
export async function bridgeArePagesInCache(
  sourceId: string,
  mangaSlug: string,
  chapterSlug: string,
  pageIndices: number[]
): Promise<boolean> {
  console.log('[Bridge] arePagesInCache called:', { sourceId, mangaSlug, chapterSlug, pageIndices });
  try {
    const result = await sendBridgeMessage('CHECK_PAGES_CACHED', {
      sourceId,
      mangaSlug,
      chapterSlug,
      pageIndices,
    });
    console.log('[Bridge] arePagesInCache result:', result);
    return result.allCached === true;
  } catch (error) {
    console.warn('[Bridge] arePagesInCache error:', error);
    return false;
  }
}

/**
 * Get the number of cached pages and stored total for a chapter from image cache.
 * Used by skipPageCache sources to serve cached images without fetching ephemeral page URLs.
 * Returns both the actual cached count and the expected total for partial-cache validation.
 */
export async function bridgeGetChapterPageCount(
  sourceId: string,
  mangaSlug: string,
  chapterSlug: string
): Promise<{ count: number; total: number }> {
  try {
    const result = await sendBridgeMessage('GET_CHAPTER_PAGE_COUNT', {
      sourceId,
      mangaSlug,
      chapterSlug,
    });
    return { count: result.count || 0, total: result.total || 0 };
  } catch (error) {
    console.warn('[Bridge] getChapterPageCount error:', error);
    return { count: 0, total: 0 };
  }
}

/**
 * Store the total page count for a chapter.
 * Called after a successful network fetch so partial-cache detection works on subsequent loads.
 */
export async function bridgeSetChapterPageTotal(
  sourceId: string,
  mangaSlug: string,
  chapterSlug: string,
  totalPages: number
): Promise<void> {
  try {
    await sendBridgeMessage('SET_CHAPTER_PAGE_TOTAL', {
      sourceId,
      mangaSlug,
      chapterSlug,
      totalPages,
    });
  } catch (error) {
    console.warn('[Bridge] setChapterPageTotal error:', error);
  }
}

/**
 * Get cache statistics
 */
export async function bridgeCacheStats(): Promise<{
  enabled: boolean;
  entryCount: number;
  totalSizeMB: number;
  maxSizeMB: number;
  ttlDays: number;
  lastCleanup: number;
}> {
  return await sendBridgeMessage('CACHE_STATS', {});
}

/**
 * Get detailed per-manga image cache statistics
 */
export async function bridgeCacheDetailedStats(): Promise<{
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
  return await sendBridgeMessage('CACHE_DETAILED_STATS', {});
}

/**
 * Clear all cached images
 */
export async function bridgeCacheClear(): Promise<boolean> {
  const result = await sendBridgeMessage('CACHE_CLEAR', {});
  return result.success === true;
}

/**
 * Clear cache for a specific manga
 */
export async function bridgeCacheClearManga(
  sourceId: string,
  mangaSlug: string
): Promise<number> {
  const result = await sendBridgeMessage('CACHE_CLEAR_MANGA', { sourceId, mangaSlug });
  return result.removed || 0;
}

/**
 * Clear cache for a specific chapter
 */
export async function bridgeCacheClearChapter(
  sourceId: string,
  mangaSlug: string,
  chapterSlug: string
): Promise<number> {
  const result = await sendBridgeMessage('CACHE_CLEAR_CHAPTER', { sourceId, mangaSlug, chapterSlug });
  return result.removed || 0;
}

/**
 * Set HTTP cache bypass mode in background.
 * When enabled, all fetch() calls use cache: 'reload' to skip the browser disk cache.
 * Used during chapter refetch to ensure fresh images from the network.
 */
export async function bridgeSetHttpCacheBypass(bypass: boolean): Promise<void> {
  await sendBridgeMessage('SET_HTTP_CACHE_BYPASS', { bypass });
}

/**
 * Update cache settings in background.
 * Returns eviction info if max size was reduced below current usage.
 */
export async function bridgeCacheUpdateSettings(settings: {
  enabled?: boolean;
  ttlDays?: number;
  maxSizeMB?: number;
  evictionUnit?: EvictionUnit;
  evictionPriority?: EvictionPriority;
}): Promise<{ success: boolean; evicted?: { count: number; freedMB: number; manga: string[]; details: Array<{ mangaSlug: string; chapters: Array<{ chapterSlug: string; pageCount: number; sizeMB: number }> }> } | null }> {
  return await sendBridgeMessage('CACHE_UPDATE_SETTINGS', settings);
}

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE DATA CACHE BRIDGE
// ═══════════════════════════════════════════════════════════════════════════

export interface ChapterInfo {
  slug: string;
  number: number | null;
  title: string | null;
  volume: string | null;
  pageCount?: number;
  publishedAt?: string;
}

export interface PageInfo {
  url: string;
  index: number;
  width?: number;
  height?: number;
}

/**
 * Get cached chapter list for a manga
 * Returns null if not cached or expired
 */
export async function bridgeGetCachedChapters(
  sourceId: string,
  mangaSlug: string
): Promise<ChapterInfo[] | null> {
  const result = await sendBridgeMessage('SOURCE_DATA_GET_CHAPTERS', {
    sourceId,
    mangaSlug,
  });
  
  if (result.error) {
    console.warn('[Bridge] Get chapters error:', result.error);
    return null;
  }
  
  return result.data || null;
}

/**
 * Store chapter list in cache
 */
export async function bridgeSetCachedChapters(
  sourceId: string,
  mangaSlug: string,
  chapters: ChapterInfo[]
): Promise<boolean> {
  const result = await sendBridgeMessage('SOURCE_DATA_SET_CHAPTERS', {
    sourceId,
    mangaSlug,
    chapters,
  });
  
  return result.success === true;
}

/**
 * Invalidate chapter list cache (force refresh on next fetch)
 */
export async function bridgeInvalidateChapters(
  sourceId: string,
  mangaSlug: string
): Promise<boolean> {
  const result = await sendBridgeMessage('SOURCE_DATA_INVALIDATE_CHAPTERS', {
    sourceId,
    mangaSlug,
  });
  
  return result.success === true;
}

/**
 * Get cached page URLs for a chapter
 * Returns null if not cached or expired
 */
export async function bridgeGetCachedPages(
  sourceId: string,
  mangaSlug: string,
  chapterSlug: string
): Promise<PageInfo[] | null> {
  const result = await sendBridgeMessage('SOURCE_DATA_GET_PAGES', {
    sourceId,
    mangaSlug,
    chapterSlug,
  });
  
  if (result.error) {
    console.warn('[Bridge] Get pages error:', result.error);
    return null;
  }
  
  return result.data || null;
}

/**
 * Store page URLs in cache
 */
export async function bridgeSetCachedPages(
  sourceId: string,
  mangaSlug: string,
  chapterSlug: string,
  pages: PageInfo[]
): Promise<boolean> {
  const result = await sendBridgeMessage('SOURCE_DATA_SET_PAGES', {
    sourceId,
    mangaSlug,
    chapterSlug,
    pages,
  });
  
  return result.success === true;
}

/**
 * Get cached manga details
 * Returns null if not cached or expired
 */
export async function bridgeGetCachedDetails(
  sourceId: string,
  mangaSlug: string
): Promise<MangaDetails | null> {
  const result = await sendBridgeMessage('SOURCE_DATA_GET_DETAILS', {
    sourceId,
    mangaSlug,
  });

  if (result.error) {
    console.warn('[Bridge] Get details error:', result.error);
    return null;
  }

  return result.data || null;
}

/**
 * Store manga details in cache
 */
export async function bridgeSetCachedDetails(
  sourceId: string,
  mangaSlug: string,
  details: MangaDetails
): Promise<boolean> {
  const result = await sendBridgeMessage('SOURCE_DATA_SET_DETAILS', {
    sourceId,
    mangaSlug,
    details,
  });

  return result.success === true;
}

/**
 * Clear all source data cache
 */
export async function bridgeSourceDataClearAll(): Promise<boolean> {
  const result = await sendBridgeMessage('SOURCE_DATA_CLEAR', {});
  return result.success === true;
}

/**
 * Clear source data for a specific manga
 */
export async function bridgeSourceDataClearManga(
  sourceId: string,
  mangaSlug: string
): Promise<boolean> {
  const result = await sendBridgeMessage('SOURCE_DATA_CLEAR_MANGA', {
    sourceId,
    mangaSlug,
  });
  
  return result.success === true;
}

/**
 * Clear chapter pages cache for a specific chapter (for reload)
 */
export async function bridgeSourceDataClearChapterPages(
  sourceId: string,
  mangaSlug: string,
  chapterSlug: string
): Promise<boolean> {
  const result = await sendBridgeMessage('SOURCE_DATA_CLEAR_CHAPTER_PAGES', {
    sourceId,
    mangaSlug,
    chapterSlug,
  });
  
  return result.success === true;
}

/**
 * Update dimensions for a specific page in cached chapter pages.
 * Used to persist image dimensions after first load for scroll preservation.
 */
export async function bridgeSourceDataUpdatePageDimensions(
  sourceId: string,
  mangaSlug: string,
  chapterSlug: string,
  pageIndex: number,
  url: string,
  width: number,
  height: number
): Promise<boolean> {
  const result = await sendBridgeMessage('SOURCE_DATA_UPDATE_PAGE_DIMENSIONS', {
    sourceId,
    mangaSlug,
    chapterSlug,
    pageIndex,
    url,
    width,
    height,
  });
  
  return result.success === true;
}

/**
 * Get source data cache statistics
 */
export async function bridgeSourceDataStats(): Promise<{
  chapterListCount: number;
  chapterPagesCount: number;
  totalEntries: number;
}> {
  return await sendBridgeMessage('SOURCE_DATA_STATS', {});
}

/**
 * Get detailed per-manga source data cache statistics
 */
export async function bridgeSourceDataDetailedStats(): Promise<{
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
  return await sendBridgeMessage('SOURCE_DATA_DETAILED_STATS', {});
}

console.log('[ComicK Revive] Bridge module loaded');

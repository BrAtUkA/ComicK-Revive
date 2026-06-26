/**
 * Image Loader - Handles loading images through background proxy with caching
 * 
 * Images from manga sources often require specific headers (like Referer)
 * to load. Since the viewer runs in page context, we proxy images through
 * the background script which can set proper headers.
 * 
 * Features:
 * - Persistent caching via IndexedDB (in background)
 * - In-memory cache for session
 * - Deduplication of concurrent requests
 */

import { bridgeFetchImage, bridgeFetchImageCached, bridgeCacheGet, bridgeCacheUpdateSettings, CacheKey } from './bridge';
import { formatBytes } from './format';
import { isSourceUrl } from './sourceDomains';
import { GlobalSettings } from '@/types';
import type { AsuraPageData } from '@/sources/AsuraScans';

// In-memory cache for proxied image URLs (original URL -> data URL)
const imageCache = new Map<string, string>();

// Pending requests to dedupe simultaneous loads
const pendingRequests = new Map<string, Promise<LoadedImage>>();

// Current cache context (set by viewer when opening a chapter)
let currentCacheContext: {
  sourceId: string;
  mangaSlug: string;
  chapterSlug: string;
  directImageLoad?: boolean;
} | null = null;

// Whether persistent caching is enabled
let persistentCacheEnabled = true;

// Eviction notification settings
let evictionNotificationsEnabled = true;
let onEvictionCallback: ((message: string, details: string) => void) | null = null;

/**
 * Resolver used to recover a real source URL when a cached:// blob read misses.
 * Set by the Viewer, which can re-fetch fresh page URLs from the source (bypassing
 * the "fully cached" fast path). Returns the real page URL, or null if unavailable.
 */
export type CachedUrlResolver = (
  sourceId: string,
  mangaSlug: string,
  chapterSlug: string,
  pageIndex: number,
) => Promise<string | null>;

let cachedUrlResolver: CachedUrlResolver | null = null;

/**
 * Register the resolver that repairs cached:// misses by fetching the real page URL.
 * Pass null to clear it (e.g. when the viewer closes).
 */
export function setCachedUrlResolver(resolver: CachedUrlResolver | null): void {
  cachedUrlResolver = resolver;
}

/**
 * Set the current cache context (call when loading a new chapter)
 */
export function setCacheContext(context: {
  sourceId: string;
  mangaSlug: string;
  chapterSlug: string;
  directImageLoad?: boolean;
} | null): void {
  currentCacheContext = context;
  console.log('[ImageLoader] Cache context set:', context);
}

/**
 * Set callback for eviction notifications (called from viewer setup)
 */
export function setEvictionCallback(callback: (message: string, details: string) => void): void {
  onEvictionCallback = callback;
}

/**
 * Disable eviction notifications (called from toast "don't show again")
 */
export function disableEvictionNotifications(): void {
  evictionNotificationsEnabled = false;
}

/**
 * Update cache settings from global settings
 */
export function updateCacheSettings(settings: GlobalSettings): void {
  persistentCacheEnabled = settings.enableImageCache;
  evictionNotificationsEnabled = settings.imageCacheEvictionNotifications;
  
  // Sync settings to background
  bridgeCacheUpdateSettings({
    enabled: settings.enableImageCache,
    ttlDays: settings.imageCacheTTLDays,
    maxSizeMB: settings.imageCacheMaxSizeMB,
    evictionUnit: settings.imageCacheEvictionUnit,
    evictionPriority: settings.imageCacheEvictionPriority,
  }).catch((err) => {
    console.warn('[ImageLoader] Failed to update cache settings:', err);
  });
  
  console.log('[ImageLoader] Persistent cache:', persistentCacheEnabled ? 'enabled' : 'disabled');
}

/**
 * Check if URL needs proxying based on domain
 */
export function needsProxy(url: string): boolean {
  return isSourceUrl(url);
}

/**
 * Build cache key for a page image
 */
function buildCacheKey(url: string, pageIndex?: number, contextOverride?: { sourceId: string; mangaSlug: string; chapterSlug: string }): CacheKey | null {
  const ctx = contextOverride || currentCacheContext;
  if (!ctx || pageIndex === undefined) {
    return null;
  }

  return {
    sourceId: ctx.sourceId,
    mangaSlug: ctx.mangaSlug,
    chapterSlug: ctx.chapterSlug,
    pageIndex,
  };
}

/**
 * Parse tile scramble data from a URL fragment (AsuraScans).
 * Returns the clean URL (without fragment) and tile data if present.
 */
function parseTileFragment(url: string): { cleanUrl: string; tileData: AsuraPageData | null } {
  const hashIdx = url.indexOf('#');
  if (hashIdx === -1) return { cleanUrl: url, tileData: null };

  const fragment = url.substring(hashIdx + 1);
  const cleanUrl = url.substring(0, hashIdx);

  try {
    const data = JSON.parse(fragment);
    if (data && Array.isArray(data.tiles) && data.tiles.length > 0) {
      return { cleanUrl, tileData: data as AsuraPageData };
    }
  } catch {
    // Not tile JSON — regular hash fragment
  }
  return { cleanUrl: url, tileData: null };
}

/**
 * Unscramble a tile-scrambled image using Canvas.
 * Each tile in the source image is mapped to its correct position in the output.
 */
function unscrambleTiles(imageUrl: string, tileData: AsuraPageData): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { tiles, tileCols, tileRows } = tileData;
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      const tileWidth = Math.ceil(width / tileCols);
      const tileHeight = Math.ceil(height / tileRows);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(imageUrl); // Fallback: return scrambled image
        return;
      }

      // tiles[w] = j means: source tile at position w goes to destination position j
      for (let w = 0; w < tiles.length; w++) {
        const j = tiles[w];
        const srcCol = w % tileCols;
        const srcRow = Math.floor(w / tileCols);
        const dstCol = j % tileCols;
        const dstRow = Math.floor(j / tileCols);

        ctx.drawImage(
          img,
          srcCol * tileWidth, srcRow * tileHeight, tileWidth, tileHeight,
          dstCol * tileWidth, dstRow * tileHeight, tileWidth, tileHeight
        );
      }

      resolve(canvas.toDataURL('image/webp', 1.0));
    };
    img.onerror = () => reject(new Error('Failed to load image for unscrambling'));
    img.src = imageUrl;
  });
}

/**
 * Result of loading an image, includes URL and dimensions
 */
export interface LoadedImage {
  url: string;
  width: number;
  height: number;
}

/**
 * Load an image, using cache and proxying through background if needed
 * Returns image URL along with its natural dimensions
 *
 * @param url - Image URL to load
 * @param pageIndex - Optional page index for cache key (enables persistent caching)
 * @param knownDimensions - If provided, skip redundant dimension detection (avoids extra Image decode)
 */
export async function loadImage(url: string, pageIndex?: number, knownDimensions?: { width: number; height: number }, cacheContextOverride?: { sourceId: string; mangaSlug: string; chapterSlug: string }): Promise<LoadedImage> {
  // Parse tile scramble data from URL fragment (AsuraScans)
  const { cleanUrl: fetchUrl, tileData } = parseTileFragment(url);

  // Helper to get image dimensions by loading it
  const getImageDimensions = (imageUrl: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('Failed to load image for dimensions'));
      img.src = imageUrl;
    });
  };

  // Resolve final dimensions for a ready-to-use image URL: reuse caller-known
  // dimensions when available, otherwise decode the image. Never throws.
  const finalize = async (resolvedUrl: string): Promise<LoadedImage> => {
    if (knownDimensions && knownDimensions.width > 0 && knownDimensions.height > 0) {
      return { url: resolvedUrl, width: knownDimensions.width, height: knownDimensions.height };
    }
    try {
      const dims = await getImageDimensions(resolvedUrl);
      return { url: resolvedUrl, width: dims.width, height: dims.height };
    } catch {
      return { url: resolvedUrl, width: 0, height: 0 };
    }
  };

  // Check in-memory cache first
  if (imageCache.has(url)) {
    return finalize(imageCache.get(url)!);
  }
  
  // If doesn't need proxy and persistent cache disabled, return original URL with dimensions.
  // (Use fetchUrl — clean URL without tile fragment — for proxy check and direct loading)
  if (!needsProxy(fetchUrl) && !persistentCacheEnabled) {
    // Still need to unscramble if tile data present
    let resultUrl = fetchUrl;
    if (tileData) {
      try { resultUrl = await unscrambleTiles(fetchUrl, tileData); } catch { /* use scrambled */ }
      imageCache.set(url, resultUrl);
    }
    return finalize(resultUrl);
  }

  // Check if there's already a pending request for this URL
  if (pendingRequests.has(url)) {
    return pendingRequests.get(url)!;
  }
  
  // Create new request
  const requestPromise = (async () => {
    try {
      // cached:// URLs are synthetic URLs from CachedSource's "fully cached" fast
      // path — the image blob is expected to be present in IndexedDB. Serve it from
      // there; on a miss, self-heal by resolving the real source URL and loading
      // that through the normal proxy/cache path (which re-caches the blob at the
      // missing key). Without this fallback a single failed blob read surfaces a
      // dead cached:// URL as the <img src>, breaking the page until manual reload.
      if (url.startsWith('cached://')) {
        const cacheKey = buildCacheKey(url, pageIndex, cacheContextOverride);
        if (!cacheKey) {
          throw new Error('cached:// URL requires cache context');
        }
        const dataUrl = await bridgeCacheGet(cacheKey);
        if (dataUrl) {
          imageCache.set(url, dataUrl);
          return finalize(dataUrl);
        }

        // Blob missing despite the fast path — recover from the source.
        console.warn(`[ImageLoader] Blob cache miss for page ${cacheKey.pageIndex} (${cacheKey.chapterSlug}); recovering from source`);
        const repaired = await repairCachedMiss(cacheKey, knownDimensions, cacheContextOverride);
        if (repaired) {
          imageCache.set(url, repaired.url);
          return repaired;
        }
        throw new Error(`Image cache miss for page ${pageIndex} and no source fallback available`);
      }

      const cacheKey = persistentCacheEnabled ? buildCacheKey(url, pageIndex, cacheContextOverride) : null;
      
      // Use clean URL (without tile fragment) for all network operations.
      // The fragment is client-side metadata for tile unscrambling, not sent over HTTP.
      let resultUrl: string;
      
      if (cacheKey && needsProxy(fetchUrl)) {
        console.log('[ImageLoader] Loading with cache:', fetchUrl.substring(0, 60) + '...', 'page:', pageIndex);
        const { dataUrl, fromCache, evicted } = await bridgeFetchImageCached(fetchUrl, cacheKey);

        if (fromCache) {
          console.log('[ImageLoader] Cache hit for page', pageIndex);
        }
        if (evicted) handleEvictionNotification(evicted);

        resultUrl = dataUrl;
      } else if (needsProxy(fetchUrl)) {
        // Needs proxy but no cache key
        console.log('[ImageLoader] Proxying image:', fetchUrl.substring(0, 60) + '...');
        const dataUrl = await bridgeFetchImage(fetchUrl);
        resultUrl = dataUrl;
      } else if (cacheKey) {
        // Doesn't need proxy but caching is enabled
        // For non-proxy URLs, we can cache them too for offline access
        console.log('[ImageLoader] Caching non-proxy image:', fetchUrl.substring(0, 60) + '...');
        const { dataUrl, fromCache, evicted } = await bridgeFetchImageCached(fetchUrl, cacheKey);

        if (fromCache) {
          console.log('[ImageLoader] Cache hit for page', pageIndex);
        }
        if (evicted) handleEvictionNotification(evicted);

        resultUrl = dataUrl;
      } else {
        // No proxy needed and no cache
        resultUrl = fetchUrl;
      }

      // Unscramble tile-scrambled images (AsuraScans)
      if (tileData) {
        try {
          resultUrl = await unscrambleTiles(resultUrl, tileData);
          console.log('[ImageLoader] Unscrambled tile image for page', pageIndex);
        } catch (err) {
          console.warn('[ImageLoader] Tile unscramble failed, using scrambled image:', err);
        }
      }

      // Cache the final (possibly unscrambled) result
      imageCache.set(url, resultUrl);
      
      // Get dimensions from the loaded image (skip if caller already knows)
      return finalize(resultUrl);
    } catch (error) {
      console.error('[ImageLoader] Failed to load image:', url, error);
      // Return original URL as fallback (might fail but worth trying)
      return { url, width: 0, height: 0 };
    } finally {
      pendingRequests.delete(url);
    }
  })();
  
  pendingRequests.set(url, requestPromise);
  return requestPromise;
}

/**
 * Recover a cached:// blob miss by resolving the real page URL from the source
 * (via the registered resolver) and loading it through the normal proxy/cache
 * path, which re-caches the blob at the missing key — self-healing the gap.
 * Returns null when no resolver is registered, the source can't supply the URL,
 * or the recovery load itself fails.
 */
async function repairCachedMiss(
  cacheKey: CacheKey,
  knownDimensions?: { width: number; height: number },
  cacheContextOverride?: { sourceId: string; mangaSlug: string; chapterSlug: string },
): Promise<LoadedImage | null> {
  if (!cachedUrlResolver) return null;

  let realUrl: string | null;
  try {
    realUrl = await cachedUrlResolver(
      cacheKey.sourceId,
      cacheKey.mangaSlug,
      cacheKey.chapterSlug,
      cacheKey.pageIndex,
    );
  } catch (err) {
    console.warn('[ImageLoader] cached:// fallback resolver threw:', err);
    return null;
  }

  // Guard against a resolver returning another cached:// URL (would recurse forever).
  if (!realUrl || realUrl.startsWith('cached://')) return null;

  // Load the real URL through the normal path so it gets proxied, unscrambled, and
  // re-cached under the SAME key that was missing (via the forwarded context).
  const recovered = await loadImage(realUrl, cacheKey.pageIndex, knownDimensions, cacheContextOverride || {
    sourceId: cacheKey.sourceId,
    mangaSlug: cacheKey.mangaSlug,
    chapterSlug: cacheKey.chapterSlug,
  });

  // loadImage returns its input URL unchanged on hard failure. A cached:// image
  // always needs proxying, so a successful recovery yields a transformed data: URL —
  // an unchanged URL therefore means the recovery failed; report that, don't surface it.
  if (recovered.url === realUrl) {
    console.warn(`[ImageLoader] Source recovery for page ${cacheKey.pageIndex} failed to load`);
    return null;
  }
  return recovered;
}

/**
 * Preload multiple images
 */
export async function preloadImages(urls: string[], startIndex: number = 0): Promise<void> {
  await Promise.all(urls.map((url, i) => loadImage(url, startIndex + i)));
}

/**
 * Clear the in-memory image cache
 */
export function clearImageCache(): void {
  imageCache.clear();
}

/**
 * Get in-memory cache size
 */
export function getImageCacheSize(): number {
  return imageCache.size;
}

// Eviction detail type matching what comes from the background
interface EvictionDetailItem {
  mangaSlug: string;
  chapters: Array<{ chapterSlug: string; pageCount: number; sizeMB: number }>;
}

// Debounce eviction notifications to avoid spamming toasts during rapid image loading
let evictionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingEvictionCount = 0;
let pendingEvictionFreedMB = 0;
let pendingEvictionDetails: EvictionDetailItem[] = [];

function handleEvictionNotification(evicted: { count: number; freedMB: number; manga: string[]; details?: EvictionDetailItem[] }): void {
  if (!evictionNotificationsEnabled || !onEvictionCallback) return;

  pendingEvictionCount += evicted.count;
  pendingEvictionFreedMB += evicted.freedMB;
  if (evicted.details) {
    pendingEvictionDetails.push(...evicted.details);
  }

  if (evictionDebounceTimer) clearTimeout(evictionDebounceTimer);
  evictionDebounceTimer = setTimeout(() => {
    const msg = `Cache full — freed ${formatBytes(pendingEvictionFreedMB * 1024 * 1024)} (${pendingEvictionCount} items removed)`;
    const details = formatEvictionDetails(pendingEvictionDetails, pendingEvictionCount);
    onEvictionCallback?.(msg, details);
    pendingEvictionCount = 0;
    pendingEvictionFreedMB = 0;
    pendingEvictionDetails = [];
    evictionDebounceTimer = null;
  }, 2000);
}

function formatEvictionDetails(details: EvictionDetailItem[], totalCount: number): string {
  if (details.length === 0) {
    return `${totalCount} cached images removed`;
  }

  // Merge details that may have come from multiple debounced calls
  const merged = new Map<string, Map<string, { pageCount: number; sizeMB: number }>>();
  for (const d of details) {
    if (!merged.has(d.mangaSlug)) merged.set(d.mangaSlug, new Map());
    const chapters = merged.get(d.mangaSlug)!;
    for (const ch of d.chapters) {
      const existing = chapters.get(ch.chapterSlug);
      if (existing) {
        existing.pageCount += ch.pageCount;
        existing.sizeMB += ch.sizeMB;
      } else {
        chapters.set(ch.chapterSlug, { pageCount: ch.pageCount, sizeMB: ch.sizeMB });
      }
    }
  }

  const lines: string[] = [];
  for (const [mangaSlug, chapters] of merged) {
    const name = mangaSlug.replace(/-/g, ' ');
    const chapterList = [...chapters.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    lines.push(name);
    for (const [chSlug, info] of chapterList) {
      const chName = chSlug.replace(/-/g, ' ');
      lines.push(`  ${chName} · ${info.pageCount} pages · ${formatBytes(info.sizeMB * 1024 * 1024)}`);
    }
  }
  return lines.join('\n');
}

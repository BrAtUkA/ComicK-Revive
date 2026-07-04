/**
 * ComicK Revive - Background Service Worker
 * 
 * Handles API requests to external sources (bypasses CORS).
 * Acts as a proxy between content scripts and manga sources.
 * Manages persistent image cache using IndexedDB.
 * Manages source data cache (chapters, pages, slugs) using IndexedDB.
 */

// Use relative import to avoid bundler pulling in window-dependent modules
import { imageCache } from '../core/ImageCache';
import type { CacheKey, EvictionDetail } from '../core/ImageCache';
import { sourceDataCache } from '../core/SourceDataCache';
import { getConfigForUrl } from '../utils/sourceDomains';
import { refererRuleId, buildRefererRule } from '../shared/refererRules';

/**
 * Union newly discovered hostnames into the source's persistent Referer
 * rule. Dynamic rules survive service worker restarts, so this only ever
 * grows the rule; removing the source deletes the rule by id. A session
 * cache of covered hosts keeps the per-image-fetch cost at zero once warm.
 */
const refererRuleHosts = new Map<number, Set<string>>();

async function ensureRefererRules(sourceId: string, referer: string, hosts: string[]): Promise<void> {
  if (!sourceId || !referer || !Array.isArray(hosts) || hosts.length === 0) return;

  const id = refererRuleId(sourceId);
  const cached = refererRuleHosts.get(id);
  const wanted = hosts.filter((h) => typeof h === 'string' && h && !h.includes('*'));
  if (wanted.length === 0 || (cached && wanted.every((h) => cached.has(h)))) return;

  const existing = (await chrome.declarativeNetRequest.getDynamicRules()).find((r) => r.id === id);
  const domains = new Set(existing?.condition.requestDomains ?? []);
  const before = domains.size;
  for (const host of wanted) domains.add(host);
  refererRuleHosts.set(id, domains);
  if (existing && domains.size === before) return;

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [id],
    addRules: [buildRefererRule(id, referer, [...domains])],
  });
  console.log(`[Background] Referer rule for ${sourceId} now covers:`, [...domains].join(', '));
}

/**
 * Memoized referer lookup for user sources ('user_source_{id}' keys — same
 * prefix as STORAGE_KEYS.USER_SOURCE_PREFIX; kept literal here to keep the
 * background's import graph minimal). Lets image fetches for already-cached
 * page URLs extend the referer rule even though the source's own
 * getChapterPages never ran this session.
 */
const userSourceRefererCache = new Map<string, string | null>();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of Object.keys(changes)) {
    if (key.startsWith('user_source_')) {
      userSourceRefererCache.delete(key.slice('user_source_'.length));
    }
  }
});

async function getUserSourceReferer(sourceId: string): Promise<string | null> {
  const cached = userSourceRefererCache.get(sourceId);
  if (cached !== undefined) return cached;
  const key = `user_source_${sourceId}`;
  const referer = await new Promise<string | null>((resolve) => {
    chrome.storage.local.get(key, (data) => {
      resolve((data[key] as { referer?: string } | undefined)?.referer ?? null);
    });
  });
  userSourceRefererCache.set(sourceId, referer);
  return referer;
}

// Initialize caches and run cleanup on startup
Promise.all([
  imageCache.init(),
  sourceDataCache.init(),
]).then(() => {
  imageCache.maybeCleanup();
  console.log('[Background] All caches initialized');
});

// Ask Chrome to keep our IndexedDB caches durable so cached chapters aren't silently
// evicted under storage pressure. With the unlimitedStorage permission this is normally
// granted; request it explicitly and log the outcome for diagnostics.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage.persisted()
    .then((already) => already ? true : navigator.storage.persist())
    .then((granted) => console.log('[Background] Persistent storage:', granted ? 'granted' : 'denied'))
    .catch((err) => console.warn('[Background] Persistent storage request failed:', err));
}

// When true, all fetch() calls use cache: 'reload' to bypass browser HTTP disk cache.
// Toggled by the viewer during chapter refetch.
let httpCacheBypass = false;

// Toolbar icon opens the popup (action.default_popup in the manifest);
// the popup handles opening/focusing the dashboard tab itself.

// Message handler
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('[Background] Received message:', message.type, message);
  
  if (message.type === 'FETCH') {
    // Support both direct format (url, options) and payload format (payload.url, payload.options)
    const url = message.url || message.payload?.url;
    const options = message.options || message.payload?.options || {};
    
    handleFetch(url, options)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true; // Keep message channel open for async response
  }

  // Proxy image through background script (returns blob URL or data URL)
  if (message.type === 'FETCH_IMAGE') {
    const url = message.url || message.payload?.url;
    console.log('[Background] FETCH_IMAGE url:', url);
    handleImageFetch(url)
      .then((result) => {
        console.log('[Background] FETCH_IMAGE result:', result.ok, result.dataUrl?.substring(0, 50));
        sendResponse(result);
      })
      .catch((error) => {
        console.error('[Background] FETCH_IMAGE error:', error);
        sendResponse({ error: error.message });
      });
    return true;
  }

  if (message.type === 'SEARCH_SOURCE') {
    handleSourceSearch(message.sourceId, message.query, message.page)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Clear all storage (for debugging)
  if (message.type === 'CLEAR_STORAGE') {
    chrome.storage.local.clear(() => {
      console.log('[ComicK Revive] Storage cleared');
      sendResponse({ success: true });
    });
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IMAGE CACHE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // Get image from cache
  if (message.type === 'CACHE_GET') {
    const cacheKey = message.payload as CacheKey;
    handleCacheGet(cacheKey)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Store image in cache
  if (message.type === 'CACHE_SET') {
    const { cacheKey, dataUrl, mimeType, originalUrl } = message.payload;
    handleCacheSet(cacheKey, dataUrl, mimeType, originalUrl)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Get cache statistics
  if (message.type === 'CACHE_STATS') {
    imageCache.getStats()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Get detailed per-manga cache statistics
  if (message.type === 'CACHE_DETAILED_STATS') {
    imageCache.getDetailedStats()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Clear all cache
  if (message.type === 'CACHE_CLEAR') {
    imageCache.clearAll()
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Clear cache for a specific manga
  if (message.type === 'CACHE_CLEAR_MANGA') {
    const { sourceId, mangaSlug } = message.payload;
    imageCache.clearManga(sourceId, mangaSlug)
      .then((removed) => sendResponse({ success: true, removed }))
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Clear cache for a specific chapter
  if (message.type === 'CACHE_CLEAR_CHAPTER') {
    const { sourceId, mangaSlug, chapterSlug } = message.payload;
    imageCache.clearChapter(sourceId, mangaSlug, chapterSlug)
      .then((removed) => sendResponse({ success: true, removed }))
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Update cache settings
  if (message.type === 'CACHE_UPDATE_SETTINGS') {
    const settings = message.payload;

    // Update both caches (imageCache may trigger eviction if max reduced)
    imageCache.updateSettings(settings)
      .then(async (result) => {
        sourceDataCache.updateSettings(settings);

        // If cache is being disabled, clear all cached data
        if (settings.enabled === false) {
          await Promise.all([
            imageCache.clearAll(),
            sourceDataCache.clearAll(),
          ]);
          console.log('[Background] All caches cleared (cache disabled)');
        }

        sendResponse({ success: true, evicted: result.evicted || null });
      })
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Merge runtime-discovered image/CDN hostnames into a user source's
  // Referer rule. Rotating CDNs (e.g. MangaPill's) can't be enumerated at
  // install time; DeclarativeSource reports the hosts it actually sees.
  if (message.type === 'ENSURE_REFERER_RULES') {
    const { sourceId, referer, hosts } = message.payload ?? {};
    ensureRefererRules(sourceId, referer, hosts)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Toggle HTTP cache bypass (used during chapter refetch)
  if (message.type === 'SET_HTTP_CACHE_BYPASS') {
    httpCacheBypass = message.payload?.bypass === true;
    console.log('[Background] HTTP cache bypass:', httpCacheBypass);
    sendResponse({ success: true });
    return true;
  }

  // Fetch image with caching support
  if (message.type === 'FETCH_IMAGE_CACHED') {
    const { url, cacheKey } = message.payload;
    handleCachedImageFetch(url, cacheKey)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Check if specific pages are in cache (for smart spinner delay)
  if (message.type === 'CHECK_PAGES_CACHED') {
    const { sourceId, mangaSlug, chapterSlug, pageIndices } = message.payload;
    imageCache.arePagesInCache(sourceId, mangaSlug, chapterSlug, pageIndices)
      .then((allCached) => sendResponse({ allCached }))
      .catch((error) => {
        sendResponse({ error: error.message, allCached: false });
      });
    return true;
  }

  // Get cached page count + stored total for a chapter (for skipPageCache sources)
  if (message.type === 'GET_CHAPTER_PAGE_COUNT') {
    const { sourceId, mangaSlug, chapterSlug } = message.payload;
    Promise.all([
      imageCache.getChapterPageCount(sourceId, mangaSlug, chapterSlug),
      imageCache.getChapterPageTotal(sourceId, mangaSlug, chapterSlug),
    ])
      .then(([count, total]) => sendResponse({ count, total }))
      .catch((error) => {
        sendResponse({ error: error.message, count: 0, total: 0 });
      });
    return true;
  }

  // Store total page count for a chapter (for partial-cache validation)
  if (message.type === 'SET_CHAPTER_PAGE_TOTAL') {
    const { sourceId, mangaSlug, chapterSlug, totalPages } = message.payload;
    imageCache.setChapterPageTotal(sourceId, mangaSlug, chapterSlug, totalPages)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // =====================================================
  // SOURCE DATA CACHE HANDLERS
  // =====================================================

  // Get cached chapter list
  if (message.type === 'SOURCE_DATA_GET_CHAPTERS') {
    const { sourceId, mangaSlug } = message.payload;
    sourceDataCache.getChapterList(sourceId, mangaSlug)
      .then((data) => sendResponse({ data }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Set chapter list in cache
  if (message.type === 'SOURCE_DATA_SET_CHAPTERS') {
    const { sourceId, mangaSlug, chapters } = message.payload;
    sourceDataCache.setChapterList(sourceId, mangaSlug, chapters)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Invalidate chapter list (force refresh)
  if (message.type === 'SOURCE_DATA_INVALIDATE_CHAPTERS') {
    const { sourceId, mangaSlug } = message.payload;
    sourceDataCache.invalidateChapterList(sourceId, mangaSlug)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Get cached chapter pages
  if (message.type === 'SOURCE_DATA_GET_PAGES') {
    const { sourceId, mangaSlug, chapterSlug } = message.payload;
    sourceDataCache.getChapterPages(sourceId, mangaSlug, chapterSlug)
      .then((data) => sendResponse({ data }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Set chapter pages in cache
  if (message.type === 'SOURCE_DATA_SET_PAGES') {
    const { sourceId, mangaSlug, chapterSlug, pages } = message.payload;
    sourceDataCache.setChapterPages(sourceId, mangaSlug, chapterSlug, pages)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Get cached manga details
  if (message.type === 'SOURCE_DATA_GET_DETAILS') {
    const { sourceId, mangaSlug } = message.payload;
    sourceDataCache.getMangaDetails(sourceId, mangaSlug)
      .then((data) => sendResponse({ data }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Set manga details in cache
  if (message.type === 'SOURCE_DATA_SET_DETAILS') {
    const { sourceId, mangaSlug, details } = message.payload;
    sourceDataCache.setMangaDetails(sourceId, mangaSlug, details)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Clear all source data cache
  if (message.type === 'SOURCE_DATA_CLEAR') {
    sourceDataCache.clearAll()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Clear source data for specific manga
  if (message.type === 'SOURCE_DATA_CLEAR_MANGA') {
    const { sourceId, mangaSlug } = message.payload;
    sourceDataCache.clearManga(sourceId, mangaSlug)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Clear chapter pages cache for a specific chapter (for reload)
  if (message.type === 'SOURCE_DATA_CLEAR_CHAPTER_PAGES') {
    const { sourceId, mangaSlug, chapterSlug } = message.payload;
    sourceDataCache.clearChapterPages(sourceId, mangaSlug, chapterSlug)
      .then((success) => sendResponse({ success }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Update page dimensions in cached chapter pages
  if (message.type === 'SOURCE_DATA_UPDATE_PAGE_DIMENSIONS') {
    const { sourceId, mangaSlug, chapterSlug, pageIndex, url, width, height } = message.payload;
    sourceDataCache.updatePageDimensions(sourceId, mangaSlug, chapterSlug, pageIndex, url, width, height)
      .then((success) => sendResponse({ success }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Get source data cache stats
  if (message.type === 'SOURCE_DATA_STATS') {
    sourceDataCache.getStats()
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // Get detailed per-manga source data cache stats
  if (message.type === 'SOURCE_DATA_DETAILED_STATS') {
    sourceDataCache.getDetailedStats()
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  return false;
});

/**
 * Build headers for image fetch requests.
 * Centralizes header construction so both handleImageFetch() and
 * fetchAndCacheImage() send identical headers.
 */
function buildImageFetchHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
  };

  const sourceConfig = getConfigForUrl(url);
  if (sourceConfig) {
    headers['Referer'] = sourceConfig.referer;
    headers['Origin'] = sourceConfig.referer.replace(/\/$/, '');
    headers['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  return headers;
}

/**
 * Handle image fetch request - proxies image through background script
 * Returns base64 data URL to bypass CORS/Referer issues
 */
async function handleImageFetch(url: string): Promise<{
  ok: boolean;
  dataUrl?: string;
  error?: string;
}> {
  try {
    const response = await fetch(url, {
      headers: buildImageFetchHeaders(url),
      credentials: 'omit',
      ...(httpCacheBypass ? { cache: 'reload' as RequestCache } : {}),
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    // Convert to base64 data URL
    const blob = await response.blob();
    const reader = new FileReader();

    return new Promise((resolve) => {
      reader.onloadend = () => {
        resolve({
          ok: true,
          dataUrl: reader.result as string,
        });
      };
      reader.onerror = () => {
        resolve({ ok: false, error: 'Failed to read image' });
      };
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Handle fetch request
 */
async function handleFetch(
  url: string,
  options: RequestInit = {}
): Promise<{
  ok: boolean;
  status: number;
  url: string;
  body: string;
  headers?: Record<string, string>;
  error?: string;
}> {
  try {
    // Build headers based on URL - some sites require specific headers
    const headers: Record<string, string> = {};

    // Copy existing headers if any
    if (options.headers) {
      if (options.headers instanceof Headers) {
        options.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(options.headers)) {
        options.headers.forEach(([key, value]) => {
          headers[key] = value;
        });
      } else {
        Object.assign(headers, options.headers);
      }
    }

    // Add required headers for known source domains
    const sourceConfig = getConfigForUrl(url);
    if (sourceConfig) {
      headers['Referer'] = sourceConfig.referer;
      headers['Origin'] = sourceConfig.referer.replace(/\/$/, '');
      headers['Accept'] = headers['Accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
      headers['User-Agent'] = headers['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'omit', // Don't send cookies
      ...(httpCacheBypass ? { cache: 'reload' as RequestCache } : {}),
    });

    const body = await response.text();

    // Serialize response headers as plain object for message passing
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      body,
      headers: responseHeaders,
    };
  } catch (error) {
    console.error('[Background] Fetch error for', url, ':', (error as Error).message);
    return {
      ok: false,
      status: 0,
      url,
      body: '',
      error: (error as Error).message,
    };
  }
}

/**
 * Handle source search request (legacy handler for SEARCH_SOURCE message)
 * Now uses the AsuraScans JSON API at api.asurascans.com
 */
async function handleSourceSearch(
  sourceId: string,
  query: string,
  page: number = 1
): Promise<{ results?: unknown[]; error?: string }> {
  switch (sourceId) {
    case 'asura': {
      const offset = (page - 1) * 20;
      const url = `https://api.asurascans.com/api/series?offset=${offset}&limit=20&search=${encodeURIComponent(query)}`;
      const headers: HeadersInit = {
        'Referer': 'https://asurascans.com/',
        'Accept': 'application/json',
      };

      try {
        const response = await fetch(url, { headers, credentials: 'omit' });
        if (!response.ok) return { error: `HTTP ${response.status}` };

        const data = await response.json() as {
          data?: Array<{ slug: string; title: string; cover: string; public_url: string }>;
        };
        const mangas = data.data || [];

        const results = mangas.map(m => ({
          slug: m.slug,
          title: m.title,
          thumbnailUrl: m.cover || '',
          url: `https://asurascans.com/series/${m.slug}`,
        }));

        return { results };
      } catch (error) {
        return { error: (error as Error).message };
      }
    }
    default:
      return { error: `Unknown source: ${sourceId}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE CACHE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get image from cache - returns data URL if found
 */
async function handleCacheGet(cacheKey: CacheKey): Promise<{
  hit: boolean;
  dataUrl?: string;
  error?: string;
}> {
  try {
    const result = await imageCache.get(cacheKey);
    
    if (!result) {
      return { hit: false };
    }

    // Convert blob to data URL
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve({
          hit: true,
          dataUrl: reader.result as string,
        });
      };
      reader.onerror = () => {
        resolve({ hit: false, error: 'Failed to read cached blob' });
      };
      reader.readAsDataURL(result.blob);
    });
  } catch (error) {
    return { hit: false, error: (error as Error).message };
  }
}

/**
 * Store image in cache from data URL
 */
async function handleCacheSet(
  cacheKey: CacheKey,
  dataUrl: string,
  mimeType: string,
  originalUrl: string
): Promise<{ success: boolean; evicted?: { count: number; freedMB: number; manga: string[] }; error?: string }> {
  try {
    // Convert data URL to blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    const result = await imageCache.set(cacheKey, blob, mimeType, originalUrl);
    const evicted = result.evicted && result.evicted.evictedCount > 0
      ? { count: result.evicted.evictedCount, freedMB: Math.round(result.evicted.freedBytes / 1024 / 1024 * 10) / 10, manga: result.evicted.evictedManga }
      : undefined;
    return { success: result.success, evicted };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Fetch image with cache support - checks cache first, then fetches and caches
 */
async function handleCachedImageFetch(
  url: string,
  cacheKey: CacheKey | null
): Promise<{
  ok: boolean;
  dataUrl?: string;
  fromCache?: boolean;
  error?: string;
}> {
  // Try cache first if key provided
  if (cacheKey) {
    try {
      const cached = await imageCache.get(cacheKey);
      if (cached) {
        // Convert blob to data URL
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            resolve({
              ok: true,
              dataUrl: reader.result as string,
              fromCache: true,
            });
          };
          reader.onerror = () => {
            // Cache read failed, fetch normally
            fetchAndCacheImage(url, cacheKey).then(resolve);
          };
          reader.readAsDataURL(cached.blob);
        });
      }
    } catch (error) {
      console.warn('[ImageCache] Cache read error:', error);
    }
  }

  // Not in cache or no key, fetch and optionally cache
  return fetchAndCacheImage(url, cacheKey);
}

/**
 * Fetch image and store in cache
 */
async function fetchAndCacheImage(
  url: string,
  cacheKey: CacheKey | null,
): Promise<{
  ok: boolean;
  dataUrl?: string;
  fromCache: boolean;
  evicted?: { count: number; freedMB: number; manga: string[] };
  error?: string;
}> {
  const MAX_RETRIES = 2;

  // User-source images may live on CDN domains discovered only at runtime
  // (or served from cached page URLs whose source never ran this session):
  // make sure the source's Referer rule covers this host before fetching
  if (cacheKey?.sourceId) {
    try {
      const referer = await getUserSourceReferer(cacheKey.sourceId);
      if (referer) {
        await ensureRefererRules(cacheKey.sourceId, referer, [new URL(url).hostname]);
      }
    } catch { /* best effort; the fetch may still succeed */ }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: buildImageFetchHeaders(url),
        credentials: 'omit',
        ...(httpCacheBypass ? { cache: 'reload' as RequestCache } : {}),
      });

      if (response.status === 429) {
        // Rate limited — back off and retry
        const delay = Math.min(2000 * Math.pow(2, attempt), 10000);
        console.warn(`[ImageFetch] 429 rate-limited, retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms: ${url.substring(0, 60)}...`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return { ok: false, fromCache: false, error: `HTTP 429` };
      }

      if (!response.ok) {
        console.warn(`[ImageFetch] FAIL ${response.status} for ${url.substring(0, 80)}...`);
        return { ok: false, fromCache: false, error: `HTTP ${response.status}` };
      }

      const blob = await response.blob();
      const mimeType = blob.type || 'image/jpeg';

    // Store in cache if key provided (await to get eviction info)
    let evicted: { count: number; freedMB: number; manga: string[]; details: EvictionDetail[] } | undefined;
    if (cacheKey) {
      try {
        const result = await imageCache.set(cacheKey, blob, mimeType, url);
        if (result.evicted && result.evicted.evictedCount > 0) {
          evicted = {
            count: result.evicted.evictedCount,
            freedMB: Math.round(result.evicted.freedBytes / 1024 / 1024 * 10) / 10,
            manga: result.evicted.evictedManga,
            details: result.evicted.details,
          };
        }
      } catch (err) {
        console.warn('[ImageCache] Failed to cache image:', err);
      }
    }

    // Convert to data URL
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve({
          ok: true,
          dataUrl: reader.result as string,
          fromCache: false,
          evicted,
        });
      };
      reader.onerror = () => {
        resolve({ ok: false, fromCache: false, error: 'Failed to read image' });
      };
      reader.readAsDataURL(blob);
    });
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[ImageFetch] Error, retrying: ${(error as Error).message}`);
        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
        continue;
      }
      return {
        ok: false,
        fromCache: false,
        error: (error as Error).message,
      };
    }
  }
  // Should not reach here, but just in case
  return { ok: false, fromCache: false, error: 'Max retries exceeded' };
}

console.log('[ComicK Revive] Background service worker loaded');

// Log declarativeNetRequest rules status on startup
if (typeof chrome !== 'undefined' && chrome.declarativeNetRequest) {
  chrome.declarativeNetRequest.getEnabledRulesets().then(rulesets => {
    console.log('[DNR] Enabled rulesets:', rulesets);
  }).catch(err => {
    console.warn('[DNR] Failed to query rulesets:', err);
  });

  // Log matched DNR rules for MangaDex requests (debug)
  chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
    if (info.request.url.includes('mangadex')) {
      console.log('[DNR] Rule matched:', info.rule.ruleId, 'for', info.request.url.substring(0, 80));
    }
  });
}

// Debug: observe actual headers being sent to MangaDex CDN
// onBeforeSendHeaders fires BEFORE DNR, onSendHeaders fires AFTER DNR
if (typeof chrome !== 'undefined' && chrome.webRequest) {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      const origin = details.requestHeaders?.find(h => h.name.toLowerCase() === 'origin');
      const referer = details.requestHeaders?.find(h => h.name.toLowerCase() === 'referer');
      console.log(`[WebRequest:FINAL] ${details.url.substring(0, 80)} | Origin: ${origin?.value || 'NONE'} | Referer: ${referer?.value || 'NONE'}`);
    },
    { urls: ['https://*.mangadex.network/*', 'https://api.mangadex.org/*'] },
    ['requestHeaders']
  );
}

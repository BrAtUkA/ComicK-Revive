import { sourceRegistry } from '@/sources';
import { bridgeFetchImageCached } from '@/utils/bridge';

/**
 * Cover loading shared by the dashboard library and the popup.
 *
 * Details metadata comes through CachedSource.getMangaDetails (its built-in
 * cache-or-fetch). The image bytes are stored in the image cache under a
 * reserved __cover__ chapter key, so covers are instant and offline after
 * the first load and participate in normal cache eviction.
 */

/** Reserved pseudo-chapter key for cover images in the image cache */
export const COVER_CHAPTER_KEY = '__cover__';

// Throttle live source fetches so a large library doesn't hammer sources;
// MangaKatana in particular rate-limits bursts. Cache hits pass through
// quickly, the limit only matters on cold loads.
const MAX_LIVE_FETCHES = 3;
let liveFetchCount = 0;
const liveFetchQueue: Array<() => void> = [];

async function withFetchSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (liveFetchCount >= MAX_LIVE_FETCHES) {
    await new Promise<void>((release) => liveFetchQueue.push(release));
  }
  liveFetchCount++;
  try {
    return await fn();
  } finally {
    liveFetchCount--;
    liveFetchQueue.shift()?.();
  }
}

/**
 * Resolve a manga's cover to a data URL, or null when unavailable.
 * Never throws.
 */
export async function getCoverDataUrl(sourceId: string, sourceSlug: string): Promise<string | null> {
  try {
    const source = sourceRegistry.get(sourceId);
    if (!source) return null;

    const details = await withFetchSlot(() => source.getMangaDetails(sourceSlug));
    if (!details?.thumbnailUrl) return null;

    const { dataUrl } = await bridgeFetchImageCached(details.thumbnailUrl, {
      sourceId,
      mangaSlug: sourceSlug,
      chapterSlug: COVER_CHAPTER_KEY,
      pageIndex: 0,
    });
    return dataUrl || null;
  } catch {
    return null;
  }
}

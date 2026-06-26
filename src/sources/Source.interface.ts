import { SearchResult, MangaDetails, Chapter, PageInfo } from '@/types';

/**
 * MangaSource - Interface for manga source implementations
 * 
 * Each source (AsuraScans, MangaDex, etc.) implements this interface
 * to provide a consistent API for fetching manga data.
 */
export interface MangaSource {
  /** Unique identifier for the source */
  id: string;
  
  /** Display name */
  name: string;
  
  /** Base URL of the source website */
  baseUrl: string;
  
  /** Icon URL (optional) */
  iconUrl?: string;

  /** If true, CachedSource will not cache getChapterPages results (for sources with ephemeral page URLs) */
  skipPageCache?: boolean;

  /** If true, page images should be loaded directly via <img src> instead of proxying through the service worker.
   *  Use for sources where the CDN rejects requests with service-worker Sec-Fetch-* headers. */
  directImageLoad?: boolean;

  /**
   * Search for manga by title
   * @param query - Search query
   * @param page - Page number (1-indexed)
   */
  search(query: string, page?: number): Promise<SearchResult[]>;

  /**
   * Get detailed manga information
   * @param slug - Manga slug/identifier
   */
  getMangaDetails(slug: string): Promise<MangaDetails>;

  /**
   * Get list of chapters for a manga
   * @param slug - Manga slug/identifier
   */
  getChapterList(slug: string): Promise<Chapter[]>;

  /**
   * Get page images for a chapter
   * @param mangaSlug - Manga slug/identifier
   * @param chapterSlug - Chapter slug/identifier
   */
  getChapterPages(mangaSlug: string, chapterSlug: string): Promise<PageInfo[]>;

  /**
   * Quick check if a manga is available on this source
   * @param title - Manga title to check
   */
  checkAvailability(title: string): Promise<boolean>;
}

/**
 * SourceError - Custom error for source operations
 */
export class SourceError extends Error {
  constructor(
    message: string,
    public sourceId: string,
    public code: 'NETWORK' | 'PARSE' | 'NOT_FOUND' | 'RATE_LIMITED' | 'CANCELLED' | 'UNKNOWN'
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

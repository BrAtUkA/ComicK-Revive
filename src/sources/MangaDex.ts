import { MangaSource, SourceError } from './Source.interface';
import { SearchResult, MangaDetails, Chapter, PageInfo } from '@/types';
import { fetchWithCors } from '@/utils/fetchWithCors';

// ═══════════════════════════════════════════════════════════════════════════
// API RESPONSE TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface MdRelationship {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

interface MdEntity {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships: MdRelationship[];
}

interface MdPaginatedResponse {
  result: string;
  data: MdEntity[];
  limit: number;
  offset: number;
  total: number;
}

interface MdSingleResponse {
  result: string;
  data: MdEntity;
}

interface MdAtHome {
  baseUrl: string;
  chapter: {
    hash: string;
    data: string[];
    dataSaver: string[];
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const API_URL = 'https://api.mangadex.org';
const CDN_URL = 'https://uploads.mangadex.org';
const MANGA_LIMIT = 20;
const CHAPTER_LIMIT = 500;
const LANG = 'en';

/** Official publisher groups — chapters are external-only, filtered out */
const BLOCKED_GROUPS = [
  '5fed0576-8b94-4f9a-b6a7-08eecd69800d', // Azuki
  '06a9fecb-b608-4f19-b93c-7caab06b7f44', // Bilibili Comics
  '8d8ecf83-8d42-4f8c-add8-60963f9f28d9', // Comikey
  'caa63201-4a17-4b7f-95ff-ed884a2b7e60', // INKR
  '319c1b10-cbd0-4f55-a46e-c4ee17e65139', // MangaHot
  '4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb', // Manga Plus
];

/**
 * MangaDex - Source implementation for mangadex.org
 *
 * Uses the MangaDex REST API (JSON) instead of HTML scraping.
 * Images served via MD@Home CDN with rotating tokens (~5 min lifetime).
 *
 * Based on the Kotlin Tachiyomi reference implementation.
 */
export class MangaDex implements MangaSource {
  id = 'mangadex';
  name = 'MangaDex';
  baseUrl = API_URL;
  iconUrl = 'https://mangadex.org/img/brand/mangadex-logo.svg';

  /** MD@Home page URLs contain ephemeral CDN node addresses — skip caching the URL list */
  skipPageCache = true;

  private searchAbortController?: AbortController;
  private onSearchProgress?: (current: number, total: number, variant: string) => void;

  setSearchProgressCallback(callback: (current: number, total: number, variant: string) => void): void {
    this.onSearchProgress = callback;
  }

  clearSearchProgressCallback(): void {
    this.onSearchProgress = undefined;
  }

  abortSearch(): void {
    this.searchAbortController?.abort();
    this.searchAbortController = undefined;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH
  // ═══════════════════════════════════════════════════════════════════════════

  async search(query: string, page: number = 1): Promise<SearchResult[]> {
    this.abortSearch();
    this.searchAbortController = new AbortController();
    this.onSearchProgress?.(1, 1, query);

    if (this.searchAbortController.signal.aborted) {
      throw new SourceError('Search cancelled', this.id, 'CANCELLED');
    }

    return this.searchManga(query, page);
  }

  async searchExact(query: string, page: number = 1): Promise<SearchResult[]> {
    this.abortSearch();
    this.searchAbortController = new AbortController();
    this.onSearchProgress?.(1, 1, query);
    return this.searchManga(query, page);
  }

  private async searchManga(query: string, page: number): Promise<SearchResult[]> {
    const offset = (page - 1) * MANGA_LIMIT;
    const params = new URLSearchParams({
      title: query,
      limit: String(MANGA_LIMIT),
      offset: String(offset),
      'order[relevance]': 'desc',
      hasAvailableChapters: 'true',
    });

    // Include cover art in response
    params.append('includes[]', 'cover_art');

    // Content ratings
    params.append('contentRating[]', 'safe');
    params.append('contentRating[]', 'suggestive');

    // Only manga with English chapters
    params.append('availableTranslatedLanguage[]', LANG);

    const url = `${API_URL}/manga?${params.toString()}`;

    try {
      const response = await this.fetchJson(url);

      if (!response.ok) {
        throw new SourceError(
          `Search failed: ${response.status}`,
          this.id,
          response.status === 429 ? 'RATE_LIMITED' : 'NETWORK'
        );
      }

      const data: MdPaginatedResponse = await response.json();
      return this.parseMangaList(data);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(
        `Search failed: ${(error as Error).message}`,
        this.id,
        'NETWORK'
      );
    }
  }

  private parseMangaList(data: MdPaginatedResponse): SearchResult[] {
    return data.data.map(entity => {
      const title = this.resolveTitle(entity.attributes);
      const coverFileName = this.getCoverFileName(entity.relationships);
      const thumbnailUrl = coverFileName
        ? `${CDN_URL}/covers/${entity.id}/${coverFileName}.512.jpg`
        : '';

      return {
        slug: entity.id,
        title,
        thumbnailUrl,
        url: `https://mangadex.org/title/${entity.id}`,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MANGA DETAILS
  // ═══════════════════════════════════════════════════════════════════════════

  async getMangaDetails(slug: string): Promise<MangaDetails> {
    const params = new URLSearchParams();
    params.append('includes[]', 'cover_art');
    params.append('includes[]', 'author');
    params.append('includes[]', 'artist');

    const url = `${API_URL}/manga/${slug}?${params.toString()}`;

    try {
      const response = await this.fetchJson(url);

      if (!response.ok) {
        throw new SourceError(
          `Failed to fetch manga: ${response.status}`,
          this.id,
          response.status === 404 ? 'NOT_FOUND' : 'NETWORK'
        );
      }

      const data: MdSingleResponse = await response.json();
      return this.parseMangaDetails(data.data, slug);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(
        `Failed to fetch manga: ${(error as Error).message}`,
        this.id,
        'NETWORK'
      );
    }
  }

  private parseMangaDetails(entity: MdEntity, slug: string): MangaDetails {
    const attrs = entity.attributes;
    const title = this.resolveTitle(attrs);

    // Description
    const descMap = attrs.description as Record<string, string> | undefined;
    const description = descMap?.[LANG] ?? descMap?.en ?? Object.values(descMap ?? {})[0] ?? '';

    // Author & artist from relationships
    const author = entity.relationships
      .filter(r => r.type === 'author')
      .map(r => (r.attributes?.name as string) || '')
      .filter(Boolean)
      .join(', ');

    const artist = entity.relationships
      .filter(r => r.type === 'artist')
      .map(r => (r.attributes?.name as string) || '')
      .filter(Boolean)
      .join(', ');

    // Status
    const statusRaw = attrs.status as string | undefined;
    const status = this.parseStatus(statusRaw);

    // Genres from tags
    const tags = attrs.tags as Array<{ attributes: { name: Record<string, string> } }> | undefined;
    const genres = (tags ?? [])
      .map(tag => tag.attributes?.name?.[LANG] ?? tag.attributes?.name?.en ?? '')
      .filter(Boolean);

    // Cover
    const coverFileName = this.getCoverFileName(entity.relationships);
    const thumbnailUrl = coverFileName
      ? `${CDN_URL}/covers/${entity.id}/${coverFileName}.512.jpg`
      : '';

    return {
      slug,
      title,
      description,
      author,
      artist,
      status,
      genres,
      thumbnailUrl,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTERS
  // ═══════════════════════════════════════════════════════════════════════════

  async getChapterList(slug: string): Promise<Chapter[]> {
    try {
      const allChapters: MdEntity[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          limit: String(CHAPTER_LIMIT),
          offset: String(offset),
          'order[volume]': 'desc',
          'order[chapter]': 'desc',
          includeFuturePublishAt: '0',
          includeEmptyPages: '0',
          // Chapters whose files were pulled still have feed records; without
          // this they get listed and then fail at the at-home page request
          includeUnavailable: '0',
        });

        params.append('includes[]', 'scanlation_group');
        params.append('translatedLanguage[]', LANG);

        // All content ratings for chapter listing (don't miss chapters)
        params.append('contentRating[]', 'safe');
        params.append('contentRating[]', 'suggestive');
        params.append('contentRating[]', 'erotica');
        params.append('contentRating[]', 'pornographic');

        // Exclude blocked publisher groups
        for (const groupId of BLOCKED_GROUPS) {
          params.append('excludedGroups[]', groupId);
        }

        const url = `${API_URL}/manga/${slug}/feed?${params.toString()}`;
        const response = await this.fetchJson(url);

        if (!response.ok) {
          throw new SourceError(
            `Failed to fetch chapters: ${response.status}`,
            this.id,
            response.status === 404 ? 'NOT_FOUND' : 'NETWORK'
          );
        }

        const data: MdPaginatedResponse = await response.json();
        allChapters.push(...data.data);

        // Check if there are more pages
        hasMore = data.offset + data.limit < data.total;
        offset += CHAPTER_LIMIT;

        // Small delay between paginated requests to avoid rate limits
        if (hasMore) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      return this.parseChapterList(allChapters);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(
        `Failed to fetch chapters: ${(error as Error).message}`,
        this.id,
        'NETWORK'
      );
    }
  }

  private parseChapterList(entities: MdEntity[]): Chapter[] {
    const seen = new Set<number>();
    const chapters: Chapter[] = [];

    for (const entity of entities) {
      const attrs = entity.attributes;

      // Skip invalid chapters (external URL + 0 pages)
      const externalUrl = attrs.externalUrl as string | null;
      const pages = attrs.pages as number;
      if (externalUrl && pages === 0) continue;

      // Skip unavailable chapters (files removed, record remains); belt and
      // braces on top of includeUnavailable=0 for cached/edge responses
      if (attrs.isUnavailable === true) continue;

      // Parse chapter number
      const chapterStr = attrs.chapter as string | null;
      const chapterNum = chapterStr ? parseFloat(chapterStr) : 0;
      if (isNaN(chapterNum)) continue;

      // Deduplicate: keep first occurrence per chapter number (API sorts by priority)
      if (seen.has(chapterNum)) continue;
      seen.add(chapterNum);

      // Build title
      const chapterTitle = attrs.title as string | null;
      let title = `Chapter ${chapterNum}`;
      if (chapterTitle) {
        title += ` - ${chapterTitle}`;
      }

      // Scanlation group name
      const group = entity.relationships.find(r => r.type === 'scanlation_group');
      if (group?.attributes?.name) {
        title += ` [${group.attributes.name}]`;
      }

      // Parse publish date
      const publishAt = attrs.publishAt as string | undefined;
      const dateUpload = publishAt ? new Date(publishAt).getTime() : Date.now();

      chapters.push({
        slug: entity.id, // Chapter UUID — used by getChapterPages
        number: chapterNum,
        title,
        dateUpload,
        isPremium: false,
      });
    }

    // Sort descending by chapter number
    chapters.sort((a, b) => b.number - a.number);

    return chapters;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER PAGES
  // ═══════════════════════════════════════════════════════════════════════════

  async getChapterPages(_mangaSlug: string, chapterSlug: string): Promise<PageInfo[]> {
    // chapterSlug is the chapter UUID
    const url = `${API_URL}/at-home/server/${chapterSlug}`;

    try {
      const response = await this.fetchJson(url);

      if (!response.ok) {
        throw new SourceError(
          `Failed to fetch pages: ${response.status}`,
          this.id,
          response.status === 404 ? 'NOT_FOUND' : 'NETWORK'
        );
      }

      const data: MdAtHome = await response.json();
      const { baseUrl, chapter } = data;

      // Full quality page URLs
      return chapter.data.map(filename => ({
        url: `${baseUrl}/data/${chapter.hash}/${filename}`,
      }));
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(
        `Failed to fetch pages: ${(error as Error).message}`,
        this.id,
        'NETWORK'
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AVAILABILITY
  // ═══════════════════════════════════════════════════════════════════════════

  async checkAvailability(title: string): Promise<boolean> {
    try {
      const results = await this.search(title, 1);
      return results.length > 0;
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private getHeaders(): HeadersInit {
    return {
      'Accept': 'application/json',
      'Referer': 'https://mangadex.org/',
    };
  }

  private async fetchJson(url: string): Promise<Response> {
    const response = await fetchWithCors(url, this.getHeaders());

    // Retry once on 429 using Retry-After header
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers?.get?.('Retry-After') ?? '', 10);
      const delayMs = Math.min((isNaN(retryAfter) ? 2 : retryAfter) * 1000, 10000);
      console.warn(`[MangaDex] Rate limited, retrying after ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
      return fetchWithCors(url, this.getHeaders());
    }

    return response;
  }

  /**
   * Resolve manga title with language fallback chain.
   * Per MangaDexHelper.kt: lang title → first title → altTitles lang → altTitles first
   */
  private resolveTitle(attrs: Record<string, unknown>): string {
    const titleMap = attrs.title as Record<string, string> | undefined;
    if (titleMap) {
      if (titleMap[LANG]) return titleMap[LANG];
      if (titleMap.en) return titleMap.en;
      const first = Object.values(titleMap)[0];
      if (first) return first;
    }

    // Fallback to altTitles
    const altTitles = attrs.altTitles as Array<Record<string, string>> | undefined;
    if (altTitles) {
      for (const alt of altTitles) {
        if (alt[LANG]) return alt[LANG];
      }
      for (const alt of altTitles) {
        if (alt.en) return alt.en;
      }
      const firstAlt = altTitles[0];
      if (firstAlt) {
        const first = Object.values(firstAlt)[0];
        if (first) return first;
      }
    }

    return 'Unknown';
  }

  /**
   * Extract cover art filename from relationships
   */
  private getCoverFileName(relationships: MdRelationship[]): string | null {
    const cover = relationships.find(r => r.type === 'cover_art');
    return (cover?.attributes?.fileName as string) ?? null;
  }

  private parseStatus(status: string | undefined): string {
    switch (status) {
      case 'ongoing': return 'Ongoing';
      case 'completed': return 'Completed';
      case 'hiatus': return 'Hiatus';
      case 'cancelled': return 'Cancelled';
      default: return 'Unknown';
    }
  }
}

// Export singleton instance
export const mangaDex = new MangaDex();

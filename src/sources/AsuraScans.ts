import { MangaSource, SourceError } from './Source.interface';
import { SearchResult, MangaDetails, Chapter, PageInfo } from '@/types';
import { generateQueryVariants } from '@/utils';
import { fetchWithCors } from '@/utils/fetchWithCors';

// ═══════════════════════════════════════════════════════════════════════════
// DTO types matching the new AsuraScans API response structure
// Based on https://github.com/keiyoushi/extensions-source/tree/main/src/en/asurascans
// ═══════════════════════════════════════════════════════════════════════════

interface ApiDataDto<T> {
  data?: T;
  meta?: { has_more: boolean };
}

interface ApiMangaDto {
  public_url: string;
  slug: string;
  title: string;
  cover: string;
  author?: string;
  artist?: string;
  description?: string;
  genres?: { name: string }[];
  status?: string;
}

interface ApiMangaDetailsDto {
  series: ApiMangaDto;
}

interface ApiChapterDto {
  number: number;
  title?: string;
  created_at: string;
  is_locked: boolean;
  series_slug?: string;
}

interface ApiChapterListDto {
  chapters: ApiChapterDto[];
}

interface ApiPageDto {
  url: string;
  tiles?: number[];
  tile_cols?: number;
  tile_rows?: number;
}

interface ApiPageListDto {
  pages: ApiPageDto[];
}

export interface AsuraPageData {
  tiles: number[];
  tileCols: number;
  tileRows: number;
}

/**
 * AsuraScans - Source implementation for asurascans.com
 *
 * Uses the JSON API at api.asurascans.com/api for search and manga details,
 * and Astro-rendered HTML pages at asurascans.com/comics/ for chapters and pages.
 * Supports scrambled image tiles (encoded in URL fragment for viewer-side unscrambling).
 */
export class AsuraScans implements MangaSource {
  id = 'asura';
  name = 'AsuraScans';
  baseUrl = 'https://asurascans.com';
  private apiUrl = 'https://api.asurascans.com/api';
  iconUrl = 'https://asurascans.com/favicon.ico';

  private static PER_PAGE_LIMIT = 20;
  private static OLD_FORMAT_MANGA_REGEX = /^\/manga\/(\d+-)?([^/]+)\/?$/;

  // Slug mapping: base slug -> random public slug (for /comics/ URLs)
  private slugMap: Map<string, string> = new Map();

  // Callback for reporting search variant progress
  private onSearchProgress?: (current: number, total: number, variant: string) => void;

  // Abort controller for cancelling searches
  private searchAbortController?: AbortController;

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

  private getHeaders(): HeadersInit {
    return {
      'Referer': `${this.baseUrl}/`,
    };
  }

  // ═══════════════════════════════════════════════════
  // SEARCH (JSON API)
  // ═══════════════════════════════════════════════════

  async search(query: string, page: number = 1): Promise<SearchResult[]> {
    this.abortSearch();
    this.searchAbortController = new AbortController();
    const signal = this.searchAbortController.signal;

    const variants = generateQueryVariants(query);

    for (let i = 0; i < variants.length; i++) {
      if (signal.aborted) {
        throw new SourceError('Search cancelled', this.id, 'CANCELLED');
      }

      const variant = variants[i];
      this.onSearchProgress?.(i + 1, variants.length, variant);

      try {
        const results = await this.searchSingle(variant, page);
        if (results.length > 0) return results;
        if (i < variants.length - 1) await this.delay(150);
      } catch (error) {
        if (error instanceof SourceError && (error.code === 'RATE_LIMITED' || error.code === 'CANCELLED')) throw error;
        if (i === variants.length - 1) throw error;
      }
    }

    return [];
  }

  async searchExact(query: string, page: number = 1): Promise<SearchResult[]> {
    this.abortSearch();
    this.searchAbortController = new AbortController();
    this.onSearchProgress?.(1, 1, query);
    return this.searchSingle(query, page);
  }

  private async searchSingle(query: string, page: number = 1): Promise<SearchResult[]> {
    const offset = (page - 1) * AsuraScans.PER_PAGE_LIMIT;
    const url = new URL(`${this.apiUrl}/series`);
    url.searchParams.set('offset', offset.toString());
    url.searchParams.set('limit', AsuraScans.PER_PAGE_LIMIT.toString());
    if (query) url.searchParams.set('search', query);

    try {
      const response = await this.fetchJson(url.toString());

      if (!response.ok) {
        throw new SourceError(
          `Search failed: ${response.status}`,
          this.id,
          response.status === 429 ? 'RATE_LIMITED' : 'NETWORK'
        );
      }

      const data = await response.json() as ApiDataDto<ApiMangaDto[]>;
      const mangas = data.data || [];

      // Update slug map: base slug -> random public slug
      for (const manga of mangas) {
        const publicSlug = this.extractLastPathSegment(`${this.baseUrl}${manga.public_url}`);
        this.slugMap.set(manga.slug, publicSlug);
      }

      return mangas.map(manga => ({
        slug: manga.slug,
        title: manga.title,
        thumbnailUrl: manga.cover || '',
        url: `${this.baseUrl}/series/${manga.slug}`,
      }));
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(`Search failed: ${(error as Error).message}`, this.id, 'NETWORK');
    }
  }

  // ═══════════════════════════════════════════════════
  // MANGA DETAILS (JSON API)
  // ═══════════════════════════════════════════════════

  async getMangaDetails(slug: string): Promise<MangaDetails> {
    const resolvedSlug = this.resolveSlug(slug);
    const randomSlug = this.slugMap.get(resolvedSlug) || resolvedSlug;
    const url = `${this.apiUrl}/series/${randomSlug}`;

    try {
      const response = await this.fetchJson(url);

      if (!response.ok) {
        throw new SourceError(
          `Failed to fetch manga: ${response.status}`,
          this.id,
          response.status === 404 ? 'NOT_FOUND' : 'NETWORK'
        );
      }

      const json = await response.text();
      let mangaData: ApiMangaDetailsDto;

      try {
        // Try wrapped format first: { data: { series: ... } }
        const wrapped = JSON.parse(json) as ApiDataDto<ApiMangaDetailsDto>;
        mangaData = wrapped.data || (JSON.parse(json) as ApiMangaDetailsDto);
      } catch {
        mangaData = JSON.parse(json) as ApiMangaDetailsDto;
      }

      const manga = mangaData.series;

      // Update slug map
      const publicSlug = this.extractLastPathSegment(`${this.baseUrl}${manga.public_url}`);
      this.slugMap.set(manga.slug, publicSlug);

      // Strip HTML from description
      const description = manga.description
        ? this.stripHtml(manga.description)
        : '';

      return {
        slug: manga.slug,
        title: manga.title,
        description,
        author: manga.author || '',
        artist: manga.artist || '',
        status: this.parseStatus(manga.status || ''),
        genres: manga.genres?.map(g => g.name) || [],
        thumbnailUrl: manga.cover || '',
      };
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(`Failed to fetch manga: ${(error as Error).message}`, this.id, 'NETWORK');
    }
  }

  // ═══════════════════════════════════════════════════
  // CHAPTERS (Astro HTML extraction)
  // ═══════════════════════════════════════════════════

  async getChapterList(slug: string): Promise<Chapter[]> {
    const resolvedSlug = this.resolveSlug(slug);
    const randomSlug = await this.resolveRandomSlug(resolvedSlug);
    const url = `${this.baseUrl}/comics/${randomSlug}`;

    try {
      const response = await this.fetchHtml(url);

      if (!response.ok) {
        throw new SourceError(
          `Failed to fetch chapters: ${response.status}`,
          this.id,
          response.status === 404 ? 'NOT_FOUND' : 'NETWORK'
        );
      }

      const html = await response.text();
      const chaptersData = this.extractAstroProp<ApiChapterListDto>(html, 'chapters');

      return chaptersData.chapters
        .filter(ch => !ch.is_locked)
        .map(ch => {
          const numberStr = ch.number.toString().replace(/\.0$/, '');
          // Include series_slug in chapter slug so getChapterPages is self-contained
          // (no slugMap dependency). Format: "{seriesSlug}/chapter/{number}"
          const seriesSlug = ch.series_slug || randomSlug;
          return {
            slug: `${seriesSlug}/chapter/${numberStr}`,
            number: ch.number,
            title: `Chapter ${numberStr}${ch.title ? ` - ${ch.title}` : ''}`,
            dateUpload: ch.created_at ? new Date(ch.created_at).getTime() : 0,
            isPremium: false,
          };
        })
        .sort((a, b) => b.number - a.number);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(`Failed to fetch chapters: ${(error as Error).message}`, this.id, 'NETWORK');
    }
  }

  // ═══════════════════════════════════════════════════
  // PAGES (Astro HTML extraction + scrambled tiles)
  // ═══════════════════════════════════════════════════

  async getChapterPages(mangaSlug: string, chapterSlug: string): Promise<PageInfo[]> {
    // chapterSlug format: "{baseSlug}/chapter/{number}" (matches Kotlin's /series/{slug}/chapter/{num})
    // The baseSlug needs to be resolved to the random public slug for the actual URL.
    // For backwards compat, also handle legacy "chapter/{number}" format.
    let url: string;
    if (chapterSlug.includes('/chapter/')) {
      const parts = chapterSlug.split('/chapter/');
      const baseSlug = parts[0];
      const number = parts[1];
      const randomSlug = await this.resolveRandomSlug(baseSlug);
      url = `${this.baseUrl}/comics/${randomSlug}/chapter/${number}`;
    } else {
      // Legacy format: "chapter/{number}" — needs slug map
      const resolvedSlug = this.resolveSlug(mangaSlug);
      const randomSlug = await this.resolveRandomSlug(resolvedSlug);
      const number = chapterSlug.replace(/^chapter\//, '');
      url = `${this.baseUrl}/comics/${randomSlug}/chapter/${number}`;
    }

    console.log(`[AsuraScans] getChapterPages - mangaSlug: "${mangaSlug}", chapterSlug: "${chapterSlug}", url: "${url}"`);

    try {
      const response = await this.fetchHtml(url);

      if (!response.ok) {
        throw new SourceError(
          `Failed to fetch pages: ${response.status}`,
          this.id,
          response.status === 404 ? 'NOT_FOUND' : 'NETWORK'
        );
      }

      const html = await response.text();
      const pageList = this.extractAstroProp<ApiPageListDto>(html, 'pages');

      return pageList.pages.map((pageDto) => {
        let pageUrl = pageDto.url;

        // If page has scrambled tile data, encode it in the URL fragment.
        // The viewer-side image loader will detect this and unscramble using Canvas.
        if (pageDto.tiles && pageDto.tiles.length > 0) {
          const tileData: AsuraPageData = {
            tiles: pageDto.tiles,
            tileCols: pageDto.tile_cols ?? 4,
            tileRows: pageDto.tile_rows ?? 5,
          };
          // Append tile data as URL fragment (not sent to server)
          const sep = pageUrl.includes('#') ? '' : '#';
          pageUrl = `${pageUrl}${sep}${JSON.stringify(tileData)}`;
        }

        return { url: pageUrl };
      });
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(`Failed to fetch pages: ${(error as Error).message}`, this.id, 'NETWORK');
    }
  }

  async checkAvailability(title: string): Promise<boolean> {
    try {
      const results = await this.search(title, 1);
      return results.length > 0;
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════════════════
  // ASTRO PROP EXTRACTION
  // ═══════════════════════════════════════════════════

  /**
   * Extract data from Astro-rendered HTML pages.
   * Astro embeds component props in [props] attributes on elements.
   * The data uses a special wrapping format: 2-element arrays where
   * the first is a primitive tag and the second is the real value.
   */
  private extractAstroProp<T>(html: string, key: string): T {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Find element with props attribute containing the key
    const element = doc.querySelector(`[props*="${key}"]`);
    if (!element) {
      throw new SourceError(`Unable to find Astro prop "${key}" in page`, this.id, 'PARSE');
    }

    const propsStr = element.getAttribute('props');
    if (!propsStr) {
      throw new SourceError(`Empty props attribute for "${key}"`, this.id, 'PARSE');
    }

    const json = JSON.parse(propsStr);
    const unwrapped = this.unwrapAstro(json);

    return unwrapped as T;
  }

  /**
   * Unwrap Astro's data encoding.
   * Astro wraps values as [primitiveTag, actualValue]. This recursively
   * unwraps all such arrays to extract the real data.
   */
  private unwrapAstro(element: unknown): unknown {
    if (Array.isArray(element)) {
      // [primitive, value] is an Astro wrapper — unwrap the value
      if (element.length === 2 && this.isPrimitive(element[0])) {
        return this.unwrapAstro(element[1]);
      }
      return element.map(item => this.unwrapAstro(item));
    }

    if (element !== null && typeof element === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(element)) {
        result[key] = this.unwrapAstro(value);
      }
      return result;
    }

    return element;
  }

  private isPrimitive(value: unknown): boolean {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  }

  // ═══════════════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════════════

  private fetchJson(url: string): Promise<Response> {
    return fetchWithCors(url, {
      ...this.getHeaders(),
      'Accept': 'application/json',
    });
  }

  private fetchHtml(url: string): Promise<Response> {
    return fetchWithCors(url, {
      ...this.getHeaders(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Resolve base slug to the random public slug needed for /comics/ URLs.
   * If slugMap has it, return immediately. Otherwise, call the API to
   * get the public_url and populate the map.
   */
  private async resolveRandomSlug(baseSlug: string): Promise<string> {
    const cached = this.slugMap.get(baseSlug);
    if (cached) return cached;

    // Slug map empty for this manga — resolve via API
    try {
      const response = await this.fetchJson(`${this.apiUrl}/series/${baseSlug}`);
      if (response.ok) {
        const json = await response.text();
        let mangaData: ApiMangaDetailsDto;
        try {
          const wrapped = JSON.parse(json) as ApiDataDto<ApiMangaDetailsDto>;
          mangaData = wrapped.data || (JSON.parse(json) as ApiMangaDetailsDto);
        } catch {
          mangaData = JSON.parse(json) as ApiMangaDetailsDto;
        }
        const manga = mangaData.series;
        const publicSlug = this.extractLastPathSegment(`${this.baseUrl}${manga.public_url}`);
        this.slugMap.set(baseSlug, publicSlug);
        this.slugMap.set(manga.slug, publicSlug);
        return publicSlug;
      }
    } catch {
      // Fall through to base slug
    }
    return baseSlug;
  }

  /**
   * Resolve slug for API use. Handles old /manga/{id}-{slug} format
   * and extracts the base slug for lookup.
   */
  private resolveSlug(slug: string): string {
    const oldMatch = AsuraScans.OLD_FORMAT_MANGA_REGEX.exec(`/manga/${slug}`);
    if (oldMatch) return oldMatch[2];
    return slug.replace(/^\/series\//, '').replace(/\/$/, '');
  }

  private extractLastPathSegment(urlOrPath: string): string {
    try {
      const fullUrl = urlOrPath.startsWith('http')
        ? urlOrPath
        : `${this.baseUrl}${urlOrPath}`;
      return new URL(fullUrl).pathname.split('/').filter(Boolean).pop() || urlOrPath;
    } catch {
      return urlOrPath.split('/').filter(Boolean).pop() || urlOrPath;
    }
  }

  private parseStatus(status: string): string {
    const lower = status.toLowerCase();
    if (lower === 'ongoing') return 'Ongoing';
    if (lower === 'completed') return 'Completed';
    if (lower === 'hiatus') return 'Hiatus';
    if (lower === 'dropped') return 'Dropped';
    return 'Unknown';
  }

  private stripHtml(html: string): string {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      return doc.body?.textContent?.trim() || html;
    } catch {
      return html.replace(/<[^>]*>/g, '').trim();
    }
  }

  setSlugMapping(baseSlug: string, fullSlug: string): void {
    this.slugMap.set(baseSlug, fullSlug);
  }

  getSlugMapping(baseSlug: string): string | undefined {
    return this.slugMap.get(baseSlug);
  }
}

// Export singleton instance
export const asuraScans = new AsuraScans();

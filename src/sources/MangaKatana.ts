import { MangaSource, SourceError } from './Source.interface';
import { SearchResult, MangaDetails, Chapter, PageInfo } from '@/types';
import { fetchWithCors } from '@/utils/fetchWithCors';

/**
 * MangaKatana - Source implementation for mangakatana.com
 *
 * Based on the Kotlin reference implementation from Tachiyomi.
 *
 * Key quirks:
 * - Search redirects to the manga page when exactly one result matches
 * - Chapter page images are embedded in JavaScript arrays inside <script> tags, not <img> elements
 * - Dates use MMM-dd-yyyy format (e.g., "Jan-15-2024")
 */
export class MangaKatana implements MangaSource {
  id = 'mangakatana';
  name = 'MangaKatana';
  baseUrl = 'https://mangakatana.com';

  // Abort controller for cancelling searches
  private searchAbortController?: AbortController;

  // Callback for reporting search variant progress
  private onSearchProgress?: (current: number, total: number, variant: string) => void;

  /**
   * Set callback for search progress updates
   */
  setSearchProgressCallback(callback: (current: number, total: number, variant: string) => void): void {
    this.onSearchProgress = callback;
  }

  /**
   * Clear search progress callback
   */
  clearSearchProgressCallback(): void {
    this.onSearchProgress = undefined;
  }

  /**
   * Abort any ongoing search
   */
  abortSearch(): void {
    this.searchAbortController?.abort();
    this.searchAbortController = undefined;
  }

  /**
   * Get headers for requests
   */
  private getHeaders(): HeadersInit {
    return {
      'Referer': `${this.baseUrl}/`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Search for manga by title
   */
  async search(query: string, page: number = 1): Promise<SearchResult[]> {
    // Cancel any previous search
    this.abortSearch();

    this.searchAbortController = new AbortController();
    const signal = this.searchAbortController.signal;

    // Report progress (single query — MangaKatana doesn't need character variants)
    this.onSearchProgress?.(1, 1, query);

    if (signal.aborted) {
      throw new SourceError('Search cancelled', this.id, 'CANCELLED');
    }

    return this.searchSingle(query, page);
  }

  /**
   * Search for manga by exact title (no character variants)
   */
  async searchExact(query: string, page: number = 1): Promise<SearchResult[]> {
    this.abortSearch();
    this.searchAbortController = new AbortController();
    this.onSearchProgress?.(1, 1, query);
    return this.searchSingle(query, page);
  }

  /**
   * Single search request
   */
  private async searchSingle(query: string, page: number = 1): Promise<SearchResult[]> {
    const url = `${this.baseUrl}/page/${page}?search=${encodeURIComponent(query)}&search_by=book_name`;

    try {
      const response = await this.fetchHtml(url);

      // MangaKatana returns 404 when no results match — this is legitimate "not found"
      if (response.status === 404) {
        return [];
      }

      if (!response.ok) {
        throw new SourceError(
          `Search failed: ${response.status}`,
          this.id,
          response.status === 429 ? 'RATE_LIMITED' : 'NETWORK'
        );
      }

      const html = await response.text();
      const responseUrl = response.url || url;

      // MangaKatana's rate limiter returns 200 OK with an empty body.
      // Throw a retryable error so searchWithRetry can handle it.
      if (!html || html.trim().length === 0) {
        throw new SourceError(
          'Empty response (server rate limit)',
          this.id,
          'NETWORK'
        );
      }

      // MangaKatana redirects to the manga page when exactly one result matches.
      // Detect this by checking if the URL path is /manga/{slug} (not /manga/page/N)
      if (this.isRedirectToManga(responseUrl)) {
        return this.parseSingleMangaResult(html, responseUrl);
      }

      return this.parseSearchResults(html);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(
        `Search failed: ${(error as Error).message}`,
        this.id,
        'NETWORK'
      );
    }
  }

  /**
   * Check if a response URL is a redirect to a single manga page
   */
  private isRedirectToManga(responseUrl: string): boolean {
    try {
      const urlObj = new URL(responseUrl);
      const segments = urlObj.pathname.split('/').filter(Boolean);
      // /manga/{slug} = ['manga', '{slug}'] where slug != 'page'
      return segments.length >= 2 && segments[0] === 'manga' && segments[1] !== 'page';
    } catch {
      return false;
    }
  }

  /**
   * Parse a single manga result from a redirect page
   */
  private parseSingleMangaResult(html: string, responseUrl: string): SearchResult[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const title = doc.querySelector('h1.heading')?.textContent?.trim() || '';
    const thumbnailUrl = doc.querySelector('div.media div.cover img')?.getAttribute('src') || '';
    const slug = this.extractSlugFromUrl(responseUrl);

    if (!title || !slug) return [];

    return [{
      slug,
      title,
      thumbnailUrl: this.absoluteUrl(thumbnailUrl),
      url: responseUrl,
    }];
  }

  /**
   * Parse search results from HTML
   */
  private parseSearchResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const elements = doc.querySelectorAll('div#book_list > div.item');

    elements.forEach((element) => {
      const linkEl = element.querySelector('div.text > h3 > a');
      const imgEl = element.querySelector('img');

      if (linkEl) {
        const href = linkEl.getAttribute('href') || '';
        const title = linkEl.textContent?.trim() || '';
        const thumbnailUrl = imgEl?.getAttribute('src') || '';
        const slug = this.extractSlugFromUrl(href);

        if (title && slug) {
          results.push({
            slug,
            title,
            thumbnailUrl: this.absoluteUrl(thumbnailUrl),
            url: href.startsWith('http') ? href : `${this.baseUrl}${href}`,
          });
        }
      }
    });

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MANGA DETAILS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get manga details
   */
  async getMangaDetails(slug: string): Promise<MangaDetails> {
    const url = `${this.baseUrl}/manga/${slug}`;

    try {
      const response = await this.fetchHtml(url);

      if (!response.ok) {
        throw new SourceError(
          `Failed to fetch manga: ${response.status}`,
          this.id,
          response.status === 404 ? 'NOT_FOUND' : 'NETWORK'
        );
      }

      const html = await response.text();
      return this.parseMangaDetails(html, slug);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(
        `Failed to fetch manga: ${(error as Error).message}`,
        this.id,
        'NETWORK'
      );
    }
  }

  /**
   * Parse manga details from HTML
   */
  private parseMangaDetails(html: string, slug: string): MangaDetails {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const title = doc.querySelector('h1.heading')?.textContent?.trim() || 'Unknown';
    const thumbnailUrl = doc.querySelector('div.media div.cover img')?.getAttribute('src') || '';

    // Author(s)
    const authorEls = doc.querySelectorAll('.author');
    const author = Array.from(authorEls).map(el => el.textContent?.trim() || '').filter(Boolean).join(', ');

    // Description + alt names
    const description = doc.querySelector('.summary > p')?.textContent?.trim() || '';
    const altName = doc.querySelector('.alt_name')?.textContent?.trim() || '';
    const fullDescription = altName
      ? `${description}\n\nAlt name(s): ${altName}`
      : description;

    // Status
    const statusText = doc.querySelector('.value.status')?.textContent?.trim() || '';
    const status = this.parseStatus(statusText);

    // Genres
    const genres: string[] = [];
    doc.querySelectorAll('.genres > a').forEach((el) => {
      const genre = el.textContent?.trim();
      if (genre) genres.push(genre);
    });

    return {
      slug,
      title,
      description: fullDescription,
      author,
      artist: '',
      status,
      genres,
      thumbnailUrl: this.absoluteUrl(thumbnailUrl),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get chapter list for a manga
   */
  async getChapterList(slug: string): Promise<Chapter[]> {
    // Chapters are on the manga detail page itself
    const url = `${this.baseUrl}/manga/${slug}`;

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
      return this.parseChapterList(html, slug);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(
        `Failed to fetch chapters: ${(error as Error).message}`,
        this.id,
        'NETWORK'
      );
    }
  }

  /**
   * Parse chapter list from HTML
   */
  private parseChapterList(html: string, mangaSlug: string): Chapter[] {
    const chapters: Chapter[] = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Selector from Kotlin reference: tr:has(.chapter)
    const rows = doc.querySelectorAll('tr:has(.chapter)');

    rows.forEach((row) => {
      const linkEl = row.querySelector('a');
      const dateEl = row.querySelector('.update_time');

      if (linkEl) {
        const href = linkEl.getAttribute('href') || '';
        const name = linkEl.textContent?.trim() || '';
        const dateText = dateEl?.textContent?.trim() || '';

        // Extract chapter slug — the part after the manga slug in the URL
        // e.g., /manga/solo-leveling/c1 → c1
        const chapterSlug = this.extractChapterSlug(href, mangaSlug);

        // Parse chapter number from name (e.g., "Chapter 150" → 150)
        const numberMatch = name.match(/chapter\s+(\d+(?:\.\d+)?)/i);
        const chapterNumber = numberMatch ? parseFloat(numberMatch[1]) : 0;

        const dateUpload = this.parseDate(dateText);

        chapters.push({
          slug: chapterSlug,
          number: chapterNumber,
          title: name,
          dateUpload,
          isPremium: false,
        });
      }
    });

    // Sort by chapter number descending (newest first)
    chapters.sort((a, b) => b.number - a.number);

    return chapters;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER PAGES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get page images for a chapter
   */
  async getChapterPages(mangaSlug: string, chapterSlug: string): Promise<PageInfo[]> {
    const url = `${this.baseUrl}/manga/${mangaSlug}/${chapterSlug}`;

    console.log(`[MangaKatana] getChapterPages - mangaSlug: "${mangaSlug}", chapterSlug: "${chapterSlug}", url: "${url}"`);

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
      return this.parseChapterPages(html);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(
        `Failed to fetch pages: ${(error as Error).message}`,
        this.id,
        'NETWORK'
      );
    }
  }

  /**
   * Parse chapter pages from HTML
   *
   * MangaKatana embeds page images in JavaScript arrays inside <script> tags.
   * Algorithm from Kotlin reference:
   *   1. Find <script> containing 'data-src'
   *   2. Extract array variable name: data-src['"],\s*(\w+)
   *   3. Find array definition: var {name}=[...]
   *   4. Extract individual URLs: '([^']*)'
   */
  private parseChapterPages(html: string): PageInfo[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Step 1: Find script element containing 'data-src'
    let imageScript = '';
    doc.querySelectorAll('script').forEach(script => {
      if (script.textContent?.includes('data-src')) {
        imageScript = script.textContent;
      }
    });

    if (!imageScript) {
      console.warn('[MangaKatana] No script containing data-src found');
      return [];
    }

    // Step 2: Extract the variable name that holds the image array
    // Regex from Kotlin: data-src['"],\s*(\w+)
    const arrayNameMatch = imageScript.match(/data-src['"]\s*,\s*(\w+)/);
    if (!arrayNameMatch) {
      console.warn('[MangaKatana] Could not extract image array variable name');
      return [];
    }
    const arrayName = arrayNameMatch[1];

    // Step 3: Find the array definition: var {name}=[...]
    const arrayRegex = new RegExp(`var\\s+${arrayName}\\s*=\\s*\\[([^\\[]*)\\]`);
    const arrayMatch = imageScript.match(arrayRegex);
    if (!arrayMatch) {
      console.warn(`[MangaKatana] Could not find array definition for '${arrayName}'`);
      return [];
    }

    // Step 4: Extract individual URLs: '([^']*)'
    const urlRegex = /'([^']*)'/g;
    const pages: PageInfo[] = [];
    let urlMatch;
    while ((urlMatch = urlRegex.exec(arrayMatch[1])) !== null) {
      if (urlMatch[1]) {
        pages.push({ url: urlMatch[1] });
      }
    }

    console.log(`[MangaKatana] Found ${pages.length} pages`);
    return pages;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AVAILABILITY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a manga is available
   */
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

  /**
   * Fetch with CORS handling via background script
   */
  private fetchHtml(url: string): Promise<Response> {
    return fetchWithCors(url, this.getHeaders());
  }

  /**
   * Extract manga slug from URL
   * e.g., https://mangakatana.com/manga/solo-leveling → solo-leveling
   * e.g., /manga/solo-leveling → solo-leveling
   */
  private extractSlugFromUrl(url: string): string {
    const match = url.match(/\/manga\/([^\/]+)/);
    return match ? match[1] : url;
  }

  /**
   * Extract chapter slug from chapter URL
   * e.g., /manga/solo-leveling/c1 → c1
   * e.g., https://mangakatana.com/manga/solo-leveling/c150 → c150
   */
  private extractChapterSlug(url: string, _mangaSlug: string): string {
    // Match the last path segment after /manga/{slug}/
    const match = url.match(/\/manga\/[^\/]+\/(.+)/);
    if (match) {
      return match[1];
    }
    // Fallback: last path segment
    const parts = url.split('/').filter(Boolean);
    return parts[parts.length - 1] || url;
  }

  /**
   * Make a URL absolute if it's relative
   */
  private absoluteUrl(url: string): string {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    return `${this.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  /**
   * Parse status string
   */
  private parseStatus(status: string): string {
    if (status.includes('Ongoing')) return 'Ongoing';
    if (status.includes('Completed')) return 'Completed';
    return 'Unknown';
  }

  /**
   * Parse MangaKatana date format: MMM-dd-yyyy (e.g., "Jan-15-2024")
   */
  private parseDate(dateStr: string): number {
    try {
      const parts = dateStr.split('-');
      if (parts.length !== 3) return 0;

      const monthStr = parts[0];
      const day = parseInt(parts[1]);
      const year = parseInt(parts[2]);

      const months: Record<string, number> = {
        'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
        'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11,
      };

      const month = months[monthStr];
      if (month === undefined || isNaN(day) || isNaN(year)) return 0;

      return new Date(year, month, day).getTime();
    } catch {
      return 0;
    }
  }
}

// Export singleton instance
export const mangaKatana = new MangaKatana();
